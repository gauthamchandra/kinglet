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
 * <p><b>NOTE:</b> users are metadata only in this release. Once the data plane
 * lands they become real Postgres roles (see the PR 2 plan); until then nothing
 * is granted anywhere, and `password` is discarded rather than stored.
 */

import type { ClusterRepository } from './cluster-repository.ts';
import type { UserRecord, UserResponse } from './types.ts';
import {
  AlloyDbError,
  buildClusterName,
  buildUserName,
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

  constructor(users: UserRepository, clusters: ClusterRepository) {
    this.users = users;
    this.clusters = clusters;
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
    const name = buildUserName(project, location, clusterId, userId);
    const existing = await this.users.getByName(name);

    if (!existing) {
      if (options.allowMissing !== true) {
        throw new AlloyDbError('NOT_FOUND', `User ${name} not found`, name);
      }

      return this.createUser(project, location, clusterId, userId, body, options);
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

/**
 * The discovery document gives user ids no pattern — they become PostgreSQL role
 * names, which are permissive — so validation is limited to what would genuinely
 * break: an empty id, or one containing the separator that delimits resource
 * names.
 */
function validateUserId(userId: string): void {
  if (userId.length > 0 && !userId.includes('/')) return;

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
): Partial<Pick<UserRecord, 'userType' | 'spec'>> {
  const maskedFields = resolveMaskedFields(body, MUTABLE_USER_FIELDS, updateMask);
  const spec = parseSpecJson(existing.spec);
  const updates: Partial<Pick<UserRecord, 'userType' | 'spec'>> = {};

  for (const field of maskedFields) {
    if (field === 'userType') {
      validateUserType(body.userType);

      const normalized = normalizeEnum(body.userType, USER_TYPE_ENUM);

      updates.userType = typeof normalized === 'string' ? normalized : existing.userType;
      continue;
    }

    // `password` and `keepExtraRoles` are input-only: accepted, never stored.
    if (field === 'password' || field === 'keepExtraRoles') continue;

    if (field in body) {
      spec[field] = normalizeSpecFieldValue(field, body[field], USER_SPEC_ENUM_FIELDS);
    } else {
      delete spec[field];
    }
  }

  updates.spec = JSON.stringify(spec);

  return updates;
}
