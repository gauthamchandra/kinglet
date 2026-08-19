/**
 * Cloud KMS data models, schemas, and helper functions.
 *
 * Resource hierarchy mirrors the real Cloud KMS v1 REST API:
 *   projects/{p}/locations/{l}/keyRings/{r}/cryptoKeys/{k}/cryptoKeyVersions/{v}
 */

import { z } from 'zod';
import type { BaseRecord, TableSchema } from '@/core/storage/types.ts';

// ── Table names ──

export const KMS_KEY_RINGS_TABLE = 'kms_key_rings';
export const KMS_CRYPTO_KEYS_TABLE = 'kms_crypto_keys';
export const KMS_CRYPTO_KEY_VERSIONS_TABLE = 'kms_crypto_key_versions';

// ── Enums (proto3 JSON string forms) ──

export const CryptoKeyPurpose = {
  ENCRYPT_DECRYPT: 'ENCRYPT_DECRYPT',
  ASYMMETRIC_SIGN: 'ASYMMETRIC_SIGN',
  ASYMMETRIC_DECRYPT: 'ASYMMETRIC_DECRYPT',
  MAC: 'MAC',
} as const;

export type CryptoKeyPurposeValue = (typeof CryptoKeyPurpose)[keyof typeof CryptoKeyPurpose];

export const CryptoKeyVersionState = {
  ENABLED: 'ENABLED',
  DISABLED: 'DISABLED',
  DESTROYED: 'DESTROYED',
  DESTROY_SCHEDULED: 'DESTROY_SCHEDULED',
} as const;

export type CryptoKeyVersionStateValue =
  (typeof CryptoKeyVersionState)[keyof typeof CryptoKeyVersionState];

export const ProtectionLevel = {
  SOFTWARE: 'SOFTWARE',
  HSM: 'HSM',
  EXTERNAL: 'EXTERNAL',
} as const;

/**
 * The subset of CryptoKeyVersionAlgorithm values this emulator can perform real
 * cryptographic operations for. Unsupported algorithms are rejected at create
 * time rather than silently accepted.
 */
export const CryptoKeyVersionAlgorithm = {
  GOOGLE_SYMMETRIC_ENCRYPTION: 'GOOGLE_SYMMETRIC_ENCRYPTION',
  RSA_SIGN_PKCS1_2048_SHA256: 'RSA_SIGN_PKCS1_2048_SHA256',
  RSA_SIGN_PKCS1_3072_SHA256: 'RSA_SIGN_PKCS1_3072_SHA256',
  RSA_SIGN_PKCS1_4096_SHA256: 'RSA_SIGN_PKCS1_4096_SHA256',
  RSA_SIGN_PSS_2048_SHA256: 'RSA_SIGN_PSS_2048_SHA256',
  RSA_SIGN_PSS_3072_SHA256: 'RSA_SIGN_PSS_3072_SHA256',
  RSA_SIGN_PSS_4096_SHA256: 'RSA_SIGN_PSS_4096_SHA256',
  EC_SIGN_P256_SHA256: 'EC_SIGN_P256_SHA256',
  EC_SIGN_P384_SHA384: 'EC_SIGN_P384_SHA384',
  RSA_DECRYPT_OAEP_2048_SHA256: 'RSA_DECRYPT_OAEP_2048_SHA256',
  RSA_DECRYPT_OAEP_3072_SHA256: 'RSA_DECRYPT_OAEP_3072_SHA256',
  RSA_DECRYPT_OAEP_4096_SHA256: 'RSA_DECRYPT_OAEP_4096_SHA256',
  HMAC_SHA256: 'HMAC_SHA256',
} as const;

export type CryptoKeyVersionAlgorithmValue =
  (typeof CryptoKeyVersionAlgorithm)[keyof typeof CryptoKeyVersionAlgorithm];

export const DEFAULT_PROTECTION_LEVEL = ProtectionLevel.SOFTWARE;

export const DEFAULT_ALGORITHM_FOR_PURPOSE: Record<
  CryptoKeyPurposeValue,
  CryptoKeyVersionAlgorithmValue
> = {
  ENCRYPT_DECRYPT: CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION,
  ASYMMETRIC_SIGN: CryptoKeyVersionAlgorithm.EC_SIGN_P256_SHA256,
  ASYMMETRIC_DECRYPT: CryptoKeyVersionAlgorithm.RSA_DECRYPT_OAEP_2048_SHA256,
  MAC: CryptoKeyVersionAlgorithm.HMAC_SHA256,
};

/** Purposes whose key-level operations route through a designated primary version. */
export function purposeUsesPrimaryVersion(purpose: string): boolean {
  return purpose === CryptoKeyPurpose.ENCRYPT_DECRYPT;
}

// ── Wire-shape interfaces (REST/JSON responses) ──

export interface VersionTemplate {
  protectionLevel: string;
  algorithm: string;
}

export interface KeyRingResponse {
  name: string;
  createTime: string;
}

export interface CryptoKeyVersionResponse {
  name: string;
  state: string;
  protectionLevel: string;
  algorithm: string;
  createTime: string;
  generateTime?: string;
  destroyTime?: string;
  destroyEventTime?: string;
}

export interface CryptoKeyResponse {
  name: string;
  purpose: string;
  createTime: string;
  versionTemplate: VersionTemplate;
  labels?: Record<string, string>;
  rotationPeriod?: string;
  nextRotationTime?: string;
  primary?: CryptoKeyVersionResponse;
}

// ── Storage records ──

export interface KeyRingRecord extends BaseRecord {
  name: string;
}

export interface CryptoKeyRecord extends BaseRecord {
  name: string;
  purpose: string;
  protectionLevel: string;
  algorithm: string;
  primaryVersion: string | null; // version id, e.g. "1"
  labels: string; // JSON-serialized Record<string,string>
  rotationPeriod: string | null;
  nextRotationTime: string | null;
}

export interface CryptoKeyVersionRecord extends BaseRecord {
  name: string;
  cryptoKeyName: string;
  versionNumber: number; // numeric version id, for correct (non-lexicographic) ordering
  state: string;
  protectionLevel: string;
  algorithm: string;
  /**
   * JSON-serialized secret key material, never exposed in API responses.
   * Symmetric/MAC: { secret: base64 }. Asymmetric: { privateKeyPem, publicKeyPem }.
   */
  keyMaterial: string;
  generateTime: string | null;
  destroyTime: string | null;
  destroyEventTime: string | null;
}

// ── Table schemas ──

export const kmsKeyRingsTableSchema: TableSchema = {
  name: KMS_KEY_RINGS_TABLE,
  columns: [{ name: 'name', type: 'string', unique: true }],
  indexes: [{ name: 'idx_kms_key_rings_name', columns: ['name'], unique: true }],
  timestamps: true,
};

export const kmsCryptoKeysTableSchema: TableSchema = {
  name: KMS_CRYPTO_KEYS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'purpose', type: 'string' },
    { name: 'protectionLevel', type: 'string' },
    { name: 'algorithm', type: 'string' },
    { name: 'primaryVersion', type: 'string', nullable: true },
    { name: 'labels', type: 'json' },
    { name: 'rotationPeriod', type: 'string', nullable: true },
    { name: 'nextRotationTime', type: 'string', nullable: true },
  ],
  indexes: [
    { name: 'idx_kms_crypto_keys_name', columns: ['name'], unique: true },
    { name: 'idx_kms_crypto_keys_purpose', columns: ['purpose'] },
  ],
  timestamps: true,
};

export const kmsCryptoKeyVersionsTableSchema: TableSchema = {
  name: KMS_CRYPTO_KEY_VERSIONS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'cryptoKeyName', type: 'string' },
    { name: 'versionNumber', type: 'number' },
    { name: 'state', type: 'string' },
    { name: 'protectionLevel', type: 'string' },
    { name: 'algorithm', type: 'string' },
    { name: 'keyMaterial', type: 'json' },
    { name: 'generateTime', type: 'string', nullable: true },
    { name: 'destroyTime', type: 'string', nullable: true },
    { name: 'destroyEventTime', type: 'string', nullable: true },
  ],
  indexes: [
    { name: 'idx_kms_crypto_key_versions_name', columns: ['name'], unique: true },
    { name: 'idx_kms_crypto_key_versions_parent', columns: ['cryptoKeyName'] },
  ],
  timestamps: true,
};

// ── Enum normalization (clients may send proto enum integers or strings) ──

const PURPOSE_INT_MAP: Record<number, CryptoKeyPurposeValue> = {
  1: CryptoKeyPurpose.ENCRYPT_DECRYPT,
  5: CryptoKeyPurpose.ASYMMETRIC_SIGN,
  6: CryptoKeyPurpose.ASYMMETRIC_DECRYPT,
  9: CryptoKeyPurpose.MAC,
};

export function normalizePurpose(value: string | number): string {
  if (typeof value === 'number') {
    const purpose = PURPOSE_INT_MAP[value];

    if (purpose == null) {
      throw new Error(`Unsupported CryptoKeyPurpose enum value: ${value}`);
    }

    return purpose;
  }

  return value.toUpperCase();
}

const STATE_INT_MAP: Record<number, CryptoKeyVersionStateValue> = {
  1: CryptoKeyVersionState.ENABLED,
  2: CryptoKeyVersionState.DISABLED,
  3: CryptoKeyVersionState.DESTROYED,
  4: CryptoKeyVersionState.DESTROY_SCHEDULED,
};

export function normalizeState(value: string | number): string {
  if (typeof value === 'number') {
    const state = STATE_INT_MAP[value];

    if (state == null) {
      throw new Error(`Unsupported CryptoKeyVersionState enum value: ${value}`);
    }

    return state;
  }

  return value.toUpperCase();
}

const PROTECTION_LEVEL_INT_MAP: Record<number, string> = {
  1: ProtectionLevel.SOFTWARE,
  2: ProtectionLevel.HSM,
  3: ProtectionLevel.EXTERNAL,
};

export function normalizeProtectionLevel(value: string | number): string {
  if (typeof value === 'number') {
    const level = PROTECTION_LEVEL_INT_MAP[value];

    if (level == null) {
      throw new Error(`Unsupported ProtectionLevel enum value: ${value}`);
    }

    return level;
  }

  return value.toUpperCase();
}

// Proto enum integer values for CryptoKeyVersionAlgorithm. gapic REST clients
// request `enum-encoding=int`, so algorithm fields can arrive as integers.
const ALGORITHM_INT_MAP: Record<number, string> = {
  1: CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION,
  2: CryptoKeyVersionAlgorithm.RSA_SIGN_PSS_2048_SHA256,
  3: CryptoKeyVersionAlgorithm.RSA_SIGN_PSS_3072_SHA256,
  4: CryptoKeyVersionAlgorithm.RSA_SIGN_PSS_4096_SHA256,
  5: CryptoKeyVersionAlgorithm.RSA_SIGN_PKCS1_2048_SHA256,
  6: CryptoKeyVersionAlgorithm.RSA_SIGN_PKCS1_3072_SHA256,
  7: CryptoKeyVersionAlgorithm.RSA_SIGN_PKCS1_4096_SHA256,
  8: CryptoKeyVersionAlgorithm.RSA_DECRYPT_OAEP_2048_SHA256,
  9: CryptoKeyVersionAlgorithm.RSA_DECRYPT_OAEP_3072_SHA256,
  10: CryptoKeyVersionAlgorithm.RSA_DECRYPT_OAEP_4096_SHA256,
  12: CryptoKeyVersionAlgorithm.EC_SIGN_P256_SHA256,
  13: CryptoKeyVersionAlgorithm.EC_SIGN_P384_SHA384,
  32: CryptoKeyVersionAlgorithm.HMAC_SHA256,
};

export function normalizeAlgorithm(value: string | number): string {
  if (typeof value === 'number') {
    // Unknown ints fall through as their decimal string and fail the later
    // isSupportedAlgorithm check, surfacing a clean INVALID_ARGUMENT.
    return ALGORITHM_INT_MAP[value] ?? String(value);
  }

  return value.toUpperCase();
}

// ── Zod request schemas ──

const enumOrInt = z.union([z.string(), z.number().int()]);

const VersionTemplateSchema = z.object({
  protectionLevel: enumOrInt.optional(),
  algorithm: enumOrInt,
});

export const CreateCryptoKeyRequestSchema = z.object({
  purpose: enumOrInt.optional(),
  versionTemplate: VersionTemplateSchema.optional(),
  labels: z.record(z.string(), z.string()).optional(),
  rotationPeriod: z.string().optional(),
  nextRotationTime: z.string().optional(),
});

export const UpdateCryptoKeyRequestSchema = z.object({
  versionTemplate: VersionTemplateSchema.optional(),
  labels: z.record(z.string(), z.string()).optional(),
  rotationPeriod: z.string().optional(),
  nextRotationTime: z.string().optional(),
  primary: z.object({ name: z.string() }).optional(),
});

export const UpdateCryptoKeyVersionRequestSchema = z.object({
  state: enumOrInt.optional(),
});

// ── Name parse/build helpers ──

export function buildKeyRingName(project: string, location: string, keyRing: string): string {
  return `projects/${project}/locations/${location}/keyRings/${keyRing}`;
}

export function parseKeyRingName(name: string): {
  project: string;
  location: string;
  keyRing: string;
} {
  const match = name.match(/^projects\/([^/]+)\/locations\/([^/]+)\/keyRings\/([^/]+)$/);

  if (!match) {
    throw new Error(`Invalid key ring resource name: "${name}"`);
  }

  return {
    project: match[1] as string,
    location: match[2] as string,
    keyRing: match[3] as string,
  };
}

export function buildCryptoKeyName(
  project: string,
  location: string,
  keyRing: string,
  cryptoKey: string
): string {
  return `${buildKeyRingName(project, location, keyRing)}/cryptoKeys/${cryptoKey}`;
}

export function buildCryptoKeyVersionName(cryptoKeyName: string, versionId: string): string {
  return `${cryptoKeyName}/cryptoKeyVersions/${versionId}`;
}

// ── Conversion functions ──

export function keyRingRecordToResponse(record: KeyRingRecord): KeyRingResponse {
  return {
    name: record.name,
    createTime: new Date(record.createdAt).toISOString(),
  };
}

export function cryptoKeyVersionRecordToResponse(
  record: CryptoKeyVersionRecord
): CryptoKeyVersionResponse {
  const response: CryptoKeyVersionResponse = {
    name: record.name,
    state: record.state,
    protectionLevel: record.protectionLevel,
    algorithm: record.algorithm,
    createTime: new Date(record.createdAt).toISOString(),
  };

  if (record.generateTime) {
    response.generateTime = record.generateTime;
  }

  if (record.destroyTime) {
    response.destroyTime = record.destroyTime;
  }

  if (record.destroyEventTime) {
    response.destroyEventTime = record.destroyEventTime;
  }

  return response;
}

export function cryptoKeyRecordToResponse(
  record: CryptoKeyRecord,
  primaryVersion?: CryptoKeyVersionRecord | null
): CryptoKeyResponse {
  const response: CryptoKeyResponse = {
    name: record.name,
    purpose: record.purpose,
    createTime: new Date(record.createdAt).toISOString(),
    versionTemplate: {
      protectionLevel: record.protectionLevel,
      algorithm: record.algorithm,
    },
  };

  const labels = JSON.parse(record.labels) as Record<string, string>;

  if (Object.keys(labels).length > 0) {
    response.labels = labels;
  }

  if (record.rotationPeriod) {
    response.rotationPeriod = record.rotationPeriod;
  }

  if (record.nextRotationTime) {
    response.nextRotationTime = record.nextRotationTime;
  }

  if (primaryVersion && purposeUsesPrimaryVersion(record.purpose)) {
    response.primary = cryptoKeyVersionRecordToResponse(primaryVersion);
  }

  return response;
}
