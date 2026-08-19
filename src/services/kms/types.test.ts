/**
 * Tests for KMS types, schemas, name helpers, and enum normalization.
 */

import { describe, expect, test } from 'bun:test';
import type { CryptoKeyRecord, CryptoKeyVersionRecord } from './types.ts';
import {
  buildCryptoKeyName,
  buildCryptoKeyVersionName,
  buildKeyRingName,
  CreateCryptoKeyRequestSchema,
  CryptoKeyPurpose,
  CryptoKeyVersionAlgorithm,
  CryptoKeyVersionState,
  cryptoKeyRecordToResponse,
  cryptoKeyVersionRecordToResponse,
  DEFAULT_ALGORITHM_FOR_PURPOSE,
  DEFAULT_PROTECTION_LEVEL,
  keyRingRecordToResponse,
  normalizeAlgorithm,
  normalizeProtectionLevel,
  normalizePurpose,
  normalizeState,
  ProtectionLevel,
  parseKeyRingName,
  purposeUsesPrimaryVersion,
  UpdateCryptoKeyRequestSchema,
  UpdateCryptoKeyVersionRequestSchema,
} from './types.ts';

const CREATED_AT = new Date('2026-01-02T03:04:05.000Z');
const RING_NAME = 'projects/p/locations/us-central1/keyRings/r';
const KEY_NAME = `${RING_NAME}/cryptoKeys/k`;

function keyRecord(overrides: Partial<CryptoKeyRecord> = {}): CryptoKeyRecord {
  return {
    id: 'key-id',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    name: KEY_NAME,
    purpose: CryptoKeyPurpose.ENCRYPT_DECRYPT,
    protectionLevel: ProtectionLevel.SOFTWARE,
    algorithm: CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION,
    primaryVersion: null,
    labels: '{}',
    rotationPeriod: null,
    nextRotationTime: null,
    ...overrides,
  };
}

function versionRecord(overrides: Partial<CryptoKeyVersionRecord> = {}): CryptoKeyVersionRecord {
  return {
    id: 'version-id',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    name: `${KEY_NAME}/cryptoKeyVersions/1`,
    cryptoKeyName: KEY_NAME,
    versionNumber: 1,
    state: CryptoKeyVersionState.ENABLED,
    protectionLevel: ProtectionLevel.SOFTWARE,
    algorithm: CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION,
    keyMaterial: JSON.stringify({ secret: 'c2VjcmV0' }),
    generateTime: '2026-01-02T03:04:05.000Z',
    destroyTime: null,
    destroyEventTime: null,
    ...overrides,
  };
}

describe('resource names', () => {
  test('builds the hierarchical names GCP uses', () => {
    expect(buildKeyRingName('p', 'us-central1', 'r')).toBe(RING_NAME);
    expect(buildCryptoKeyName('p', 'us-central1', 'r', 'k')).toBe(KEY_NAME);
    expect(buildCryptoKeyVersionName(KEY_NAME, '2')).toBe(`${KEY_NAME}/cryptoKeyVersions/2`);
  });

  test('parses a key ring name', () => {
    expect(parseKeyRingName(RING_NAME)).toEqual({
      project: 'p',
      location: 'us-central1',
      keyRing: 'r',
    });
  });

  // An unanchored pattern would parse a child resource as its parent and 404 much later.
  test('rejects a child resource name as a key ring', () => {
    expect(() => parseKeyRingName(KEY_NAME)).toThrow(/Invalid key ring resource name/);
    expect(() => parseKeyRingName('projects/p/locations/us-central1')).toThrow(
      /Invalid key ring resource name/
    );
  });
});

describe('enum normalization', () => {
  // gapic REST clients request `enum-encoding=int`, so enums can arrive as integers.
  test('maps purpose integers and upper-cases strings', () => {
    expect(normalizePurpose(1)).toBe(CryptoKeyPurpose.ENCRYPT_DECRYPT);
    expect(normalizePurpose(5)).toBe(CryptoKeyPurpose.ASYMMETRIC_SIGN);
    expect(normalizePurpose(6)).toBe(CryptoKeyPurpose.ASYMMETRIC_DECRYPT);
    expect(normalizePurpose(9)).toBe(CryptoKeyPurpose.MAC);
    expect(normalizePurpose('mac')).toBe(CryptoKeyPurpose.MAC);
    expect(() => normalizePurpose(2)).toThrow(/Unsupported CryptoKeyPurpose/);
  });

  test('maps state integers and upper-cases strings', () => {
    expect(normalizeState(1)).toBe(CryptoKeyVersionState.ENABLED);
    expect(normalizeState(2)).toBe(CryptoKeyVersionState.DISABLED);
    expect(normalizeState(3)).toBe(CryptoKeyVersionState.DESTROYED);
    expect(normalizeState(4)).toBe(CryptoKeyVersionState.DESTROY_SCHEDULED);
    expect(normalizeState('disabled')).toBe(CryptoKeyVersionState.DISABLED);
    expect(() => normalizeState(99)).toThrow(/Unsupported CryptoKeyVersionState/);
  });

  test('maps protection level integers, including the ones the emulator refuses later', () => {
    expect(normalizeProtectionLevel(1)).toBe(ProtectionLevel.SOFTWARE);
    expect(normalizeProtectionLevel(2)).toBe(ProtectionLevel.HSM);
    expect(normalizeProtectionLevel(3)).toBe(ProtectionLevel.EXTERNAL);
    expect(normalizeProtectionLevel('software')).toBe(ProtectionLevel.SOFTWARE);
    expect(() => normalizeProtectionLevel(99)).toThrow(/Unsupported ProtectionLevel/);
  });

  test('maps algorithm integers and passes unknown ints through as decimal strings', () => {
    expect(normalizeAlgorithm(1)).toBe(CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION);
    expect(normalizeAlgorithm(12)).toBe(CryptoKeyVersionAlgorithm.EC_SIGN_P256_SHA256);
    expect(normalizeAlgorithm(32)).toBe(CryptoKeyVersionAlgorithm.HMAC_SHA256);
    expect(normalizeAlgorithm('ec_sign_p384_sha384')).toBe(
      CryptoKeyVersionAlgorithm.EC_SIGN_P384_SHA384
    );
    // Unknown ints must reach isSupportedAlgorithm rather than throw here.
    expect(normalizeAlgorithm(9999)).toBe('9999');
  });
});

describe('purpose defaults', () => {
  test('only symmetric encryption tracks a primary version', () => {
    expect(purposeUsesPrimaryVersion(CryptoKeyPurpose.ENCRYPT_DECRYPT)).toBe(true);
    expect(purposeUsesPrimaryVersion(CryptoKeyPurpose.ASYMMETRIC_SIGN)).toBe(false);
    expect(purposeUsesPrimaryVersion(CryptoKeyPurpose.MAC)).toBe(false);
  });

  test('every purpose has a default algorithm and SOFTWARE is the default level', () => {
    expect(DEFAULT_ALGORITHM_FOR_PURPOSE[CryptoKeyPurpose.ENCRYPT_DECRYPT]).toBe(
      CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION
    );
    expect(DEFAULT_ALGORITHM_FOR_PURPOSE[CryptoKeyPurpose.MAC]).toBe(
      CryptoKeyVersionAlgorithm.HMAC_SHA256
    );
    expect(DEFAULT_PROTECTION_LEVEL).toBe(ProtectionLevel.SOFTWARE);
  });
});

describe('request schemas', () => {
  test('accepts a create request with an integer-encoded purpose', () => {
    const parsed = CreateCryptoKeyRequestSchema.safeParse({
      purpose: 1,
      versionTemplate: { algorithm: 1, protectionLevel: 1 },
      labels: { env: 'test' },
    });

    expect(parsed.success).toBe(true);
  });

  // Requiredness of `purpose` is a service rule, not a schema one — the schema
  // only has to parse what the client sent.
  test('parses a create request with no purpose', () => {
    expect(CreateCryptoKeyRequestSchema.safeParse({}).success).toBe(true);
  });

  test('rejects an unparseable purpose', () => {
    expect(CreateCryptoKeyRequestSchema.safeParse({ purpose: 1.5 }).success).toBe(false);
    expect(CreateCryptoKeyRequestSchema.safeParse({ purpose: true }).success).toBe(false);
  });

  test('rejects labels that are not strings', () => {
    const parsed = UpdateCryptoKeyRequestSchema.safeParse({ labels: { env: 3 } });

    expect(parsed.success).toBe(false);
  });

  test('accepts a version state update', () => {
    expect(UpdateCryptoKeyVersionRequestSchema.safeParse({ state: 'DISABLED' }).success).toBe(true);
    expect(UpdateCryptoKeyVersionRequestSchema.safeParse({ state: 2 }).success).toBe(true);
  });
});

describe('record to response mapping', () => {
  test('maps a key ring', () => {
    expect(
      keyRingRecordToResponse({
        id: 'ring-id',
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        name: RING_NAME,
      })
    ).toEqual({ name: RING_NAME, createTime: '2026-01-02T03:04:05.000Z' });
  });

  test('omits absent optional version timestamps', () => {
    const response = cryptoKeyVersionRecordToResponse(versionRecord());

    expect(response).toEqual({
      name: `${KEY_NAME}/cryptoKeyVersions/1`,
      state: CryptoKeyVersionState.ENABLED,
      protectionLevel: ProtectionLevel.SOFTWARE,
      algorithm: CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION,
      createTime: '2026-01-02T03:04:05.000Z',
      generateTime: '2026-01-02T03:04:05.000Z',
    });
  });

  test('includes destroy timestamps once a version is scheduled for destruction', () => {
    const response = cryptoKeyVersionRecordToResponse(
      versionRecord({
        state: CryptoKeyVersionState.DESTROY_SCHEDULED,
        destroyTime: '2026-02-01T00:00:00.000Z',
        destroyEventTime: '2026-02-02T00:00:00.000Z',
      })
    );

    expect(response.destroyTime).toBe('2026-02-01T00:00:00.000Z');
    expect(response.destroyEventTime).toBe('2026-02-02T00:00:00.000Z');
  });

  test('never leaks key material', () => {
    expect(cryptoKeyVersionRecordToResponse(versionRecord())).not.toHaveProperty('keyMaterial');
    expect(JSON.stringify(cryptoKeyRecordToResponse(keyRecord()))).not.toContain('secret');
  });

  test('maps a crypto key, omitting empty labels and absent rotation fields', () => {
    expect(cryptoKeyRecordToResponse(keyRecord())).toEqual({
      name: KEY_NAME,
      purpose: CryptoKeyPurpose.ENCRYPT_DECRYPT,
      createTime: '2026-01-02T03:04:05.000Z',
      versionTemplate: {
        protectionLevel: ProtectionLevel.SOFTWARE,
        algorithm: CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION,
      },
    });
  });

  test('includes labels and rotation fields when set', () => {
    const response = cryptoKeyRecordToResponse(
      keyRecord({
        labels: JSON.stringify({ env: 'test' }),
        rotationPeriod: '7776000s',
        nextRotationTime: '2026-04-01T00:00:00.000Z',
      })
    );

    expect(response.labels).toEqual({ env: 'test' });
    expect(response.rotationPeriod).toBe('7776000s');
    expect(response.nextRotationTime).toBe('2026-04-01T00:00:00.000Z');
  });

  test('reports the primary version only for purposes that have one', () => {
    const primary = versionRecord();

    expect(cryptoKeyRecordToResponse(keyRecord(), primary).primary?.name).toBe(primary.name);
    expect(
      cryptoKeyRecordToResponse(keyRecord({ purpose: CryptoKeyPurpose.ASYMMETRIC_SIGN }), primary)
    ).not.toHaveProperty('primary');
  });
});
