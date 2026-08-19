/**
 * AlloyDB for PostgreSQL data models, schemas, and helper functions.
 *
 * <p>Specification: `https://alloydb.googleapis.com/$discovery/rest?version=v1`
 * (revision 20260805), registered in `discovery-document-registry.json`.
 *
 * <p><b>NOTE:</b> Writable fields the emulator has no behaviour for are stored
 * verbatim in a `spec` JSON column rather than given one column each. Cluster
 * alone has 37 fields, and a client that PATCHes a field this emulator does not
 * model should still read it back unchanged rather than have it silently
 * dropped. Output-only fields get real columns because the emulator owns them.
 */

import type { RouteResponse } from '@/core/gateway/request-router.ts';
import type { ResponseUtils } from '@/core/gateway/response-handlers.ts';
import type { BaseRecord, TableSchema } from '@/core/storage/types.ts';

// ── Table Constants ──

export const ALLOYDB_CLUSTERS_TABLE = 'alloydb_clusters';
export const ALLOYDB_INSTANCES_TABLE = 'alloydb_instances';
export const ALLOYDB_USERS_TABLE = 'alloydb_users';
export const ALLOYDB_OPERATIONS_TABLE = 'alloydb_operations';

// ── Enumerations ──

export const ClusterState = {
  READY: 'READY',
} as const;

export const ClusterType = {
  PRIMARY: 'PRIMARY',
} as const;

export const InstanceState = {
  READY: 'READY',
} as const;

export const InstanceType = {
  PRIMARY: 'PRIMARY',
  READ_POOL: 'READ_POOL',
  SECONDARY: 'SECONDARY',
} as const;

export const UserType = {
  ALLOYDB_BUILT_IN: 'ALLOYDB_BUILT_IN',
  ALLOYDB_IAM_USER: 'ALLOYDB_IAM_USER',
} as const;

/**
 * The discovery document does not state which version an omitted
 * `databaseVersion` resolves to, so this is the emulator's choice rather than an
 * observed default. Called out in the PR per the fidelity contract.
 */
const DEFAULT_DATABASE_VERSION = 'POSTGRES_15';

// ── Protobuf Enum Mapping ──

/**
 * Proto enum numbers to their names, taken from the shipped
 * `@google-cloud/alloydb` protos rather than the discovery document's `enum`
 * arrays — those are declaration-order lists, not wire numbers, and
 * `Instance.State` alone skips 7.
 *
 * <p><b>IMPORTANT:</b> this exists because google-gax's REST fallback serializes
 * enums as <i>numbers</i>, so the official client sends `instanceType: 1` where
 * a hand-written `curl` sends `"PRIMARY"`. Real GCP accepts both (proto3 JSON
 * mapping), so the emulator must too — an e2e run against the real client is what
 * surfaced this. Mirrors `normalizeHttpMethod` in the Scheduler service.
 */
type EnumNumberMap = Readonly<Record<number, string>>;

export const INSTANCE_TYPE_ENUM: EnumNumberMap = {
  0: 'INSTANCE_TYPE_UNSPECIFIED',
  1: 'PRIMARY',
  2: 'READ_POOL',
  3: 'SECONDARY',
};

export const USER_TYPE_ENUM: EnumNumberMap = {
  0: 'USER_TYPE_UNSPECIFIED',
  1: 'ALLOYDB_BUILT_IN',
  2: 'ALLOYDB_IAM_USER',
};

const DATABASE_VERSION_ENUM: EnumNumberMap = {
  0: 'DATABASE_VERSION_UNSPECIFIED',
  1: 'POSTGRES_13',
  2: 'POSTGRES_14',
  3: 'POSTGRES_15',
  4: 'POSTGRES_16',
  5: 'POSTGRES_17',
  6: 'POSTGRES_18',
};

const SUBSCRIPTION_TYPE_ENUM: EnumNumberMap = {
  0: 'SUBSCRIPTION_TYPE_UNSPECIFIED',
  1: 'STANDARD',
  2: 'TRIAL',
};

const AVAILABILITY_TYPE_ENUM: EnumNumberMap = {
  0: 'AVAILABILITY_TYPE_UNSPECIFIED',
  1: 'ZONAL',
  2: 'REGIONAL',
};

const ACTIVATION_POLICY_ENUM: EnumNumberMap = {
  0: 'ACTIVATION_POLICY_UNSPECIFIED',
  1: 'ALWAYS',
  2: 'NEVER',
};

/**
 * Top-level enum fields normalized on the way in.
 *
 * <p><b>LIMITATION:</b> enums nested inside sub-messages
 * (`automatedBackupPolicy`, `sslConfig`, …) are round-tripped verbatim, so a
 * REST-fallback client that sets one reads a number back rather than its name.
 * Normalizing those would mean walking the whole proto schema; noted in the
 * README instead.
 */
const CLUSTER_ENUM_FIELDS: Readonly<Record<string, EnumNumberMap>> = {
  databaseVersion: DATABASE_VERSION_ENUM,
  subscriptionType: SUBSCRIPTION_TYPE_ENUM,
};

const INSTANCE_ENUM_FIELDS: Readonly<Record<string, EnumNumberMap>> = {
  instanceType: INSTANCE_TYPE_ENUM,
  availabilityType: AVAILABILITY_TYPE_ENUM,
  activationPolicy: ACTIVATION_POLICY_ENUM,
};

const USER_ENUM_FIELDS: Readonly<Record<string, EnumNumberMap>> = {
  userType: USER_TYPE_ENUM,
};

/**
 * Resolve an enum that may arrive as its name, its wire number, or a numeric
 * string. An unrecognized value is returned untouched so the caller's validation
 * can report what the client actually sent.
 */
export function normalizeEnum(value: unknown, byNumber: EnumNumberMap): unknown {
  if (typeof value === 'number') return byNumber[value] ?? value;

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return byNumber[Number(value)] ?? value;
  }

  return value;
}

/**
 * The address reported by `Instance.ipAddress` and `ConnectionInfo.ipAddress`.
 *
 * <p>Deliberately loopback rather than a plausible `10.x` private IP: this
 * release has no data plane, so nothing is listening. A realistic-looking
 * private address would invite someone to try connecting to it.
 */
const PLACEHOLDER_IP_ADDRESS = '127.0.0.1';

// ── Error Class ──

export type AlloyDbErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_ARGUMENT'
  | 'FAILED_PRECONDITION'
  | 'ABORTED';

export class AlloyDbError extends Error {
  readonly code: AlloyDbErrorCode;
  readonly resourceName: string | undefined;
  readonly resourceType: string | undefined;

  /**
   * @param resourceType the resource this error is about, when it differs from
   *     the one its route is named for. Handlers pass {@link handleAlloyDbError}
   *     the route's primary resource, which is right for the parent lookup but
   *     wrong for a sub-resource conflict raised by the same call — a
   *     `users.create` reporting a missing parent `Cluster`, for one.
   */
  constructor(
    code: AlloyDbErrorCode,
    message: string,
    resourceName?: string,
    resourceType?: string
  ) {
    super(message);
    this.name = 'AlloyDbError';
    this.code = code;
    this.resourceName = resourceName;
    this.resourceType = resourceType;
  }
}

export function handleAlloyDbError(
  err: unknown,
  resourceType: string,
  responseUtils: ResponseUtils
): RouteResponse {
  if (err instanceof AlloyDbError) {
    const reportedResourceType = err.resourceType ?? resourceType;

    switch (err.code) {
      case 'NOT_FOUND':
        return responseUtils.notFound(reportedResourceType, err.resourceName);
      case 'ALREADY_EXISTS':
        return responseUtils.alreadyExists(
          reportedResourceType,
          err.resourceName ?? reportedResourceType
        );
      case 'INVALID_ARGUMENT':
        return responseUtils.badRequest(err.message);
      case 'FAILED_PRECONDITION':
        return responseUtils.failedPrecondition(err.message);
      case 'ABORTED':
        return responseUtils.aborted(err.message);
    }
  }

  return responseUtils.internalError(err instanceof Error ? err.message : 'Internal server error');
}

// ── Resource Names ──

export function buildClusterName(project: string, location: string, clusterId: string): string {
  return `projects/${project}/locations/${location}/clusters/${clusterId}`;
}

export function buildInstanceName(
  project: string,
  location: string,
  clusterId: string,
  instanceId: string
): string {
  return `${buildClusterName(project, location, clusterId)}/instances/${instanceId}`;
}

/**
 * Build a User resource name.
 *
 * <p><b>NOTE:</b> the discovery document's `User.name` *description* spells the
 * segment `cluster` (singular), but the `name` parameter pattern
 * (`^projects/[^/]+/locations/[^/]+/clusters/[^/]+/users/[^/]+$`) and every
 * `flatPath` spell it `clusters`. The pattern wins — a singular segment would
 * 404 against the real API.
 */
export function buildUserName(
  project: string,
  location: string,
  clusterId: string,
  userId: string
): string {
  return `${buildClusterName(project, location, clusterId)}/users/${userId}`;
}

/** The singleton sub-resource segment appended to an instance name. */
const CONNECTION_INFO_SUFFIX = '/connectionInfo';

export function buildConnectionInfoName(
  project: string,
  location: string,
  clusterId: string,
  instanceId: string
): string {
  return `${buildInstanceName(project, location, clusterId, instanceId)}${CONNECTION_INFO_SUFFIX}`;
}

// ── Resource ID Validation ──

/**
 * The discovery document constrains a cluster ID to `[a-z0-9-]+` with no length
 * bound, while the instance ID regex caps at 63. The same cap is applied here as
 * the conservative reading — AIP-122 bounds both, and a resource kinglet accepts
 * but real AlloyDB rejects is the failure mode this project exists to prevent.
 */
const CLUSTER_ID_PATTERN = /^[a-z0-9-]{1,63}$/;

const INSTANCE_ID_PATTERN = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * <p>Rejecting uppercase is fidelity, not taste: the discovery document's regex
 * admits lowercase only, so real AlloyDB refuses the id. An emulator that accepts
 * what production rejects is the exact failure this project exists to prevent —
 * the resource works locally and the deploy fails.
 */
export function isValidClusterId(clusterId: string): boolean {
  return CLUSTER_ID_PATTERN.test(clusterId);
}

export function isValidInstanceId(instanceId: string): boolean {
  return INSTANCE_ID_PATTERN.test(instanceId);
}

// ── Mutable Field Sets ──

/**
 * The complement of the discovery document's `readOnly` flags. A PATCH whose
 * `updateMask` names a field outside these sets must fail with
 * `INVALID_ARGUMENT` rather than silently no-op.
 */
export const MUTABLE_CLUSTER_FIELDS: ReadonlySet<string> = new Set([
  'annotations',
  'automatedBackupPolicy',
  'continuousBackupConfig',
  'databaseVersion',
  'dataplexConfig',
  'displayName',
  'encryptionConfig',
  'etag',
  'initialUser',
  'labels',
  'maintenanceUpdatePolicy',
  'maintenanceVersionSelectionPolicy',
  'network',
  'networkConfig',
  'pscConfig',
  'secondaryConfig',
  'sslConfig',
  'subscriptionType',
  'tags',
]);

export const MUTABLE_INSTANCE_FIELDS: ReadonlySet<string> = new Set([
  'activationPolicy',
  'annotations',
  'availabilityType',
  'clientConnectionConfig',
  'connectionPoolConfig',
  'dataApiAccess',
  'databaseFlags',
  'displayName',
  'etag',
  'gceZone',
  'instanceType',
  'labels',
  'machineConfig',
  'networkConfig',
  'observabilityConfig',
  'pscInstanceConfig',
  'queryInsightsConfig',
  'readPoolConfig',
]);

export const MUTABLE_USER_FIELDS: ReadonlySet<string> = new Set([
  'databaseRoles',
  'keepExtraRoles',
  'password',
  'userType',
]);

/**
 * Writable fields the emulator keeps in a real column, so they must not also be
 * mirrored into `spec` — two homes for one field is two chances to disagree.
 * `initialUser` is here because only its username is persisted, never the
 * password it carries.
 */
const COLUMNED_CLUSTER_FIELDS: ReadonlySet<string> = new Set(['initialUser']);
const COLUMNED_INSTANCE_FIELDS: ReadonlySet<string> = new Set(['instanceType']);

/**
 * `password` and `keepExtraRoles` are input-only in the discovery document, so
 * they are dropped rather than stored — the emulator must never be able to
 * return a password it was handed.
 */
const COLUMNED_USER_FIELDS: ReadonlySet<string> = new Set([
  'userType',
  'password',
  'keepExtraRoles',
]);

// ── Storage Records ──

export interface ClusterRecord extends BaseRecord {
  name: string;
  uid: string;
  state: string;
  clusterType: string;
  initialUserName: string | null;
  reconciling: number; // SQLite boolean (0/1)
  createTime: string;
  updateTime: string;
  deleteTime: string | null;
  spec: string; // JSON-serialized writable fields without a column of their own
}

export interface InstanceRecord extends BaseRecord {
  name: string;
  uid: string;
  state: string;
  instanceType: string;
  reconciling: number; // SQLite boolean (0/1)
  createTime: string;
  updateTime: string;
  deleteTime: string | null;
  spec: string; // JSON-serialized writable fields without a column of their own
}

export interface UserRecord extends BaseRecord {
  name: string;
  userType: string;
  spec: string; // JSON-serialized writable fields without a column of their own
}

// ── Responses ──

export type ClusterResponse = Record<string, unknown> & {
  name: string;
  uid: string;
  state: string;
  clusterType: string;
  reconciling: boolean;
  createTime: string;
  updateTime: string;
};

export type InstanceResponse = Record<string, unknown> & {
  name: string;
  uid: string;
  state: string;
  instanceType: string;
  ipAddress: string;
  reconciling: boolean;
  createTime: string;
  updateTime: string;
};

export type UserResponse = Record<string, unknown> & {
  name: string;
  userType: string;
};

export interface ConnectionInfo {
  name: string;
  ipAddress: string;
  instanceUid: string;
}

// ── Table Schemas ──

export const clusterTableSchema: TableSchema = {
  name: ALLOYDB_CLUSTERS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'uid', type: 'string' },
    { name: 'state', type: 'string' },
    { name: 'clusterType', type: 'string' },
    { name: 'initialUserName', type: 'string', nullable: true },
    { name: 'reconciling', type: 'number' },
    { name: 'createTime', type: 'string' },
    { name: 'updateTime', type: 'string' },
    { name: 'deleteTime', type: 'string', nullable: true },
    { name: 'spec', type: 'json' },
  ],
  indexes: [{ name: 'idx_alloydb_clusters_name', columns: ['name'], unique: true }],
  timestamps: true,
};

export const instanceTableSchema: TableSchema = {
  name: ALLOYDB_INSTANCES_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'uid', type: 'string' },
    { name: 'state', type: 'string' },
    { name: 'instanceType', type: 'string' },
    { name: 'reconciling', type: 'number' },
    { name: 'createTime', type: 'string' },
    { name: 'updateTime', type: 'string' },
    { name: 'deleteTime', type: 'string', nullable: true },
    { name: 'spec', type: 'json' },
  ],
  indexes: [{ name: 'idx_alloydb_instances_name', columns: ['name'], unique: true }],
  timestamps: true,
};

export const userTableSchema: TableSchema = {
  name: ALLOYDB_USERS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'userType', type: 'string' },
    { name: 'spec', type: 'json' },
  ],
  indexes: [{ name: 'idx_alloydb_users_name', columns: ['name'], unique: true }],
  timestamps: true,
};

// ── Conversion ──

/**
 * Read a record's `spec` column back into an object.
 *
 * <p>Tolerates null and malformed JSON by yielding `{}`: the emulator's own
 * writes are always well-formed, so a parse failure means hand-edited or
 * migrated state, and losing unmodeled decoration is better than failing a GET.
 */
export function parseSpecJson(spec: string | null): Record<string, unknown> {
  if (spec == null) return {};

  try {
    const parsed = JSON.parse(spec) as unknown;

    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Keep only the writable fields that have no column of their own.
 *
 * <p>Because the filter is an allowlist built from the discovery document's
 * `readOnly` flags, an output-only field a client supplies — a spoofed `name` or
 * `uid`, say — is discarded here rather than needing a separate guard.
 */
function pickSpecFields(
  body: Record<string, unknown>,
  mutableFields: ReadonlySet<string>,
  columnedFields: ReadonlySet<string>,
  enumFields: Readonly<Record<string, EnumNumberMap>>
): Record<string, unknown> {
  const spec: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(body)) {
    if (mutableFields.has(field) && !columnedFields.has(field)) {
      spec[field] = normalizeSpecFieldValue(field, value, enumFields);
    }
  }

  return spec;
}

/** Store an enum by name even when the client sent its wire number. */
export function normalizeSpecFieldValue(
  field: string,
  value: unknown,
  enumFields: Readonly<Record<string, EnumNumberMap>>
): unknown {
  const byNumber = enumFields[field];

  return byNumber === undefined ? value : normalizeEnum(value, byNumber);
}

export const CLUSTER_SPEC_ENUM_FIELDS = CLUSTER_ENUM_FIELDS;
export const INSTANCE_SPEC_ENUM_FIELDS = INSTANCE_ENUM_FIELDS;
export const USER_SPEC_ENUM_FIELDS = USER_ENUM_FIELDS;

/**
 * Read the username out of a `Cluster.initialUser`, ignoring the password it
 * carries. Shared with the PATCH path so the secret is dropped in exactly one
 * place.
 */
export function readInitialUsername(body: Record<string, unknown>): string | null {
  const initialUser = body.initialUser;

  if (initialUser === null || typeof initialUser !== 'object') return null;

  const user = (initialUser as Record<string, unknown>).user;

  return typeof user === 'string' && user.length > 0 ? user : null;
}

export function clusterRequestToRecord(
  name: string,
  body: Record<string, unknown>
): Omit<ClusterRecord, keyof BaseRecord> {
  const now = new Date().toISOString();
  const spec = pickSpecFields(
    body,
    MUTABLE_CLUSTER_FIELDS,
    COLUMNED_CLUSTER_FIELDS,
    CLUSTER_ENUM_FIELDS
  );

  spec.databaseVersion ??= DEFAULT_DATABASE_VERSION;

  return {
    name,
    uid: crypto.randomUUID(),
    // Operations are born done in the emulator, so a cluster is never observably
    // CREATING — it is READY by the time the caller sees the Operation.
    state: ClusterState.READY,
    clusterType: ClusterType.PRIMARY,
    initialUserName: readInitialUsername(body),
    reconciling: 0,
    createTime: now,
    updateTime: now,
    deleteTime: null,
    spec: JSON.stringify(spec),
  };
}

export function clusterRecordToResponse(
  record: Omit<ClusterRecord, keyof BaseRecord>
): ClusterResponse {
  return {
    ...parseSpecJson(record.spec),
    name: record.name,
    uid: record.uid,
    state: record.state,
    clusterType: record.clusterType,
    reconciling: record.reconciling === 1,
    createTime: record.createTime,
    updateTime: record.updateTime,
    ...(record.deleteTime == null ? {} : { deleteTime: record.deleteTime }),
  };
}

export function instanceRequestToRecord(
  name: string,
  body: Record<string, unknown>
): Omit<InstanceRecord, keyof BaseRecord> {
  const now = new Date().toISOString();
  const requestedType = normalizeEnum(body.instanceType, INSTANCE_TYPE_ENUM);

  return {
    name,
    uid: crypto.randomUUID(),
    state: InstanceState.READY,
    instanceType: typeof requestedType === 'string' ? requestedType : InstanceType.PRIMARY,
    reconciling: 0,
    createTime: now,
    updateTime: now,
    deleteTime: null,
    spec: JSON.stringify(
      pickSpecFields(body, MUTABLE_INSTANCE_FIELDS, COLUMNED_INSTANCE_FIELDS, INSTANCE_ENUM_FIELDS)
    ),
  };
}

export function instanceRecordToResponse(
  record: Omit<InstanceRecord, keyof BaseRecord>
): InstanceResponse {
  return {
    ...parseSpecJson(record.spec),
    name: record.name,
    uid: record.uid,
    state: record.state,
    instanceType: record.instanceType,
    ipAddress: PLACEHOLDER_IP_ADDRESS,
    reconciling: record.reconciling === 1,
    createTime: record.createTime,
    updateTime: record.updateTime,
    ...(record.deleteTime == null ? {} : { deleteTime: record.deleteTime }),
  };
}

export function buildConnectionInfo(
  record: Omit<InstanceRecord, keyof BaseRecord>
): ConnectionInfo {
  return {
    name: `${record.name}${CONNECTION_INFO_SUFFIX}`,
    ipAddress: PLACEHOLDER_IP_ADDRESS,
    instanceUid: record.uid,
  };
}

export function userRequestToRecord(
  name: string,
  body: Record<string, unknown>
): Omit<UserRecord, keyof BaseRecord> {
  const requestedType = normalizeEnum(body.userType, USER_TYPE_ENUM);

  return {
    name,
    userType: typeof requestedType === 'string' ? requestedType : UserType.ALLOYDB_BUILT_IN,
    spec: JSON.stringify(
      pickSpecFields(body, MUTABLE_USER_FIELDS, COLUMNED_USER_FIELDS, USER_ENUM_FIELDS)
    ),
  };
}

export function userRecordToResponse(record: Omit<UserRecord, keyof BaseRecord>): UserResponse {
  return {
    ...parseSpecJson(record.spec),
    name: record.name,
    userType: record.userType,
  };
}
