/**
 * Tests for Secret Manager data models, schemas, and helper functions
 */

import { describe, expect, test } from 'bun:test';
import type { SecretRecord, SecretVersionRecord } from './types.ts';
import {
  AddSecretVersionRequestSchema,
  buildSecretName,
  buildSecretVersionName,
  CreateSecretRequestSchema,
  generateEtag,
  parseSecretName,
  parseSecretVersionName,
  SecretVersionState,
  secretRecordToResponse,
  secretVersionRecordToResponse,
} from './types.ts';

function makeSecretRecord(overrides: Partial<SecretRecord> = {}): SecretRecord {
  return {
    id: 'test-id',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    name: 'projects/my-project/secrets/my-secret',
    project: 'my-project',
    location: null,
    replication: JSON.stringify({ automatic: {} }),
    labels: JSON.stringify({}),
    annotations: JSON.stringify({}),
    expireTime: null,
    ttl: null,
    rotation: null,
    topics: null,
    versionAliases: JSON.stringify({}),
    versionDestroyTtl: null,
    etag: 'test-etag',
    nextVersionNumber: 1,
    ...overrides,
  };
}

function makeSecretVersionRecord(
  overrides: Partial<SecretVersionRecord> = {}
): SecretVersionRecord {
  return {
    id: 'test-id',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    name: 'projects/my-project/secrets/my-secret/versions/1',
    secretName: 'projects/my-project/secrets/my-secret',
    versionNumber: 1,
    state: SecretVersionState.ENABLED,
    etag: 'version-etag',
    encryptedPayload: null,
    iv: null,
    authTag: null,
    payloadCrc32c: null,
    destroyTime: null,
    scheduledDestroyTime: null,
    ...overrides,
  };
}

describe('parseSecretName', () => {
  test('should parse global secret name', () => {
    const result = parseSecretName('projects/my-project/secrets/my-secret');

    expect(result.project).toBe('my-project');
    expect(result.location).toBeNull();
    expect(result.secretId).toBe('my-secret');
  });

  test('should parse regional secret name', () => {
    const result = parseSecretName('projects/my-project/locations/us-central1/secrets/my-secret');

    expect(result.project).toBe('my-project');
    expect(result.location).toBe('us-central1');
    expect(result.secretId).toBe('my-secret');
  });

  test('should throw on invalid format', () => {
    expect(() => parseSecretName('invalid')).toThrow('Invalid secret resource name');
    expect(() => parseSecretName('projects//secrets/')).toThrow();
  });
});

describe('parseSecretVersionName', () => {
  test('should parse global version name', () => {
    const result = parseSecretVersionName('projects/my-project/secrets/my-secret/versions/1');

    expect(result.project).toBe('my-project');
    expect(result.location).toBeNull();
    expect(result.secretId).toBe('my-secret');
    expect(result.versionId).toBe('1');
  });

  test('should parse regional version name', () => {
    const result = parseSecretVersionName(
      'projects/my-project/locations/us-east1/secrets/my-secret/versions/3'
    );

    expect(result.project).toBe('my-project');
    expect(result.location).toBe('us-east1');
    expect(result.secretId).toBe('my-secret');
    expect(result.versionId).toBe('3');
  });

  test('should accept "latest" as version identifier', () => {
    const result = parseSecretVersionName('projects/my-project/secrets/my-secret/versions/latest');

    expect(result.versionId).toBe('latest');
  });

  test('should throw on invalid format', () => {
    expect(() => parseSecretVersionName('invalid')).toThrow('Invalid secret version resource name');
  });
});

describe('buildSecretName', () => {
  test('should build global secret name', () => {
    expect(buildSecretName('proj', 'sec')).toBe('projects/proj/secrets/sec');
  });

  test('should build regional secret name', () => {
    expect(buildSecretName('proj', 'sec', 'us-central1')).toBe(
      'projects/proj/locations/us-central1/secrets/sec'
    );
  });

  test('should round-trip with parseSecretName', () => {
    const name = buildSecretName('proj', 'sec', 'us-east1');
    const parsed = parseSecretName(name);

    expect(parsed.project).toBe('proj');
    expect(parsed.location).toBe('us-east1');
    expect(parsed.secretId).toBe('sec');
  });
});

describe('buildSecretVersionName', () => {
  test('should build version name from secret name and number', () => {
    expect(buildSecretVersionName('projects/proj/secrets/sec', 1)).toBe(
      'projects/proj/secrets/sec/versions/1'
    );
  });

  test('should build version name with string version id', () => {
    expect(buildSecretVersionName('projects/proj/secrets/sec', 'latest')).toBe(
      'projects/proj/secrets/sec/versions/latest'
    );
  });
});

describe('SecretVersionState', () => {
  test('should have ENABLED constant', () => {
    expect(SecretVersionState.ENABLED).toBe('ENABLED');
  });

  test('should have DISABLED constant', () => {
    expect(SecretVersionState.DISABLED).toBe('DISABLED');
  });

  test('should have DESTROYED constant', () => {
    expect(SecretVersionState.DESTROYED).toBe('DESTROYED');
  });
});

describe('CreateSecretRequestSchema', () => {
  test('should accept valid request with automatic replication', () => {
    const result = CreateSecretRequestSchema.safeParse({
      replication: { automatic: {} },
    });

    expect(result.success).toBe(true);
  });

  test('should accept optional labels and annotations', () => {
    const result = CreateSecretRequestSchema.safeParse({
      replication: { automatic: {} },
      labels: { env: 'test' },
      annotations: { note: 'hello' },
    });

    expect(result.success).toBe(true);
  });

  test('should reject missing replication', () => {
    const result = CreateSecretRequestSchema.safeParse({});

    expect(result.success).toBe(false);
  });

  test('should accept optional ttl and expireTime', () => {
    const result = CreateSecretRequestSchema.safeParse({
      replication: { automatic: {} },
      ttl: '86400s',
      expireTime: '2025-01-01T00:00:00Z',
    });

    expect(result.success).toBe(true);
  });
});

describe('AddSecretVersionRequestSchema', () => {
  test('should accept valid payload with data', () => {
    const result = AddSecretVersionRequestSchema.safeParse({
      payload: { data: btoa('my secret value') },
    });

    expect(result.success).toBe(true);
  });

  test('should reject missing payload', () => {
    const result = AddSecretVersionRequestSchema.safeParse({});

    expect(result.success).toBe(false);
  });

  test('should reject empty data', () => {
    const result = AddSecretVersionRequestSchema.safeParse({
      payload: { data: '' },
    });

    expect(result.success).toBe(false);
  });
});

describe('secretRecordToResponse', () => {
  test('should convert record to response with required fields', () => {
    const record = makeSecretRecord();
    const response = secretRecordToResponse(record);

    expect(response.name).toBe('projects/my-project/secrets/my-secret');
    expect(response.replication).toEqual({ automatic: {} });
    expect(response.createTime).toBe('2024-01-01T00:00:00.000Z');
    expect(response.etag).toBe('test-etag');
  });

  test('should include labels when non-empty', () => {
    const record = makeSecretRecord({ labels: JSON.stringify({ env: 'prod' }) });
    const response = secretRecordToResponse(record);

    expect(response.labels).toEqual({ env: 'prod' });
  });

  test('should omit labels when empty', () => {
    const record = makeSecretRecord();
    const response = secretRecordToResponse(record);

    expect(response.labels).toBeUndefined();
  });

  test('should omit null optional fields', () => {
    const record = makeSecretRecord();
    const response = secretRecordToResponse(record);

    expect(response.expireTime).toBeUndefined();
    expect(response.ttl).toBeUndefined();
    expect(response.rotation).toBeUndefined();
    expect(response.topics).toBeUndefined();
    expect(response.versionDestroyTtl).toBeUndefined();
  });
});

describe('secretVersionRecordToResponse', () => {
  test('should convert version record to response', () => {
    const record = makeSecretVersionRecord();
    const response = secretVersionRecordToResponse(record);

    expect(response.name).toBe('projects/my-project/secrets/my-secret/versions/1');
    expect(response.state).toBe('ENABLED');
    expect(response.etag).toBe('version-etag');
    expect(response.createTime).toBe('2024-01-01T00:00:00.000Z');
  });

  test('should include destroyTime only when DESTROYED', () => {
    const record = makeSecretVersionRecord({
      state: SecretVersionState.DESTROYED,
      destroyTime: '2024-06-01T00:00:00Z',
    });

    const response = secretVersionRecordToResponse(record);

    expect(response.destroyTime).toBe('2024-06-01T00:00:00Z');
  });

  test('should omit destroyTime when not DESTROYED', () => {
    const record = makeSecretVersionRecord({
      state: SecretVersionState.DISABLED,
      destroyTime: '2024-06-01T00:00:00Z',
    });

    const response = secretVersionRecordToResponse(record);

    expect(response.destroyTime).toBeUndefined();
  });
});

describe('generateEtag', () => {
  test('should return a non-empty string', () => {
    const etag = generateEtag();

    expect(etag).toBeTypeOf('string');
    expect(etag.length).toBeGreaterThan(0);
  });

  test('should return different values on each call', () => {
    const etag1 = generateEtag();
    const etag2 = generateEtag();

    expect(etag1).not.toBe(etag2);
  });
});
