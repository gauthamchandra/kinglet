/**
 * Business rules for AlloyDB users. No HTTP concerns live here.
 *
 * <p><b>IMPORTANT:</b> users are the one AlloyDB resource whose mutations are
 * <i>not</i> long-running. The discovery document declares `users.create` and
 * `users.patch` as returning `User` and `users.delete` as returning `Empty`,
 * while every cluster and instance mutation returns `Operation`. This service
 * therefore takes no {@link OperationsStore} at all — wrapping these in an LRO
 * would break any real client.
 *
 * <p>Passwords are stored for data-plane authentication but never returned:
 * `User.password` is input-only in the discovery document. A user is a
 * Postgres role on every instance in the cluster.
 */

import {
  type DataPlaneLogin,
  DisabledDataPlane,
  type PostgresDataPlane,
  RoleAlreadyExistsError,
} from '@/shared/postgres-data-plane/data-plane-manager.ts';
import { isReservedCloudSqlRole } from '@/shared/postgres-data-plane/postgres-server-data-plane.ts';
import type { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import type { ClusterRepository } from './cluster-repository.ts';
import type { InstanceRepository } from './instance-repository.ts';
import type { UserRecord, UserResponse } from './types.ts';
import {
  AlloyDbError,
  alloydbDataPlaneLogin,
  buildClusterName,
  buildDataPlaneInstanceKey,
  buildUserName,
  InstanceType,
  isValidUserId,
  MUTABLE_USER_FIELDS,
  normalizeEnum,
  normalizeSpecFieldValue,
  parseInstanceName,
  parseSpecJson,
  USER_SPEC_ENUM_FIELDS,
  USER_TYPE_ENUM,
  UserType,
  userRecordToResponse,
  userRequestToRecord,
} from './types.ts';
import { resolveMaskedFields } from './update-mask.ts';
import type { UserRepository } from './user-repository.ts';

const USER_TYPES: ReadonlySet<string> = new Set(Object.values(UserType));

export interface ValidatableOptions {
  validateOnly?: boolean | undefined;
}

export interface UpdateUserOptions extends ValidatableOptions {
  updateMask?: string | undefined;
  allowMissing?: boolean | undefined;
}

export interface ListUsersResponse {
  users: UserResponse[];
  nextPageToken?: string | undefined;
}

export class UserService {
  private readonly users: UserRepository;
  private readonly clusters: ClusterRepository;
  private readonly clusterMutex: ResourceMutex;
  private readonly dataPlane: PostgresDataPlane;
  private readonly instances: InstanceRepository | undefined;

  constructor(
    users: UserRepository,
    clusters: ClusterRepository,
    clusterMutex: ResourceMutex,
    dataPlane: PostgresDataPlane = new DisabledDataPlane(),
    instances?: InstanceRepository
  ) {
    this.users = users;
    this.clusters = clusters;
    this.clusterMutex = clusterMutex;
    this.dataPlane = dataPlane;
    this.instances = instances;
  }

  async createUser(
    project: string,
    location: string,
    clusterId: string,
    userId: string,
    body: Record<string, unknown>,
    options: ValidatableOptions
  ): Promise<UserResponse> {
    validateUserId(userId);
    validateUserType(body.userType);

    return this.clusterMutex.runExclusively(buildClusterName(project, location, clusterId), () =>
      this.createUserExclusively(project, location, clusterId, userId, body, options)
    );
  }

  private async createUserExclusively(
    project: string,
    location: string,
    clusterId: string,
    userId: string,
    body: Record<string, unknown>,
    options: ValidatableOptions
  ): Promise<UserResponse> {
    // Re-checked inside the lock shared with the cluster's delete cascade, so a
    // concurrent cluster delete cannot remove the parent between this check and
    // the write and leave the user orphaned beneath a cluster that is gone.
    await this.requireCluster(project, location, clusterId);

    const name = buildUserName(project, location, clusterId, userId);

    if (await this.users.getByName(name)) {
      throw new AlloyDbError('ALREADY_EXISTS', `User ${name} already exists`, name);
    }

    const record = userRequestToRecord(name, body);

    if (options.validateOnly === true) {
      return userRecordToResponse(record);
    }

    const created = await this.users.create(record);

    try {
      await this.applyUserToAllInstances(project, location, clusterId, userId, record.password);
    } catch (error) {
      await this.users.delete(name);

      if (error instanceof RoleAlreadyExistsError) {
        throw new AlloyDbError('ALREADY_EXISTS', `Role ${userId} already exists`, name);
      }

      throw new AlloyDbError(
        'INTERNAL',
        `Failed to create user ${name} on the data plane: ${
          error instanceof Error ? error.message : String(error)
        }`,
        name
      );
    }

    return userRecordToResponse(created);
  }

  async getUser(
    project: string,
    location: string,
    clusterId: string,
    userId: string
  ): Promise<UserResponse> {
    return userRecordToResponse(
      await this.getUserOrThrow(buildUserName(project, location, clusterId, userId))
    );
  }

  async listUsers(
    project: string,
    location: string,
    clusterId: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListUsersResponse> {
    await this.requireCluster(project, location, clusterId);

    const result = await this.users.listUsers(project, location, clusterId, pageSize, pageToken);

    return {
      users: result.users.map(userRecordToResponse),
      nextPageToken: result.nextPageToken,
    };
  }

  async updateUser(
    project: string,
    location: string,
    clusterId: string,
    userId: string,
    body: Record<string, unknown>,
    options: UpdateUserOptions
  ): Promise<UserResponse> {
    return this.clusterMutex.runExclusively(buildClusterName(project, location, clusterId), () =>
      this.updateUserExclusively(project, location, clusterId, userId, body, options)
    );
  }

  private async updateUserExclusively(
    project: string,
    location: string,
    clusterId: string,
    userId: string,
    body: Record<string, unknown>,
    options: UpdateUserOptions
  ): Promise<UserResponse> {
    const name = buildUserName(project, location, clusterId, userId);
    // Read inside the lock, or a concurrent PATCH's field is silently reverted by
    // this one's whole-spec rewrite of a stale snapshot.
    const existing = await this.users.getByName(name);

    if (!existing) {
      if (options.allowMissing !== true) {
        throw new AlloyDbError('NOT_FOUND', `User ${name} not found`, name);
      }

      // Already under the cluster lock; run the create body directly with the same
      // validations createUser applies, rather than re-entering it and deadlocking.
      validateUserId(userId);
      validateUserType(body.userType);

      return this.createUserExclusively(project, location, clusterId, userId, body, options);
    }

    const updates = buildUserUpdates(existing, body, options.updateMask);

    if (options.validateOnly === true) {
      return userRecordToResponse({ ...existing, ...updates });
    }

    const applied = await this.users.update(name, updates);

    if (!applied) {
      throw new AlloyDbError('NOT_FOUND', `User ${name} not found`, name);
    }

    if (updates.password !== undefined) {
      try {
        await this.applyUserToAllInstances(
          project,
          location,
          clusterId,
          userId,
          updates.password,
          alloydbDataPlaneLogin(userId, existing.password)
        );
      } catch (error) {
        await this.users.update(name, revertUserUpdates(existing, updates));

        throw new AlloyDbError(
          'INTERNAL',
          `Failed to update user ${name} on the data plane: ${
            error instanceof Error ? error.message : String(error)
          }`,
          name
        );
      }
    }

    return userRecordToResponse(applied);
  }

  async deleteUser(
    project: string,
    location: string,
    clusterId: string,
    userId: string,
    options: ValidatableOptions
  ): Promise<void> {
    return this.clusterMutex.runExclusively(buildClusterName(project, location, clusterId), () =>
      this.deleteUserExclusively(project, location, clusterId, userId, options)
    );
  }

  private async deleteUserExclusively(
    project: string,
    location: string,
    clusterId: string,
    userId: string,
    options: ValidatableOptions
  ): Promise<void> {
    const name = buildUserName(project, location, clusterId, userId);
    const existing = await this.getUserOrThrow(name);

    if (options.validateOnly === true) return;

    await this.users.delete(name);

    try {
      await this.dropUserFromAllInstances(
        project,
        location,
        clusterId,
        userId,
        alloydbDataPlaneLogin(userId, existing.password)
      );
    } catch (error) {
      const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...restored } = existing;

      await this.users.create(restored);

      throw new AlloyDbError(
        'INTERNAL',
        `Failed to drop user ${name} from the data plane: ${
          error instanceof Error ? error.message : String(error)
        }`,
        name
      );
    }
  }

  private async getUserOrThrow(name: string): Promise<UserRecord> {
    const record = await this.users.getByName(name);

    if (!record) {
      throw new AlloyDbError('NOT_FOUND', `User ${name} not found`, name);
    }

    return record;
  }

  /**
   * Upsert the role for `userId` on every PRIMARY instance currently running in
   * the cluster. READ_POOL instances are streaming standbys — roles arrive through
   * WAL replication from the primary, so issuing DDL on them directly would fail
   * and is unnecessary. No-op when no instance repository is wired.
   */
  private async applyUserToAllInstances(
    project: string,
    location: string,
    clusterId: string,
    userId: string,
    password: string,
    previous: DataPlaneLogin | null = null
  ): Promise<void> {
    if (!this.instances) return;

    const clusterInstances = await this.instances.listAllInstancesInCluster(
      project,
      location,
      clusterId
    );
    const applied: string[] = [];

    try {
      for (const instance of clusterInstances) {
        if (instance.instanceType === InstanceType.READ_POOL) continue;

        const parsed = parseInstanceName(instance.name);

        if (!parsed) continue;

        const key = buildDataPlaneInstanceKey(parsed.location, parsed.clusterId, parsed.instanceId);

        await this.dataPlane.upsertUser(
          project,
          key,
          alloydbDataPlaneLogin(userId, password),
          previous == null ? { createOnly: true } : undefined
        );
        applied.push(key);
      }
    } catch (error) {
      await this.undoUserChanges(project, userId, applied, previous, error);

      throw error;
    }
  }

  /**
   * Drop the role for `userId` from every PRIMARY instance currently running in
   * the cluster. READ_POOL instances are streaming standbys — the drop propagates
   * via WAL replication and issuing DDL directly on them would fail. No-op when
   * no instance repository is wired.
   */
  private async dropUserFromAllInstances(
    project: string,
    location: string,
    clusterId: string,
    userId: string,
    previous: DataPlaneLogin
  ): Promise<void> {
    if (!this.instances) return;

    const clusterInstances = await this.instances.listAllInstancesInCluster(
      project,
      location,
      clusterId
    );
    const dropped: string[] = [];

    try {
      for (const instance of clusterInstances) {
        if (instance.instanceType === InstanceType.READ_POOL) continue;

        const parsed = parseInstanceName(instance.name);

        if (!parsed) continue;

        const key = buildDataPlaneInstanceKey(parsed.location, parsed.clusterId, parsed.instanceId);

        await this.dataPlane.dropUser(project, key, userId);
        dropped.push(key);
      }
    } catch (error) {
      await this.undoUserChanges(project, userId, dropped, previous, error);

      throw error;
    }
  }

  /**
   * Put the instances that already changed back to `previous`. A create has no
   * previous role, so those instances drop the role that was just created.
   */
  private async undoUserChanges(
    project: string,
    userId: string,
    keys: string[],
    previous: DataPlaneLogin | null,
    cause: unknown
  ): Promise<void> {
    const failures: string[] = [];

    for (const key of keys) {
      try {
        if (previous == null) {
          await this.dataPlane.dropUser(project, key, userId);
        } else {
          await this.dataPlane.upsertUser(project, key, previous);
        }
      } catch (error) {
        failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (failures.length > 0) {
      const message = cause instanceof Error ? cause.message : String(cause);

      throw new Error(`${message}; undo failed: ${failures.join('; ')}`);
    }
  }

  private async requireCluster(
    project: string,
    location: string,
    clusterId: string
  ): Promise<void> {
    const clusterName = buildClusterName(project, location, clusterId);

    if (await this.clusters.getByName(clusterName)) return;

    throw new AlloyDbError('NOT_FOUND', `Cluster ${clusterName} not found`, clusterName, 'Cluster');
  }
}

/** Throwing wrapper over {@link isValidUserId}. */
function validateUserId(userId: string): void {
  if (userId.length === 0 || userId.includes('/')) {
    throw new AlloyDbError(
      'INVALID_ARGUMENT',
      `User ID "${userId}" must be non-empty and must not contain "/"`
    );
  }

  if (!isValidUserId(userId)) {
    throw new AlloyDbError(
      'INVALID_ARGUMENT',
      `User ID "${userId}" must be at most 63 bytes, the PostgreSQL identifier limit`
    );
  }

  if (isReservedCloudSqlRole(userId)) {
    throw new AlloyDbError('INVALID_ARGUMENT', `User ID "${userId}" is reserved`);
  }
}

/** Normalized before validating — see {@link normalizeEnum}. */
function validateUserType(userType: unknown): void {
  if (userType === undefined) return;

  if (USER_TYPES.has(String(normalizeEnum(userType, USER_TYPE_ENUM)))) return;

  throw new AlloyDbError(
    'INVALID_ARGUMENT',
    `User.userType "${String(userType)}" must be one of ${[...USER_TYPES].join(', ')}`
  );
}

function revertUserUpdates(
  existing: UserRecord,
  updates: Partial<Pick<UserRecord, 'userType' | 'password' | 'spec'>>
): Partial<Pick<UserRecord, 'userType' | 'password' | 'spec'>> {
  const reverted: Partial<Pick<UserRecord, 'userType' | 'password' | 'spec'>> = {};

  if (updates.userType !== undefined) reverted.userType = existing.userType;

  if (updates.password !== undefined) reverted.password = existing.password;

  if (updates.spec !== undefined) reverted.spec = existing.spec;

  return reverted;
}

function buildUserUpdates(
  existing: UserRecord,
  body: Record<string, unknown>,
  updateMask?: string
): Partial<Pick<UserRecord, 'userType' | 'password' | 'spec'>> {
  const maskedFields = resolveMaskedFields(body, MUTABLE_USER_FIELDS, updateMask);
  const spec = parseSpecJson(existing.spec);
  const updates: Partial<Pick<UserRecord, 'userType' | 'password' | 'spec'>> = {};

  for (const field of maskedFields) {
    // userType is a required column, so a masked clear cannot null it: an absent
    // value preserves the existing type rather than resetting it.
    if (field === 'userType') {
      if (!('userType' in body)) continue;

      validateUserType(body.userType);

      const normalized = normalizeEnum(body.userType, USER_TYPE_ENUM);

      updates.userType = typeof normalized === 'string' ? normalized : existing.userType;
      continue;
    }

    // Password is input-only in responses but must be stored for data-plane auth.
    // Only written when the body actually carries one: an empty stored password
    // means the wire server accepts the user without one, so letting a mask that
    // names `password` without supplying it clear the secret would turn an
    // authenticated instance into an open one. Cloud SQL's admin service takes
    // the same position (see SqlAdminService.updateUser).
    if (field === 'password') {
      if (typeof body.password === 'string') updates.password = body.password;

      continue;
    }

    // `keepExtraRoles` is input-only and unused without real Postgres roles.
    if (field === 'keepExtraRoles') continue;

    if (field in body) {
      spec[field] = normalizeSpecFieldValue(field, body[field], USER_SPEC_ENUM_FIELDS);
    } else {
      delete spec[field];
    }
  }

  updates.spec = JSON.stringify(spec);

  return updates;
}
