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
 * <p>Passwords are stored for data-plane authentication (ADR-013) but never
 * returned: `User.password` is input-only in the discovery document. Emulated
 * users gate connections; they are not Postgres roles.
 */

import type { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import type { ClusterRepository } from './cluster-repository.ts';
import type { UserRecord, UserResponse } from './types.ts';
import {
  AlloyDbError,
  buildClusterName,
  buildUserName,
  isValidUserId,
  MUTABLE_USER_FIELDS,
  normalizeEnum,
  normalizeSpecFieldValue,
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

  constructor(users: UserRepository, clusters: ClusterRepository, clusterMutex: ResourceMutex) {
    this.users = users;
    this.clusters = clusters;
    this.clusterMutex = clusterMutex;
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

    return userRecordToResponse(await this.users.create(record));
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

    await this.getUserOrThrow(name);

    if (options.validateOnly === true) return;

    await this.users.delete(name);
  }

  private async getUserOrThrow(name: string): Promise<UserRecord> {
    const record = await this.users.getByName(name);

    if (!record) {
      throw new AlloyDbError('NOT_FOUND', `User ${name} not found`, name);
    }

    return record;
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
  if (isValidUserId(userId)) return;

  throw new AlloyDbError(
    'INVALID_ARGUMENT',
    `User ID "${userId}" must be non-empty and must not contain "/"`
  );
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
