/**
 * Cloud Storage (GCS v1) data models, schemas, and helper functions
 */

import { z } from 'zod';
import type { BaseRecord, TableSchema } from '@/core/storage/types.ts';

// ── Constants ──

export const BUCKETS_TABLE = 'storage_buckets';
export const OBJECTS_TABLE = 'storage_objects';
export const IAM_POLICIES_TABLE = 'storage_iam_policies';
export const NOTIFICATIONS_TABLE = 'storage_notifications';

export const StorageClass = {
  STANDARD: 'STANDARD',
  NEARLINE: 'NEARLINE',
  COLDLINE: 'COLDLINE',
  ARCHIVE: 'ARCHIVE',
  MULTI_REGIONAL: 'MULTI_REGIONAL',
  REGIONAL: 'REGIONAL',
} as const;

export type StorageClassType = (typeof StorageClass)[keyof typeof StorageClass];

export const DEFAULT_STORAGE_CLASS: StorageClassType = StorageClass.STANDARD;
export const DEFAULT_LOCATION = 'US';

// ── Response Interfaces ──

export interface BucketResponse {
  kind: 'storage#bucket';
  id: string;
  selfLink: string;
  name: string;
  projectNumber: string;
  metageneration: string;
  location: string;
  storageClass: string;
  timeCreated: string;
  updated: string;
  etag: string;
  versioning?: { enabled: boolean };
  labels?: Record<string, string>;
  cors?: Array<{
    origin?: string[];
    method?: string[];
    responseHeader?: string[];
    maxAgeSeconds?: number;
  }>;
  lifecycle?: { rule: Array<Record<string, unknown>> };
}

export interface ObjectResponse {
  kind: 'storage#object';
  id: string;
  selfLink: string;
  mediaLink: string;
  name: string;
  bucket: string;
  generation: string;
  metageneration: string;
  contentType: string;
  storageClass: string;
  size: string;
  md5Hash: string;
  crc32c: string;
  etag: string;
  timeCreated: string;
  updated: string;
  metadata?: Record<string, string>;
  contentEncoding?: string;
  contentDisposition?: string;
  contentLanguage?: string;
  cacheControl?: string;
}

export interface ObjectListResponse {
  kind: 'storage#objects';
  items?: ObjectResponse[];
  prefixes?: string[];
  nextPageToken?: string;
}

export interface BucketListResponse {
  kind: 'storage#buckets';
  items?: BucketResponse[];
  nextPageToken?: string;
}

export interface RewriteResponse {
  kind: 'storage#rewriteResponse';
  totalBytesRewritten: string;
  objectSize: string;
  done: boolean;
  resource: ObjectResponse;
}

export type NotificationPayloadFormat = 'JSON_API_V1' | 'NONE';

export const NOTIFICATION_EVENT_TYPES = [
  'OBJECT_FINALIZE',
  'OBJECT_METADATA_UPDATE',
  'OBJECT_DELETE',
  'OBJECT_ARCHIVE',
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export const BUILTIN_NOTIFICATION_ATTRIBUTES = [
  'eventType',
  'bucketId',
  'objectId',
  'objectGeneration',
  'eventTime',
  'payloadFormat',
  'notificationConfig',
  'overwroteGeneration',
  'overwrittenByGeneration',
] as const;

export interface NotificationResponse {
  kind: 'storage#notification';
  id: string;
  selfLink: string;
  topic: string;
  etag: string;
  payload_format: NotificationPayloadFormat;
  event_types?: NotificationEventType[];
  object_name_prefix?: string;
  custom_attributes?: Record<string, string>;
}

export interface NotificationListResponse {
  kind: 'storage#notifications';
  items: NotificationResponse[];
}

export interface PolicyBinding {
  role: string;
  members: string[];
  condition?: {
    title?: string;
    description?: string;
    expression?: string;
    location?: string;
  };
}

export interface PolicyResponse {
  kind: 'storage#policy';
  resourceId: string;
  version: number;
  etag: string;
  bindings: PolicyBinding[];
}

export interface TestIamPermissionsResponse {
  kind: 'storage#testIamPermissionsResponse';
  permissions: string[];
}

// ── Storage Records ──

export interface BucketRecord extends BaseRecord {
  name: string;
  location: string;
  storageClass: string;
  metageneration: number;
  timeCreated: string;
  updated: string;
  versioning: string | null; // JSON
  labels: string | null; // JSON
  cors: string | null; // JSON
  lifecycle: string | null; // JSON
  projectId: string | null;
  projectNumber: string;
}

export interface IamPolicyRecord extends BaseRecord {
  resourceId: string;
  version: number;
  etag: string;
  bindings: string; // JSON
}

export interface NotificationRecord extends BaseRecord {
  bucket: string;
  topic: string;
  payloadFormat: NotificationPayloadFormat;
  eventTypes: string | null;
  objectNamePrefix: string | null;
  customAttributes: string | null;
  etag: string;
  ordinal: number;
}

export interface ObjectRecord extends BaseRecord {
  bucket: string;
  name: string;
  generation: string;
  metageneration: number;
  contentType: string;
  size: number;
  md5Hash: string;
  crc32c: string;
  etag: string;
  storageClass: string;
  timeCreated: string;
  updated: string;
  metadata: string | null; // JSON
  blobPath: string;
  contentEncoding: string | null;
  contentDisposition: string | null;
  contentLanguage: string | null;
  cacheControl: string | null;
}

// ── Table Schemas ──

export const bucketsTableSchema: TableSchema = {
  name: BUCKETS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'location', type: 'string' },
    { name: 'storageClass', type: 'string' },
    { name: 'metageneration', type: 'number' },
    { name: 'timeCreated', type: 'string' },
    { name: 'updated', type: 'string' },
    { name: 'versioning', type: 'json', nullable: true },
    { name: 'labels', type: 'json', nullable: true },
    { name: 'cors', type: 'json', nullable: true },
    { name: 'lifecycle', type: 'json', nullable: true },
    { name: 'projectId', type: 'string', nullable: true },
    { name: 'projectNumber', type: 'string' },
  ],
  indexes: [
    { name: 'idx_storage_buckets_name', columns: ['name'], unique: true },
    { name: 'idx_storage_buckets_project', columns: ['projectId'] },
  ],
  timestamps: true,
};

export const iamPoliciesTableSchema: TableSchema = {
  name: IAM_POLICIES_TABLE,
  columns: [
    { name: 'resourceId', type: 'string', unique: true },
    { name: 'version', type: 'number' },
    { name: 'etag', type: 'string' },
    { name: 'bindings', type: 'json' },
  ],
  indexes: [{ name: 'idx_storage_iam_policies_resource', columns: ['resourceId'], unique: true }],
  timestamps: true,
};

export const notificationsTableSchema: TableSchema = {
  name: NOTIFICATIONS_TABLE,
  columns: [
    { name: 'bucket', type: 'string' },
    { name: 'topic', type: 'string' },
    { name: 'payloadFormat', type: 'string' },
    { name: 'eventTypes', type: 'json', nullable: true },
    { name: 'objectNamePrefix', type: 'string', nullable: true },
    { name: 'customAttributes', type: 'json', nullable: true },
    { name: 'etag', type: 'string' },
    { name: 'ordinal', type: 'number' },
  ],
  indexes: [{ name: 'idx_storage_notifications_bucket', columns: ['bucket'] }],
  timestamps: true,
};

export const objectsTableSchema: TableSchema = {
  name: OBJECTS_TABLE,
  columns: [
    { name: 'bucket', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'generation', type: 'string' },
    { name: 'metageneration', type: 'number' },
    { name: 'contentType', type: 'string' },
    { name: 'size', type: 'number' },
    { name: 'md5Hash', type: 'string' },
    { name: 'crc32c', type: 'string' },
    { name: 'etag', type: 'string' },
    { name: 'storageClass', type: 'string' },
    { name: 'timeCreated', type: 'string' },
    { name: 'updated', type: 'string' },
    { name: 'metadata', type: 'json', nullable: true },
    { name: 'blobPath', type: 'string' },
    { name: 'contentEncoding', type: 'string', nullable: true },
    { name: 'contentDisposition', type: 'string', nullable: true },
    { name: 'contentLanguage', type: 'string', nullable: true },
    { name: 'cacheControl', type: 'string', nullable: true },
  ],
  indexes: [
    { name: 'idx_storage_objects_bucket_name', columns: ['bucket', 'name'] },
    { name: 'idx_storage_objects_bucket', columns: ['bucket'] },
    { name: 'idx_storage_objects_generation', columns: ['generation'] },
  ],
  timestamps: true,
};

// ── Zod Schemas ──

const VALID_STORAGE_CLASSES = [
  'STANDARD',
  'NEARLINE',
  'COLDLINE',
  'ARCHIVE',
  'MULTI_REGIONAL',
  'REGIONAL',
] as const;

export const CreateBucketRequestSchema = z.object({
  name: z.string().min(1),
  location: z.string().optional(),
  storageClass: z.enum(VALID_STORAGE_CLASSES).optional(),
  versioning: z.object({ enabled: z.boolean() }).optional(),
  labels: z.record(z.string(), z.string()).optional(),
  cors: z
    .array(
      z.object({
        origin: z.array(z.string()).optional(),
        method: z.array(z.string()).optional(),
        responseHeader: z.array(z.string()).optional(),
        maxAgeSeconds: z.number().int().optional(),
      })
    )
    .optional(),
  lifecycle: z
    .object({
      rule: z.array(z.record(z.string(), z.unknown())),
    })
    .optional(),
});

export type CreateBucketRequest = z.infer<typeof CreateBucketRequestSchema>;

export const UpdateBucketRequestSchema = z.object({
  storageClass: z.enum(VALID_STORAGE_CLASSES).optional(),
  versioning: z.object({ enabled: z.boolean() }).optional(),
  labels: z.record(z.string(), z.string()).optional(),
  cors: z
    .array(
      z.object({
        origin: z.array(z.string()).optional(),
        method: z.array(z.string()).optional(),
        responseHeader: z.array(z.string()).optional(),
        maxAgeSeconds: z.number().int().optional(),
      })
    )
    .optional(),
  lifecycle: z
    .object({
      rule: z.array(z.record(z.string(), z.unknown())),
    })
    .optional(),
});

const PolicyBindingSchema = z.object({
  role: z.string().min(1),
  members: z.array(z.string()),
  condition: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      expression: z.string().optional(),
      location: z.string().optional(),
    })
    .optional(),
});

export const SetIamPolicyRequestSchema = z.object({
  bindings: z.array(PolicyBindingSchema).optional(),
  etag: z.string().optional(),
  version: z.number().int().optional(),
});

export const InsertNotificationRequestSchema = z.object({
  topic: z.string().min(1),
  payload_format: z.enum(['JSON_API_V1', 'NONE']),
  event_types: z.array(z.enum(NOTIFICATION_EVENT_TYPES)).optional(),
  object_name_prefix: z.string().optional(),
  custom_attributes: z.record(z.string(), z.string()).optional(),
});

export const ComposeRequestSchema = z.object({
  sourceObjects: z
    .array(
      z.object({
        name: z.string().min(1),
        generation: z.string().optional(),
      })
    )
    .min(1)
    .max(32),
  destination: z
    .object({
      contentType: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

// ── Helper Functions ──

export function bucketIamResourceId(bucket: string): string {
  return `projects/_/buckets/${bucket}`;
}

/** v2 `TestIamPermissions` object resource: `projects/_/buckets/{bucket}/objects/{object}`. */
export function objectIamResourceId(bucket: string, objectName: string): string {
  return `projects/_/buckets/${bucket}/objects/${objectName}`;
}

export function parseBucketName(name: string): string {
  if (!name || name.length === 0) {
    throw new Error('Bucket name cannot be empty');
  }

  if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(name) && !/^[a-z0-9]{1,2}$/.test(name)) {
    throw new Error(
      `Invalid bucket name: "${name}". Bucket names must contain only lowercase letters, numbers, hyphens, underscores, and dots.`
    );
  }

  return name;
}

export function parseObjectName(rawName: string): string {
  return decodeURIComponent(rawName);
}

// ── Conversion Functions ──

export function bucketRecordToResponse(record: BucketRecord): BucketResponse {
  const response: BucketResponse = {
    kind: 'storage#bucket',
    id: record.name,
    selfLink: `https://www.googleapis.com/storage/v1/b/${record.name}`,
    name: record.name,
    projectNumber: record.projectNumber,
    metageneration: String(record.metageneration),
    location: record.location,
    storageClass: record.storageClass,
    timeCreated: record.timeCreated,
    updated: record.updated,
    etag: `CAE${record.metageneration}=`,
  };

  if (record.versioning) {
    response.versioning = JSON.parse(record.versioning) as { enabled: boolean };
  }

  if (record.labels) {
    response.labels = JSON.parse(record.labels) as Record<string, string>;
  }

  if (record.cors) {
    response.cors = JSON.parse(record.cors) as NonNullable<BucketResponse['cors']>;
  }

  if (record.lifecycle) {
    response.lifecycle = JSON.parse(record.lifecycle) as NonNullable<BucketResponse['lifecycle']>;
  }

  return response;
}

export function objectRecordToResponse(record: ObjectRecord): ObjectResponse {
  const response: ObjectResponse = {
    kind: 'storage#object',
    id: `${record.bucket}/${record.name}/${record.generation}`,
    selfLink: `https://www.googleapis.com/storage/v1/b/${record.bucket}/o/${encodeURIComponent(record.name)}`,
    mediaLink: `https://www.googleapis.com/download/storage/v1/b/${record.bucket}/o/${encodeURIComponent(record.name)}?generation=${record.generation}&alt=media`,
    name: record.name,
    bucket: record.bucket,
    generation: record.generation,
    metageneration: String(record.metageneration),
    contentType: record.contentType,
    storageClass: record.storageClass,
    size: String(record.size),
    md5Hash: record.md5Hash,
    crc32c: record.crc32c,
    etag: record.etag,
    timeCreated: record.timeCreated,
    updated: record.updated,
  };

  if (record.metadata) {
    response.metadata = JSON.parse(record.metadata) as Record<string, string>;
  }

  if (record.contentEncoding) {
    response.contentEncoding = record.contentEncoding;
  }

  if (record.contentDisposition) {
    response.contentDisposition = record.contentDisposition;
  }

  if (record.contentLanguage) {
    response.contentLanguage = record.contentLanguage;
  }

  if (record.cacheControl) {
    response.cacheControl = record.cacheControl;
  }

  return response;
}

export function notificationRecordToResponse(record: NotificationRecord): NotificationResponse {
  const response: NotificationResponse = {
    kind: 'storage#notification',
    id: record.id,
    selfLink: `https://www.googleapis.com/storage/v1/b/${record.bucket}/notificationConfigs/${record.id}`,
    topic: record.topic,
    etag: record.etag,
    payload_format: record.payloadFormat,
  };

  if (record.eventTypes) {
    const eventTypes = JSON.parse(record.eventTypes) as NotificationEventType[];

    if (eventTypes.length > 0) {
      response.event_types = eventTypes;
    }
  }

  if (record.objectNamePrefix) {
    response.object_name_prefix = record.objectNamePrefix;
  }

  if (record.customAttributes) {
    const customAttributes = JSON.parse(record.customAttributes) as Record<string, string>;

    if (Object.keys(customAttributes).length > 0) {
      response.custom_attributes = customAttributes;
    }
  }

  return response;
}

/**
 * Decimal form of the first 8 bytes of SHA-256(projectId), big-endian.
 *
 * Real GCS projectNumber is a uint64. The conversion is
 * BigInt("0x" + hex).toString(10), not Number. Number rounds integers above
 * 2^53-1, and the rounded value still matches /^\d+$/. toString(10) does not
 * pad leading zeros. Project id "my-project" (bytes 1c7cd944c28cd888) is
 * 2052754419519117448.
 */
export function projectNumberFromProjectId(projectId: string): string {
  const hex = new Bun.CryptoHasher('sha256').update(projectId).digest('hex').substring(0, 16);

  return BigInt(`0x${hex}`).toString(10);
}

export function requestToBucketRecord(
  name: string,
  body: CreateBucketRequest,
  project: string
): Omit<BucketRecord, keyof BaseRecord> {
  const now = new Date().toISOString();

  return {
    name,
    location: (body.location ?? DEFAULT_LOCATION).toUpperCase(),
    storageClass: body.storageClass ?? DEFAULT_STORAGE_CLASS,
    metageneration: 1,
    timeCreated: now,
    updated: now,
    versioning: body.versioning ? JSON.stringify(body.versioning) : null,
    labels: body.labels ? JSON.stringify(body.labels) : null,
    cors: body.cors ? JSON.stringify(body.cors) : null,
    lifecycle: body.lifecycle ? JSON.stringify(body.lifecycle) : null,
    projectId: project,
    projectNumber: projectNumberFromProjectId(project),
  };
}

export function requestToObjectRecord(
  bucket: string,
  name: string,
  data: {
    size: number;
    md5Hash: string;
    crc32c: string;
    blobPath: string;
    contentType?: string;
    metadata?: Record<string, string>;
    storageClass?: string;
    contentEncoding?: string;
    contentDisposition?: string;
    contentLanguage?: string;
    cacheControl?: string;
  }
): Omit<ObjectRecord, keyof BaseRecord> {
  const now = new Date().toISOString();
  const generation = String(Date.now() * 1000);

  return {
    bucket,
    name,
    generation,
    metageneration: 1,
    contentType: data.contentType ?? 'application/octet-stream',
    size: data.size,
    md5Hash: data.md5Hash,
    crc32c: data.crc32c,
    etag: `CL${generation}=`,
    storageClass: data.storageClass ?? DEFAULT_STORAGE_CLASS,
    timeCreated: now,
    updated: now,
    metadata: data.metadata ? JSON.stringify(data.metadata) : null,
    blobPath: data.blobPath,
    contentEncoding: data.contentEncoding ?? null,
    contentDisposition: data.contentDisposition ?? null,
    contentLanguage: data.contentLanguage ?? null,
    cacheControl: data.cacheControl ?? null,
  };
}

// ── HMAC keys ──

export const HMAC_KEYS_TABLE = 'storage_hmac_keys';

/**
 * Non-deleted HMAC keys allowed for one service account in a project.
 *
 * gsutil's integration suite uses 10 (`MAX_SA_HMAC_KEYS` in
 * `gslib/tests/test_hmac.py`). Deleted keys do not count.
 */
export const MAX_HMAC_KEYS_PER_SERVICE_ACCOUNT = 10;

/** Discovery default and cap for `hmacKeys.list` `maxResults`. */
const HMAC_LIST_MAX_RESULTS = 250;

export const HmacKeyState = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  DELETED: 'DELETED',
} as const;

export interface HmacKeyMetadata {
  kind: 'storage#hmacKeyMetadata';
  id: string;
  selfLink: string;
  accessId: string;
  projectId: string;
  serviceAccountEmail: string;
  state: string;
  timeCreated: string;
  updated: string;
  etag: string;
}

export interface HmacKey {
  kind: 'storage#hmacKey';
  metadata: HmacKeyMetadata;
  secret: string;
}

export interface HmacKeyList {
  kind: 'storage#hmacKeysMetadata';
  items: HmacKeyMetadata[];
  nextPageToken?: string;
}

export interface HmacKeyRecord extends BaseRecord {
  projectId: string;
  accessId: string;
  secret: string;
  serviceAccountEmail: string;
  state: string;
  etag: string;
  timeCreated: string;
  updated: string;
}

export const hmacKeysTableSchema: TableSchema = {
  name: HMAC_KEYS_TABLE,
  columns: [
    { name: 'projectId', type: 'string' },
    { name: 'accessId', type: 'string', unique: true },
    { name: 'secret', type: 'string' },
    { name: 'serviceAccountEmail', type: 'string' },
    { name: 'state', type: 'string' },
    { name: 'etag', type: 'string' },
    { name: 'timeCreated', type: 'string' },
    { name: 'updated', type: 'string' },
  ],
  indexes: [
    { name: 'idx_storage_hmac_keys_access', columns: ['accessId'], unique: true },
    { name: 'idx_storage_hmac_keys_project', columns: ['projectId', 'serviceAccountEmail'] },
  ],
  timestamps: true,
};

/**
 * `maxResults` is the caller's value or 250, whichever is smaller.
 * A missing or non-positive value uses the discovery default of 250.
 * `0` is not an empty page.
 */
export function resolveHmacPageSize(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) {
    return HMAC_LIST_MAX_RESULTS;
  }

  return Math.min(Math.floor(raw), HMAC_LIST_MAX_RESULTS);
}

export function hmacKeyRecordToMetadata(record: HmacKeyRecord): HmacKeyMetadata {
  return {
    kind: 'storage#hmacKeyMetadata',
    id: `${record.projectId}/${record.accessId}`,
    selfLink: `https://www.googleapis.com/storage/v1/projects/${record.projectId}/hmacKeys/${record.accessId}`,
    accessId: record.accessId,
    projectId: record.projectId,
    serviceAccountEmail: record.serviceAccountEmail,
    state: record.state,
    timeCreated: record.timeCreated,
    updated: record.updated,
    etag: record.etag,
  };
}
