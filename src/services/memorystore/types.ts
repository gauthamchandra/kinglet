/**
 * Memorystore for Valkey data models, schemas, and helper functions
 */

import { z } from 'zod';
import type { RouteResponse } from '@/core/gateway/request-router.ts';
import type { ResponseUtils } from '@/core/gateway/response-handlers.ts';
import type { BaseRecord, TableSchema } from '@/core/storage/types.ts';

// ── Table Constants ──

export const MEMORYSTORE_INSTANCES_TABLE = 'memorystore_instances';
export const MEMORYSTORE_BACKUP_COLLECTIONS_TABLE = 'memorystore_backup_collections';
export const MEMORYSTORE_BACKUPS_TABLE = 'memorystore_backups';
export const MEMORYSTORE_ACL_POLICIES_TABLE = 'memorystore_acl_policies';
export const MEMORYSTORE_ACL_POLICY_REVISIONS_TABLE = 'memorystore_acl_policy_revisions';
export const MEMORYSTORE_TOKEN_AUTH_USERS_TABLE = 'memorystore_token_auth_users';
export const MEMORYSTORE_AUTH_TOKENS_TABLE = 'memorystore_auth_tokens';
export const MEMORYSTORE_OPERATIONS_TABLE = 'memorystore_operations';

// ── Error Class ──

export type MemoryStoreErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_ARGUMENT'
  | 'FAILED_PRECONDITION'
  | 'ABORTED';

export class MemoryStoreError extends Error {
  readonly code: MemoryStoreErrorCode;
  readonly resourceName: string | undefined;
  readonly resourceType: string | undefined;

  /**
   * @param resourceType the resource this error is about, when it differs from
   *     the one its route is named for. A handler passes {@link
   *     handleMemoryStoreError} the route's primary resource, which is right
   *     for the parent lookup but wrong for a sub-resource conflict raised by
   *     the same call — `instances.backup` reporting a duplicate `Backup`, for
   *     one. Set this to have the emitted 409/404 name the actual resource.
   */
  constructor(
    code: MemoryStoreErrorCode,
    message: string,
    resourceName?: string,
    resourceType?: string
  ) {
    super(message);
    this.name = 'MemoryStoreError';
    this.code = code;
    this.resourceName = resourceName;
    this.resourceType = resourceType;
  }
}

export function handleMemoryStoreError(
  err: unknown,
  resourceType: string,
  responseUtils: ResponseUtils
): RouteResponse {
  if (err instanceof MemoryStoreError) {
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

// ── Conversion Utilities ──

function parseJsonFieldOptional<T>(json: string | null): T | undefined {
  if (json == null) return undefined;

  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}

// ── Instance ──

export interface DiscoveryEndpoint {
  address: string;
  port: number;
  network?: string;
}

// The connection type that marks a PSC endpoint as the one clients use to
// discover the instance, per the v1 discovery document's PscAutoConnection.
const CONNECTION_TYPE_DISCOVERY = 'CONNECTION_TYPE_DISCOVERY';

// The non-deprecated connection shape (Instance.endpoints[].connections[]).
// Only the fields a client needs to dial the port are modeled — the rest of
// PSC (service attachments, forwarding rules, consumer VPC networks) has no
// local analog. See ADR-007. Fields are optional because a client may PATCH an
// arbitrary subset that this emulator round-trips untouched.
export interface PscAutoConnection {
  ipAddress?: string;
  port?: number;
  connectionType?: string;
  pscConnectionStatus?: string;
}

export interface PscConnection {
  ipAddress?: string;
  port?: number;
  connectionType?: string;
  pscConnectionStatus?: string;
}

// Per the discovery document a ConnectionDetail carries a `pscAutoConnection`
// (service connectivity automation) or a `pscConnection` (user-created).
export interface ConnectionDetail {
  pscAutoConnection?: PscAutoConnection;
  pscConnection?: PscConnection;
}

export interface InstanceEndpoint {
  connections: ConnectionDetail[];
}

export interface InstanceResponse {
  name: string;
  uid?: string;
  createTime?: string;
  updateTime?: string;
  state?: string;
  stateInfo?: unknown;
  replicaCount?: number;
  shardCount?: number;
  nodeType?: string;
  mode?: string;
  authorizationMode?: string;
  transitEncryptionMode?: string;
  engineVersion?: string;
  labels?: Record<string, string>;
  nodeConfig?: unknown;
  discoveryEndpoints?: DiscoveryEndpoint[];
  pscAttachmentDetails?: unknown;
  backupCollection?: string;
  aclPolicy?: string;
  aclPolicyInfo?: unknown;
  aclPolicyInSync?: boolean;
  endpoints?: InstanceEndpoint[];
  maintenanceSchedule?: unknown;
  migrationConfig?: unknown;
  encryptionInfo?: unknown;
  satisfiesPzi?: boolean;
  satisfiesPzs?: boolean;
  availableMaintenanceVersions?: unknown;
  effectiveMaintenanceVersion?: string;
  deletionProtectionEnabled?: boolean;
  engineConfigs?: Record<string, string>;
  zoneDistributionConfig?: unknown;
  persistenceConfig?: unknown;
  automatedBackupConfig?: unknown;
  maintenancePolicy?: unknown;
  crossInstanceReplicationConfig?: unknown;
}

export interface InstanceRecord extends BaseRecord {
  name: string;
  uid: string;
  state: string;
  replicaCount: number;
  shardCount: number;
  nodeType: string;
  mode: string;
  authorizationMode: string;
  transitEncryptionMode: string;
  engineVersion: string | null;
  labels: string | null; // JSON-serialized Record<string, string>
  nodeConfig: string | null; // JSON-serialized NodeConfig
  stateInfo: string | null; // JSON-serialized StateInfo
  discoveryEndpoints: string | null; // JSON-serialized DiscoveryEndpoint[]
  pscAttachmentDetails: string | null; // JSON-serialized PscAttachmentDetail[]
  backupCollection: string | null;
  aclPolicy: string | null;
  aclPolicyInfo: string | null; // JSON-serialized AclPolicyInfo
  aclPolicyInSync: number; // 0 or 1
  endpoints: string | null; // JSON-serialized InstanceEndpoint[]
  maintenanceSchedule: string | null; // JSON-serialized MaintenanceSchedule
  migrationConfig: string | null; // JSON-serialized MigrationConfig
  encryptionInfo: string | null; // JSON-serialized EncryptionInfo
  satisfiesPzi: number; // 0 or 1
  satisfiesPzs: number; // 0 or 1
  availableMaintenanceVersions: string | null; // JSON-serialized string[]
  effectiveMaintenanceVersion: string | null;
  deletionProtectionEnabled: number; // 0 or 1
  engineConfigs: string | null; // JSON-serialized Record<string, string>
  zoneDistributionConfig: string | null; // JSON-serialized ZoneDistributionConfig
  persistenceConfig: string | null; // JSON-serialized PersistenceConfig
  automatedBackupConfig: string | null; // JSON-serialized AutomatedBackupConfig
  maintenancePolicy: string | null; // JSON-serialized MaintenancePolicy
  crossInstanceReplicationConfig: string | null; // JSON-serialized CrossInstanceReplicationConfig
}

export const instanceTableSchema: TableSchema = {
  name: MEMORYSTORE_INSTANCES_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'uid', type: 'string' },
    { name: 'state', type: 'string' },
    { name: 'replicaCount', type: 'number' },
    { name: 'shardCount', type: 'number' },
    { name: 'nodeType', type: 'string' },
    { name: 'mode', type: 'string' },
    { name: 'authorizationMode', type: 'string' },
    { name: 'transitEncryptionMode', type: 'string' },
    { name: 'engineVersion', type: 'string', nullable: true },
    { name: 'labels', type: 'json', nullable: true },
    { name: 'nodeConfig', type: 'json', nullable: true },
    { name: 'stateInfo', type: 'json', nullable: true },
    { name: 'discoveryEndpoints', type: 'json', nullable: true },
    { name: 'pscAttachmentDetails', type: 'json', nullable: true },
    { name: 'backupCollection', type: 'string', nullable: true },
    { name: 'aclPolicy', type: 'string', nullable: true },
    { name: 'aclPolicyInfo', type: 'json', nullable: true },
    { name: 'aclPolicyInSync', type: 'number' },
    { name: 'endpoints', type: 'json', nullable: true },
    { name: 'maintenanceSchedule', type: 'json', nullable: true },
    { name: 'migrationConfig', type: 'json', nullable: true },
    { name: 'encryptionInfo', type: 'json', nullable: true },
    { name: 'satisfiesPzi', type: 'number' },
    { name: 'satisfiesPzs', type: 'number' },
    { name: 'availableMaintenanceVersions', type: 'json', nullable: true },
    { name: 'effectiveMaintenanceVersion', type: 'string', nullable: true },
    { name: 'deletionProtectionEnabled', type: 'number' },
    { name: 'engineConfigs', type: 'json', nullable: true },
    { name: 'zoneDistributionConfig', type: 'json', nullable: true },
    { name: 'persistenceConfig', type: 'json', nullable: true },
    { name: 'automatedBackupConfig', type: 'json', nullable: true },
    { name: 'maintenancePolicy', type: 'json', nullable: true },
    { name: 'crossInstanceReplicationConfig', type: 'json', nullable: true },
  ],
  indexes: [{ name: 'idx_memorystore_instances_name', columns: ['name'], unique: true }],
  timestamps: true,
};

const INSTANCE_JSON_FIELD_NAMES = [
  'stateInfo',
  'nodeConfig',
  'discoveryEndpoints',
  'pscAttachmentDetails',
  'aclPolicyInfo',
  'endpoints',
  'maintenanceSchedule',
  'migrationConfig',
  'encryptionInfo',
  'availableMaintenanceVersions',
  'engineConfigs',
  'zoneDistributionConfig',
  'persistenceConfig',
  'automatedBackupConfig',
  'maintenancePolicy',
  'crossInstanceReplicationConfig',
] as const satisfies ReadonlyArray<keyof InstanceRecord & keyof InstanceResponse>;

// Columns typed `number` in InstanceRecord that carry a boolean on the wire.
// SQLite has no boolean type, so the record stores 0/1 and every reader
// compares `=== 1`; a raw `true` written into one of these reads back as
// false and silently disables whatever it was meant to enable.
const INSTANCE_BOOLEAN_FIELD_NAMES = new Set([
  'deletionProtectionEnabled',
  'aclPolicyInSync',
  'satisfiesPzi',
  'satisfiesPzs',
]);

/**
 * Convert one client-supplied Instance field into its stored representation.
 *
 * <p>Shared by create and patch so the two paths cannot disagree about which
 * fields are JSON-encoded and which are boolean-as-0/1. Keeping a second,
 * hand-maintained list next to a caller is how `endpoints` ended up stored as
 * a raw array (unreadable on the way back out) and `deletionProtectionEnabled`
 * as a raw boolean (read back as `false`).
 */
export function serializeInstanceFieldValue(field: string, value: unknown): unknown {
  if (value == null) {
    return value;
  }

  if (INSTANCE_JSON_FIELD_NAMES.includes(field as (typeof INSTANCE_JSON_FIELD_NAMES)[number])) {
    return JSON.stringify(value);
  }

  if (field === 'labels') {
    return JSON.stringify(value);
  }

  if (INSTANCE_BOOLEAN_FIELD_NAMES.has(field)) {
    return value === true || value === 1 ? 1 : 0;
  }

  return value;
}

/**
 * Mirror the (deprecated) discovery endpoints onto the modern
 * `endpoints[].connections[].pscAutoConnection` shape.
 *
 * <p>GCP has deprecated {@link DiscoveryEndpoint}; newer clients resolve the
 * connection from `endpoints[].connections[]` with
 * `connectionType: CONNECTION_TYPE_DISCOVERY` instead. The full PSC model has
 * no local analog, so only the fields a client needs to dial the port —
 * `ipAddress`, `port`, `connectionType` — are surfaced, derived from the same
 * `address:port` advertised in `discoveryEndpoints`. See ADR-007.
 */
function synthesizeDiscoveryPscEndpoints(
  discoveryEndpoints: DiscoveryEndpoint[]
): InstanceEndpoint[] {
  return [
    {
      connections: discoveryEndpoints.map(endpoint => ({
        pscAutoConnection: {
          ipAddress: endpoint.address,
          port: endpoint.port,
          connectionType: CONNECTION_TYPE_DISCOVERY,
          pscConnectionStatus: 'ACTIVE',
        },
      })),
    },
  ];
}

export function instanceRecordToResponse(record: InstanceRecord): InstanceResponse {
  const response: InstanceResponse = {
    name: record.name,
    uid: record.uid,
    createTime: record.createdAt.toISOString(),
    updateTime: record.updatedAt.toISOString(),
    state: record.state,
    replicaCount: record.replicaCount,
    shardCount: record.shardCount,
    nodeType: record.nodeType,
    mode: record.mode,
    authorizationMode: record.authorizationMode,
    transitEncryptionMode: record.transitEncryptionMode,
    aclPolicyInSync: record.aclPolicyInSync === 1,
    satisfiesPzi: record.satisfiesPzi === 1,
    satisfiesPzs: record.satisfiesPzs === 1,
    deletionProtectionEnabled: record.deletionProtectionEnabled === 1,
  };

  if (record.engineVersion) response.engineVersion = record.engineVersion;
  if (record.backupCollection) response.backupCollection = record.backupCollection;
  if (record.aclPolicy) response.aclPolicy = record.aclPolicy;
  if (record.effectiveMaintenanceVersion) {
    response.effectiveMaintenanceVersion = record.effectiveMaintenanceVersion;
  }

  const labels = parseJsonFieldOptional<Record<string, string>>(record.labels);

  if (labels) response.labels = labels;

  for (const field of INSTANCE_JSON_FIELD_NAMES) {
    const parsed = parseJsonFieldOptional(record[field]);

    if (parsed !== undefined) {
      (response as unknown as Record<string, unknown>)[field] = parsed;
    }
  }

  // Advertise the connection on the modern PSC path too, but never clobber a
  // client-supplied `endpoints` value (persisted via PATCH) — synthesis is only
  // a fallback for the common case where we allocated the endpoint ourselves.
  if (response.endpoints === undefined && response.discoveryEndpoints?.length) {
    response.endpoints = synthesizeDiscoveryPscEndpoints(response.discoveryEndpoints);
  }

  return response;
}

export function instanceRequestToRecord(
  name: string,
  body: Record<string, unknown>
): Omit<InstanceRecord, keyof BaseRecord> {
  return {
    name,
    uid: crypto.randomUUID(),
    state: 'CREATING',
    replicaCount: typeof body.replicaCount === 'number' ? body.replicaCount : 0,
    shardCount: typeof body.shardCount === 'number' ? body.shardCount : 1,
    nodeType: typeof body.nodeType === 'string' ? body.nodeType : 'NODE_TYPE_UNSPECIFIED',
    mode: typeof body.mode === 'string' ? body.mode : 'STANDALONE',
    authorizationMode:
      typeof body.authorizationMode === 'string' ? body.authorizationMode : 'AUTH_DISABLED',
    transitEncryptionMode:
      typeof body.transitEncryptionMode === 'string'
        ? body.transitEncryptionMode
        : 'TRANSIT_ENCRYPTION_DISABLED',
    engineVersion: typeof body.engineVersion === 'string' ? body.engineVersion : null,
    labels: body.labels ? JSON.stringify(body.labels) : null,
    nodeConfig: null,
    stateInfo: null,
    discoveryEndpoints: null,
    pscAttachmentDetails: null,
    backupCollection: null,
    aclPolicy: null,
    aclPolicyInfo: null,
    aclPolicyInSync: 0,
    endpoints: null,
    maintenanceSchedule: null,
    migrationConfig: null,
    encryptionInfo: null,
    satisfiesPzi: 0,
    satisfiesPzs: 0,
    availableMaintenanceVersions: null,
    effectiveMaintenanceVersion: null,
    deletionProtectionEnabled: body.deletionProtectionEnabled === true ? 1 : 0,
    engineConfigs: body.engineConfigs ? JSON.stringify(body.engineConfigs) : null,
    zoneDistributionConfig: body.zoneDistributionConfig
      ? JSON.stringify(body.zoneDistributionConfig)
      : null,
    persistenceConfig: body.persistenceConfig ? JSON.stringify(body.persistenceConfig) : null,
    automatedBackupConfig: body.automatedBackupConfig
      ? JSON.stringify(body.automatedBackupConfig)
      : null,
    maintenancePolicy: body.maintenancePolicy ? JSON.stringify(body.maintenancePolicy) : null,
    crossInstanceReplicationConfig: body.crossInstanceReplicationConfig
      ? JSON.stringify(body.crossInstanceReplicationConfig)
      : null,
  };
}

export function buildInstanceName(project: string, location: string, instance: string): string {
  return `projects/${project}/locations/${location}/instances/${instance}`;
}

export function parseInstanceName(name: string): {
  project: string;
  location: string;
  instance: string;
} {
  const match = name.match(/^projects\/([^/]+)\/locations\/([^/]+)\/instances\/([^/]+)$/);

  if (!match) {
    throw new Error(
      `Invalid instance resource name: "${name}". Expected format: projects/{project}/locations/{location}/instances/{instance}`
    );
  }

  return {
    project: match[1] as string,
    location: match[2] as string,
    instance: match[3] as string,
  };
}

// ── Backup Collections & Backups ──

export interface BackupCollectionResponse {
  name: string;
  uid?: string;
  createTime?: string;
  instance?: string;
  instanceUid?: string;
  kmsKey?: string;
  totalBackupCount?: number;
  totalBackupSizeBytes?: string;
  lastBackupTime?: string;
}

export interface BackupCollectionRecord extends BaseRecord {
  name: string;
  uid: string;
  instance: string;
  instanceUid: string;
  kmsKey: string | null;
  totalBackupCount: number;
  totalBackupSizeBytes: string;
  lastBackupTime: string | null;
}

export const backupCollectionTableSchema: TableSchema = {
  name: MEMORYSTORE_BACKUP_COLLECTIONS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'uid', type: 'string' },
    { name: 'instance', type: 'string' },
    { name: 'instanceUid', type: 'string' },
    { name: 'kmsKey', type: 'string', nullable: true },
    { name: 'totalBackupCount', type: 'number' },
    { name: 'totalBackupSizeBytes', type: 'string' },
    { name: 'lastBackupTime', type: 'string', nullable: true },
  ],
  indexes: [
    { name: 'idx_memorystore_backup_collections_name', columns: ['name'], unique: true },
    { name: 'idx_memorystore_backup_collections_instance', columns: ['instance'] },
  ],
  timestamps: true,
};

export function backupCollectionRecordToResponse(
  record: BackupCollectionRecord
): BackupCollectionResponse {
  const response: BackupCollectionResponse = {
    name: record.name,
    uid: record.uid,
    createTime: record.createdAt.toISOString(),
    instance: record.instance,
    instanceUid: record.instanceUid,
    totalBackupCount: record.totalBackupCount,
    totalBackupSizeBytes: record.totalBackupSizeBytes,
  };

  if (record.kmsKey) response.kmsKey = record.kmsKey;
  if (record.lastBackupTime) response.lastBackupTime = record.lastBackupTime;

  return response;
}

export function buildBackupCollectionName(
  project: string,
  location: string,
  backupCollection: string
): string {
  return `projects/${project}/locations/${location}/backupCollections/${backupCollection}`;
}

export function parseBackupCollectionName(name: string): {
  project: string;
  location: string;
  backupCollection: string;
} {
  const match = name.match(/^projects\/([^/]+)\/locations\/([^/]+)\/backupCollections\/([^/]+)$/);

  if (!match) {
    throw new Error(
      `Invalid backup collection resource name: "${name}". Expected format: projects/{project}/locations/{location}/backupCollections/{backupCollection}`
    );
  }

  return {
    project: match[1] as string,
    location: match[2] as string,
    backupCollection: match[3] as string,
  };
}

export interface BackupFile {
  fileName: string;
  sizeBytes: string;
  createTime?: string;
}

export interface BackupResponse {
  name: string;
  backupCollection?: string;
  uid?: string;
  createTime?: string;
  instance?: string;
  instanceUid?: string;
  state?: string;
  backupType?: string;
  engineVersion?: string;
  replicaCount?: number;
  shardCount?: number;
  nodeType?: string;
  totalSizeBytes?: string;
  backupFiles?: BackupFile[];
  expireTime?: string;
  encryptionInfo?: unknown;
}

export interface BackupRecord extends BaseRecord {
  name: string;
  backupCollection: string;
  uid: string;
  instance: string;
  instanceUid: string;
  state: string;
  backupType: string;
  engineVersion: string | null;
  replicaCount: number;
  shardCount: number;
  nodeType: string;
  totalSizeBytes: string;
  backupFiles: string; // JSON-serialized BackupFile[]
  expireTime: string | null;
  encryptionInfo: string | null; // JSON-serialized EncryptionInfo
}

export const backupTableSchema: TableSchema = {
  name: MEMORYSTORE_BACKUPS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'backupCollection', type: 'string' },
    { name: 'uid', type: 'string' },
    { name: 'instance', type: 'string' },
    { name: 'instanceUid', type: 'string' },
    { name: 'state', type: 'string' },
    { name: 'backupType', type: 'string' },
    { name: 'engineVersion', type: 'string', nullable: true },
    { name: 'replicaCount', type: 'number' },
    { name: 'shardCount', type: 'number' },
    { name: 'nodeType', type: 'string' },
    { name: 'totalSizeBytes', type: 'string' },
    { name: 'backupFiles', type: 'json' },
    { name: 'expireTime', type: 'string', nullable: true },
    { name: 'encryptionInfo', type: 'json', nullable: true },
  ],
  indexes: [
    { name: 'idx_memorystore_backups_name', columns: ['name'], unique: true },
    { name: 'idx_memorystore_backups_collection', columns: ['backupCollection'] },
  ],
  timestamps: true,
};

export function backupRecordToResponse(record: BackupRecord): BackupResponse {
  const response: BackupResponse = {
    name: record.name,
    backupCollection: record.backupCollection,
    uid: record.uid,
    createTime: record.createdAt.toISOString(),
    instance: record.instance,
    instanceUid: record.instanceUid,
    state: record.state,
    backupType: record.backupType,
    replicaCount: record.replicaCount,
    shardCount: record.shardCount,
    nodeType: record.nodeType,
    totalSizeBytes: record.totalSizeBytes,
  };

  if (record.engineVersion) response.engineVersion = record.engineVersion;
  if (record.expireTime) response.expireTime = record.expireTime;

  const backupFiles = parseJsonFieldOptional<BackupFile[]>(record.backupFiles);

  if (backupFiles) response.backupFiles = backupFiles;

  const encryptionInfo = parseJsonFieldOptional(record.encryptionInfo);

  if (encryptionInfo) response.encryptionInfo = encryptionInfo;

  return response;
}

export function buildBackupName(
  project: string,
  location: string,
  backupCollection: string,
  backup: string
): string {
  return `projects/${project}/locations/${location}/backupCollections/${backupCollection}/backups/${backup}`;
}

export function parseBackupName(name: string): {
  project: string;
  location: string;
  backupCollection: string;
  backup: string;
} {
  const match = name.match(
    /^projects\/([^/]+)\/locations\/([^/]+)\/backupCollections\/([^/]+)\/backups\/([^/]+)$/
  );

  if (!match) {
    throw new Error(
      `Invalid backup resource name: "${name}". Expected format: projects/{project}/locations/{location}/backupCollections/{backupCollection}/backups/{backup}`
    );
  }

  return {
    project: match[1] as string,
    location: match[2] as string,
    backupCollection: match[3] as string,
    backup: match[4] as string,
  };
}

// ── ACL Policies & Revisions ──

export interface AclRule {
  username: string;
  rule: string;
}

export interface AclPolicyResponse {
  name: string;
  state?: string;
  createTime?: string;
  updateTime?: string;
  rules: AclRule[];
  etag?: string;
  instanceAclPolicyAttachments?: unknown[];
}

export interface AclPolicyRecord extends BaseRecord {
  name: string;
  state: string;
  rules: string; // JSON-serialized AclRule[]
  etag: string;
  instanceAclPolicyAttachments: string | null; // JSON-serialized InstanceAclPolicyAttachment[]
}

export const aclPolicyTableSchema: TableSchema = {
  name: MEMORYSTORE_ACL_POLICIES_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'state', type: 'string' },
    { name: 'rules', type: 'json' },
    { name: 'etag', type: 'string' },
    { name: 'instanceAclPolicyAttachments', type: 'json', nullable: true },
  ],
  indexes: [{ name: 'idx_memorystore_acl_policies_name', columns: ['name'], unique: true }],
  timestamps: true,
};

export function aclPolicyRecordToResponse(record: AclPolicyRecord): AclPolicyResponse {
  const response: AclPolicyResponse = {
    name: record.name,
    state: record.state,
    createTime: record.createdAt.toISOString(),
    updateTime: record.updatedAt.toISOString(),
    rules: JSON.parse(record.rules) as AclRule[],
  };

  if (record.etag) response.etag = record.etag;

  const attachments = parseJsonFieldOptional<unknown[]>(record.instanceAclPolicyAttachments);

  if (attachments) response.instanceAclPolicyAttachments = attachments;

  return response;
}

export function aclPolicyRequestToRecord(
  name: string,
  body: { rules?: AclRule[] }
): Omit<AclPolicyRecord, keyof BaseRecord> {
  return {
    name,
    state: 'ACTIVE',
    rules: JSON.stringify(body.rules ?? []),
    etag: crypto.randomUUID(),
    instanceAclPolicyAttachments: null,
  };
}

export function buildAclPolicyName(project: string, location: string, aclPolicy: string): string {
  return `projects/${project}/locations/${location}/aclPolicies/${aclPolicy}`;
}

export function parseAclPolicyName(name: string): {
  project: string;
  location: string;
  aclPolicy: string;
} {
  const match = name.match(/^projects\/([^/]+)\/locations\/([^/]+)\/aclPolicies\/([^/]+)$/);

  if (!match) {
    throw new Error(
      `Invalid ACL policy resource name: "${name}". Expected format: projects/{project}/locations/{location}/aclPolicies/{aclPolicy}`
    );
  }

  return {
    project: match[1] as string,
    location: match[2] as string,
    aclPolicy: match[3] as string,
  };
}

export interface AclPolicyRevisionResponse {
  name: string;
  revisionNumber?: string;
  attachedInstances?: string[];
  snapshot?: unknown;
  createTime?: string;
}

export interface AclPolicyRevisionRecord extends BaseRecord {
  name: string;
  policyName: string;
  revisionNumber: string;
  attachedInstances: string; // JSON-serialized string[]
  snapshot: string; // JSON-serialized AclPolicyResponse
}

export const aclPolicyRevisionTableSchema: TableSchema = {
  name: MEMORYSTORE_ACL_POLICY_REVISIONS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'policyName', type: 'string' },
    { name: 'revisionNumber', type: 'string' },
    { name: 'attachedInstances', type: 'json' },
    { name: 'snapshot', type: 'json' },
  ],
  indexes: [
    { name: 'idx_memorystore_acl_policy_revisions_name', columns: ['name'], unique: true },
    { name: 'idx_memorystore_acl_policy_revisions_policy', columns: ['policyName'] },
  ],
  timestamps: true,
};

export function aclPolicyRevisionRecordToResponse(
  record: AclPolicyRevisionRecord
): AclPolicyRevisionResponse {
  const response: AclPolicyRevisionResponse = {
    name: record.name,
    revisionNumber: record.revisionNumber,
    createTime: record.createdAt.toISOString(),
  };

  const attachedInstances = parseJsonFieldOptional<string[]>(record.attachedInstances);

  if (attachedInstances) response.attachedInstances = attachedInstances;

  const snapshot = parseJsonFieldOptional(record.snapshot);

  if (snapshot) response.snapshot = snapshot;

  return response;
}

export function buildAclPolicyRevisionName(
  project: string,
  location: string,
  aclPolicy: string,
  revision: string
): string {
  return `projects/${project}/locations/${location}/aclPolicies/${aclPolicy}/revisions/${revision}`;
}

export function parseAclPolicyRevisionName(name: string): {
  project: string;
  location: string;
  aclPolicy: string;
  revision: string;
} {
  const match = name.match(
    /^projects\/([^/]+)\/locations\/([^/]+)\/aclPolicies\/([^/]+)\/revisions\/([^/]+)$/
  );

  if (!match) {
    throw new Error(
      `Invalid ACL policy revision resource name: "${name}". Expected format: projects/{project}/locations/{location}/aclPolicies/{aclPolicy}/revisions/{revision}`
    );
  }

  return {
    project: match[1] as string,
    location: match[2] as string,
    aclPolicy: match[3] as string,
    revision: match[4] as string,
  };
}

// ── Token Auth Users & Auth Tokens ──

// AddTokenAuthUserRequest.tokenAuthUser is a bare string ("the name of the
// token auth user to add"), whereas AddAuthTokenRequest.authToken is a full
// AuthToken message. The asymmetry is GCP's, not a typo here — modelling
// tokenAuthUser as an object would reject the request shape that
// @google-cloud/memorystore actually sends.
export const AddTokenAuthUserRequestSchema = z.object({
  tokenAuthUser: z.string().min(1),
});

export const AddAuthTokenRequestSchema = z.object({
  authToken: z.object({ name: z.string().min(1) }),
});

/**
 * Reduce a resource name to its final path segment.
 *
 * <p>Request messages carry full resource names (`projects/p/locations/l/
 * instances/i/tokenAuthUsers/u`) while the `build*Name` helpers compose a
 * name from its parent plus a bare id. Passing a full name straight through
 * would nest a second copy of the parent path inside the result and leave
 * the resource unreachable by get/delete. Callers that pass a bare id are
 * unaffected.
 */
export function extractResourceId(nameOrId: string): string {
  const segments = nameOrId.split('/');

  return segments[segments.length - 1] ?? nameOrId;
}

export interface TokenAuthUserResponse {
  name: string;
  state?: string;
}

export interface TokenAuthUserRecord extends BaseRecord {
  name: string;
  instance: string;
  state: string;
}

export const tokenAuthUserTableSchema: TableSchema = {
  name: MEMORYSTORE_TOKEN_AUTH_USERS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'instance', type: 'string' },
    { name: 'state', type: 'string' },
  ],
  indexes: [
    { name: 'idx_memorystore_token_auth_users_name', columns: ['name'], unique: true },
    { name: 'idx_memorystore_token_auth_users_instance', columns: ['instance'] },
  ],
  timestamps: true,
};

export function tokenAuthUserRecordToResponse(record: TokenAuthUserRecord): TokenAuthUserResponse {
  return { name: record.name, state: record.state };
}

export function buildTokenAuthUserName(
  project: string,
  location: string,
  instance: string,
  tokenAuthUser: string
): string {
  return `projects/${project}/locations/${location}/instances/${instance}/tokenAuthUsers/${tokenAuthUser}`;
}

export function parseTokenAuthUserName(name: string): {
  project: string;
  location: string;
  instance: string;
  tokenAuthUser: string;
} {
  const match = name.match(
    /^projects\/([^/]+)\/locations\/([^/]+)\/instances\/([^/]+)\/tokenAuthUsers\/([^/]+)$/
  );

  if (!match) {
    throw new Error(
      `Invalid token auth user resource name: "${name}". Expected format: projects/{project}/locations/{location}/instances/{instance}/tokenAuthUsers/{tokenAuthUser}`
    );
  }

  return {
    project: match[1] as string,
    location: match[2] as string,
    instance: match[3] as string,
    tokenAuthUser: match[4] as string,
  };
}

export interface AuthTokenResponse {
  name: string;
  token?: string;
  createTime?: string;
  state?: string;
}

export interface AuthTokenRecord extends BaseRecord {
  name: string;
  tokenAuthUser: string;
  token: string;
  state: string;
}

export const authTokenTableSchema: TableSchema = {
  name: MEMORYSTORE_AUTH_TOKENS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'tokenAuthUser', type: 'string' },
    { name: 'token', type: 'string' },
    { name: 'state', type: 'string' },
  ],
  indexes: [
    { name: 'idx_memorystore_auth_tokens_name', columns: ['name'], unique: true },
    { name: 'idx_memorystore_auth_tokens_token_auth_user', columns: ['tokenAuthUser'] },
  ],
  timestamps: true,
};

export function authTokenRecordToResponse(record: AuthTokenRecord): AuthTokenResponse {
  return {
    name: record.name,
    token: record.token,
    createTime: record.createdAt.toISOString(),
    state: record.state,
  };
}

export function buildAuthTokenName(
  project: string,
  location: string,
  instance: string,
  tokenAuthUser: string,
  authToken: string
): string {
  return `projects/${project}/locations/${location}/instances/${instance}/tokenAuthUsers/${tokenAuthUser}/authTokens/${authToken}`;
}

export function parseAuthTokenName(name: string): {
  project: string;
  location: string;
  instance: string;
  tokenAuthUser: string;
  authToken: string;
} {
  const match = name.match(
    /^projects\/([^/]+)\/locations\/([^/]+)\/instances\/([^/]+)\/tokenAuthUsers\/([^/]+)\/authTokens\/([^/]+)$/
  );

  if (!match) {
    throw new Error(
      `Invalid auth token resource name: "${name}". Expected format: projects/{project}/locations/{location}/instances/{instance}/tokenAuthUsers/{tokenAuthUser}/authTokens/{authToken}`
    );
  }

  return {
    project: match[1] as string,
    location: match[2] as string,
    instance: match[3] as string,
    tokenAuthUser: match[4] as string,
    authToken: match[5] as string,
  };
}

// ── LRO Operations ──

export interface OperationMetadata {
  '@type'?: string;
  createTime: string;
  endTime: string;
  target: string;
  verb: string;
  apiVersion: string;
  requestedCancellation?: boolean;
}

export interface OperationResponse {
  name: string;
  metadata: OperationMetadata;
  done: boolean;
  response?: Record<string, unknown>;
  error?: unknown;
}

export interface OperationRecord extends BaseRecord {
  name: string;
  metadata: string; // JSON-serialized OperationMetadata
  done: number; // 0 or 1
  response: string | null; // JSON-serialized
  error: string | null; // JSON-serialized
}

export const memorystoreOperationsTableSchema: TableSchema = {
  name: MEMORYSTORE_OPERATIONS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'metadata', type: 'json' },
    { name: 'done', type: 'number' },
    { name: 'response', type: 'json', nullable: true },
    { name: 'error', type: 'json', nullable: true },
  ],
  indexes: [{ name: 'idx_memorystore_operations_name', columns: ['name'], unique: true }],
  timestamps: true,
};

export function buildMemorystoreOperationName(
  project: string,
  location: string,
  operationId: string
): string {
  return `projects/${project}/locations/${location}/operations/${operationId}`;
}

export function operationRecordToResponse(record: OperationRecord): OperationResponse {
  const response: OperationResponse = {
    name: record.name,
    metadata: JSON.parse(record.metadata) as OperationMetadata,
    done: record.done === 1,
  };

  if (record.response) {
    response.response = JSON.parse(record.response) as Record<string, unknown>;
  }

  if (record.error) {
    response.error = JSON.parse(record.error);
  }

  return response;
}
