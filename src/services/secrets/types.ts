/**
 * Secret Manager data models, schemas, and helper functions
 */

import { z } from 'zod';
import type { BaseRecord, TableSchema } from '@/core/storage/types.ts';

// ── Constants ──

export const SECRETS_TABLE = 'secrets';
export const SECRET_VERSIONS_TABLE = 'secret_versions';

export const SecretVersionState = {
  ENABLED: 'ENABLED',
  DISABLED: 'DISABLED',
  DESTROYED: 'DESTROYED',
} as const;

// ── Storage Records ──

export interface SecretRecord extends BaseRecord {
  name: string;
  project: string;
  location: string | null;
  replication: string; // JSON-serialized
  labels: string; // JSON-serialized
  annotations: string; // JSON-serialized
  expireTime: string | null;
  ttl: string | null;
  rotation: string | null; // JSON-serialized
  topics: string | null; // JSON-serialized
  versionAliases: string; // JSON-serialized
  versionDestroyTtl: string | null;
  etag: string;
  nextVersionNumber: number;
}

export interface SecretVersionRecord extends BaseRecord {
  name: string;
  secretName: string;
  versionNumber: number;
  state: string;
  etag: string;
  encryptedPayload: string | null; // base64
  iv: string | null; // base64
  authTag: string | null; // base64
  payloadCrc32c: string | null;
  destroyTime: string | null;
  scheduledDestroyTime: string | null;
}

// ── Table Schemas ──

export const secretsTableSchema: TableSchema = {
  name: SECRETS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'project', type: 'string' },
    { name: 'location', type: 'string', nullable: true },
    { name: 'replication', type: 'json' },
    { name: 'labels', type: 'json' },
    { name: 'annotations', type: 'json' },
    { name: 'expireTime', type: 'string', nullable: true },
    { name: 'ttl', type: 'string', nullable: true },
    { name: 'rotation', type: 'json', nullable: true },
    { name: 'topics', type: 'json', nullable: true },
    { name: 'versionAliases', type: 'json' },
    { name: 'versionDestroyTtl', type: 'string', nullable: true },
    { name: 'etag', type: 'string' },
    { name: 'nextVersionNumber', type: 'number' },
  ],
  indexes: [
    { name: 'idx_secrets_name', columns: ['name'], unique: true },
    { name: 'idx_secrets_project', columns: ['project'] },
  ],
  timestamps: true,
};

export const secretVersionsTableSchema: TableSchema = {
  name: SECRET_VERSIONS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'secretName', type: 'string' },
    { name: 'versionNumber', type: 'number' },
    { name: 'state', type: 'string' },
    { name: 'etag', type: 'string' },
    { name: 'encryptedPayload', type: 'string', nullable: true },
    { name: 'iv', type: 'string', nullable: true },
    { name: 'authTag', type: 'string', nullable: true },
    { name: 'payloadCrc32c', type: 'string', nullable: true },
    { name: 'destroyTime', type: 'string', nullable: true },
    { name: 'scheduledDestroyTime', type: 'string', nullable: true },
  ],
  indexes: [
    { name: 'idx_secret_versions_name', columns: ['name'], unique: true },
    { name: 'idx_secret_versions_secret_name', columns: ['secretName'] },
    { name: 'idx_secret_versions_composite', columns: ['secretName', 'versionNumber'] },
  ],
  timestamps: true,
};

// ── Zod Schemas ──

const ReplicationSchema = z.object({
  automatic: z.object({}).optional(),
  userManaged: z
    .object({
      replicas: z.array(
        z.object({
          location: z.string(),
          customerManagedEncryption: z
            .object({
              kmsKeyName: z.string(),
            })
            .optional(),
        })
      ),
    })
    .optional(),
});

export const CreateSecretRequestSchema = z.object({
  replication: ReplicationSchema,
  labels: z.record(z.string(), z.string()).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
  ttl: z.string().optional(),
  expireTime: z.string().optional(),
  rotation: z
    .object({
      nextRotationTime: z.string().optional(),
      rotationPeriod: z.string().optional(),
    })
    .optional(),
  topics: z
    .array(
      z.object({
        name: z.string(),
      })
    )
    .optional(),
  versionDestroyTtl: z.string().optional(),
  versionAliases: z.record(z.string(), z.string()).optional(),
});

export const PatchSecretRequestSchema = z.object({
  labels: z.record(z.string(), z.string()).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
  ttl: z.string().optional(),
  expireTime: z.string().optional(),
  rotation: z
    .object({
      nextRotationTime: z.string().optional(),
      rotationPeriod: z.string().optional(),
    })
    .optional(),
  topics: z
    .array(
      z.object({
        name: z.string(),
      })
    )
    .optional(),
  versionDestroyTtl: z.string().optional(),
  versionAliases: z.record(z.string(), z.string()).optional(),
  etag: z.string().optional(),
});

export const AddSecretVersionRequestSchema = z.object({
  payload: z.object({
    data: z.string().min(1),
    dataCrc32c: z.string().optional(),
  }),
});

// ── Response Interfaces ──

export interface SecretResponse {
  name: string;
  replication: unknown;
  createTime: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  expireTime?: string;
  ttl?: string;
  rotation?: unknown;
  topics?: unknown[];
  versionAliases?: Record<string, string>;
  versionDestroyTtl?: string;
  etag: string;
}

export interface SecretVersionResponse {
  name: string;
  createTime: string;
  state: string;
  etag: string;
  destroyTime?: string;
  scheduledDestroyTime?: string;
  clientSpecifiedPayloadChecksum?: boolean;
  replicationStatus?: unknown;
}

export interface AccessSecretVersionResponse {
  name: string;
  payload: {
    data: string;
    dataCrc32c?: string;
  };
}

export interface ListSecretsResponse {
  secrets: SecretResponse[];
  nextPageToken?: string | undefined;
  totalSize: number;
}

export interface ListSecretVersionsResponse {
  versions: SecretVersionResponse[];
  nextPageToken?: string | undefined;
  totalSize: number;
}

// ── Helper Functions ──

export function parseSecretName(name: string): {
  project: string;
  location: string | null;
  secretId: string;
} {
  const regionalMatch = name.match(/^projects\/([^/]+)\/locations\/([^/]+)\/secrets\/([^/]+)$/);

  if (regionalMatch) {
    return {
      project: regionalMatch[1] as string,
      location: regionalMatch[2] as string,
      secretId: regionalMatch[3] as string,
    };
  }

  const globalMatch = name.match(/^projects\/([^/]+)\/secrets\/([^/]+)$/);

  if (globalMatch) {
    return {
      project: globalMatch[1] as string,
      location: null,
      secretId: globalMatch[2] as string,
    };
  }

  throw new Error(
    `Invalid secret resource name: "${name}". Expected format: projects/{project}/secrets/{secretId} or projects/{project}/locations/{location}/secrets/{secretId}`
  );
}

export function parseSecretVersionName(name: string): {
  project: string;
  location: string | null;
  secretId: string;
  versionId: string;
} {
  const regionalMatch = name.match(
    /^projects\/([^/]+)\/locations\/([^/]+)\/secrets\/([^/]+)\/versions\/([^/]+)$/
  );

  if (regionalMatch) {
    return {
      project: regionalMatch[1] as string,
      location: regionalMatch[2] as string,
      secretId: regionalMatch[3] as string,
      versionId: regionalMatch[4] as string,
    };
  }

  const globalMatch = name.match(/^projects\/([^/]+)\/secrets\/([^/]+)\/versions\/([^/]+)$/);

  if (globalMatch) {
    return {
      project: globalMatch[1] as string,
      location: null,
      secretId: globalMatch[2] as string,
      versionId: globalMatch[3] as string,
    };
  }

  throw new Error(
    `Invalid secret version resource name: "${name}". Expected format: projects/{project}/secrets/{secretId}/versions/{versionId}`
  );
}

export function buildSecretName(
  project: string,
  secretId: string,
  location?: string | null
): string {
  if (location) {
    return `projects/${project}/locations/${location}/secrets/${secretId}`;
  }

  return `projects/${project}/secrets/${secretId}`;
}

export function buildSecretVersionName(secretName: string, versionId: string | number): string {
  return `${secretName}/versions/${versionId}`;
}

export function generateEtag(): string {
  const bytes = new Uint8Array(12);

  crypto.getRandomValues(bytes);

  return Buffer.from(bytes).toString('base64url');
}

// ── Conversion Functions ──

export function secretRecordToResponse(record: SecretRecord): SecretResponse {
  const response: SecretResponse = {
    name: record.name,
    replication: JSON.parse(record.replication),
    createTime:
      record.createdAt instanceof Date ? record.createdAt.toISOString() : String(record.createdAt),
    etag: record.etag,
  };

  const labels = JSON.parse(record.labels) as Record<string, string>;

  if (Object.keys(labels).length > 0) {
    response.labels = labels;
  }

  const annotations = JSON.parse(record.annotations) as Record<string, string>;

  if (Object.keys(annotations).length > 0) {
    response.annotations = annotations;
  }

  if (record.expireTime) {
    response.expireTime = record.expireTime;
  }

  if (record.ttl) {
    response.ttl = record.ttl;
  }

  if (record.rotation) {
    response.rotation = JSON.parse(record.rotation);
  }

  if (record.topics) {
    response.topics = JSON.parse(record.topics) as unknown[];
  }

  const versionAliases = JSON.parse(record.versionAliases) as Record<string, string>;

  if (Object.keys(versionAliases).length > 0) {
    response.versionAliases = versionAliases;
  }

  if (record.versionDestroyTtl) {
    response.versionDestroyTtl = record.versionDestroyTtl;
  }

  return response;
}

export function secretVersionRecordToResponse(
  record: SecretVersionRecord,
  replicationStatus?: unknown
): SecretVersionResponse {
  const response: SecretVersionResponse = {
    name: record.name,
    createTime:
      record.createdAt instanceof Date ? record.createdAt.toISOString() : String(record.createdAt),
    state: record.state,
    etag: record.etag,
  };

  if (record.state === SecretVersionState.DESTROYED && record.destroyTime) {
    response.destroyTime = record.destroyTime;
  }

  if (record.scheduledDestroyTime) {
    response.scheduledDestroyTime = record.scheduledDestroyTime;
  }

  if (record.payloadCrc32c) {
    response.clientSpecifiedPayloadChecksum = true;
  }

  if (replicationStatus) {
    response.replicationStatus = replicationStatus;
  }

  return response;
}
