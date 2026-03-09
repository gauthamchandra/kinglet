import { describe, expect, test } from 'bun:test';
import type { BaseRecord } from '@/core/storage/types.ts';
import type { BucketRecord, ObjectRecord } from './types.ts';
import {
  BUCKETS_TABLE,
  bucketRecordToResponse,
  ComposeRequestSchema,
  CreateBucketRequestSchema,
  DEFAULT_LOCATION,
  DEFAULT_STORAGE_CLASS,
  OBJECTS_TABLE,
  objectRecordToResponse,
  parseBucketName,
  parseObjectName,
  requestToBucketRecord,
  requestToObjectRecord,
  StorageClass,
  UpdateBucketRequestSchema,
} from './types.ts';

// ── Constants ──

describe('Constants', () => {
  test('table names are defined', () => {
    expect(BUCKETS_TABLE).toBe('storage_buckets');
    expect(OBJECTS_TABLE).toBe('storage_objects');
  });

  test('storage classes are defined', () => {
    expect(StorageClass.STANDARD).toBe('STANDARD');
    expect(StorageClass.NEARLINE).toBe('NEARLINE');
    expect(StorageClass.COLDLINE).toBe('COLDLINE');
    expect(StorageClass.ARCHIVE).toBe('ARCHIVE');
  });

  test('defaults are set', () => {
    expect(DEFAULT_STORAGE_CLASS).toBe('STANDARD');
    expect(DEFAULT_LOCATION).toBe('US');
  });
});

// ── parseBucketName ──

describe('parseBucketName', () => {
  test('accepts valid bucket names', () => {
    expect(parseBucketName('my-bucket')).toBe('my-bucket');
    expect(parseBucketName('my.bucket.name')).toBe('my.bucket.name');
    expect(parseBucketName('bucket123')).toBe('bucket123');
    expect(parseBucketName('ab')).toBe('ab');
  });

  test('rejects empty string', () => {
    expect(() => parseBucketName('')).toThrow('Bucket name cannot be empty');
  });

  test('rejects invalid characters', () => {
    expect(() => parseBucketName('My-Bucket')).toThrow('Invalid bucket name');
    expect(() => parseBucketName('bucket name')).toThrow('Invalid bucket name');
  });
});

// ── parseObjectName ──

describe('parseObjectName', () => {
  test('decodes URL-encoded names', () => {
    expect(parseObjectName('folder%2Fnested.txt')).toBe('folder/nested.txt');
  });

  test('passes through simple names', () => {
    expect(parseObjectName('test.txt')).toBe('test.txt');
  });

  test('handles nested paths', () => {
    expect(parseObjectName('a%2Fb%2Fc.txt')).toBe('a/b/c.txt');
  });
});

// ── Zod Schemas ──

describe('CreateBucketRequestSchema', () => {
  test('requires name', () => {
    const result = CreateBucketRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test('accepts valid request with name only', () => {
    const result = CreateBucketRequestSchema.safeParse({ name: 'my-bucket' });
    expect(result.success).toBe(true);
  });

  test('validates storageClass enum', () => {
    const result = CreateBucketRequestSchema.safeParse({
      name: 'my-bucket',
      storageClass: 'INVALID',
    });
    expect(result.success).toBe(false);
  });

  test('accepts optional fields', () => {
    const result = CreateBucketRequestSchema.safeParse({
      name: 'my-bucket',
      location: 'EU',
      storageClass: 'NEARLINE',
      labels: { env: 'test' },
      versioning: { enabled: true },
    });
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.location).toBe('EU');
      expect(result.data.storageClass).toBe('NEARLINE');
    }
  });
});

describe('UpdateBucketRequestSchema', () => {
  test('accepts partial updates', () => {
    const result = UpdateBucketRequestSchema.safeParse({ labels: { env: 'prod' } });
    expect(result.success).toBe(true);
  });

  test('accepts empty object', () => {
    const result = UpdateBucketRequestSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('ComposeRequestSchema', () => {
  test('requires at least 1 source object', () => {
    const result = ComposeRequestSchema.safeParse({ sourceObjects: [] });
    expect(result.success).toBe(false);
  });

  test('accepts up to 32 source objects', () => {
    const sources = Array.from({ length: 32 }, (_, i) => ({ name: `obj-${i}` }));
    const result = ComposeRequestSchema.safeParse({ sourceObjects: sources });
    expect(result.success).toBe(true);
  });

  test('rejects more than 32 source objects', () => {
    const sources = Array.from({ length: 33 }, (_, i) => ({ name: `obj-${i}` }));
    const result = ComposeRequestSchema.safeParse({ sourceObjects: sources });
    expect(result.success).toBe(false);
  });

  test('requires name on source objects', () => {
    const result = ComposeRequestSchema.safeParse({ sourceObjects: [{}] });
    expect(result.success).toBe(false);
  });
});

// ── Conversion Functions ──

describe('bucketRecordToResponse', () => {
  const baseFields: BaseRecord = {
    id: 'uuid-1',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };

  const record: BucketRecord = {
    ...baseFields,
    name: 'test-bucket',
    location: 'US',
    storageClass: 'STANDARD',
    metageneration: 2,
    timeCreated: '2024-01-01T00:00:00.000Z',
    updated: '2024-01-02T00:00:00.000Z',
    versioning: null,
    labels: JSON.stringify({ env: 'test' }),
    cors: null,
    lifecycle: null,
    projectNumber: '123456',
  };

  test('sets kind to storage#bucket', () => {
    const response = bucketRecordToResponse(record);
    expect(response.kind).toBe('storage#bucket');
  });

  test('includes selfLink', () => {
    const response = bucketRecordToResponse(record);
    expect(response.selfLink).toContain('/storage/v1/b/test-bucket');
  });

  test('converts metageneration to string', () => {
    const response = bucketRecordToResponse(record);
    expect(response.metageneration).toBe('2');
  });

  test('deserializes JSON fields', () => {
    const response = bucketRecordToResponse(record);
    expect(response.labels).toEqual({ env: 'test' });
  });

  test('omits null JSON fields', () => {
    const response = bucketRecordToResponse(record);
    expect(response.versioning).toBeUndefined();
    expect(response.cors).toBeUndefined();
    expect(response.lifecycle).toBeUndefined();
  });
});

describe('objectRecordToResponse', () => {
  const baseFields: BaseRecord = {
    id: 'uuid-2',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };

  const record: ObjectRecord = {
    ...baseFields,
    bucket: 'test-bucket',
    name: 'test.txt',
    generation: '1704067200000000',
    metageneration: 1,
    contentType: 'text/plain',
    size: 11,
    md5Hash: 'abc123==',
    crc32c: 'def456==',
    etag: 'CL1704067200000000=',
    storageClass: 'STANDARD',
    timeCreated: '2024-01-01T00:00:00.000Z',
    updated: '2024-01-01T00:00:00.000Z',
    metadata: JSON.stringify({ key: 'val' }),
    blobPath: '/tmp/blobs/test-bucket/hash-gen',
    contentEncoding: null,
    contentDisposition: null,
    contentLanguage: null,
    cacheControl: null,
  };

  test('sets kind to storage#object', () => {
    const response = objectRecordToResponse(record);
    expect(response.kind).toBe('storage#object');
  });

  test('includes selfLink and mediaLink', () => {
    const response = objectRecordToResponse(record);
    expect(response.selfLink).toContain('/storage/v1/b/test-bucket/o/test.txt');
    expect(response.mediaLink).toContain('alt=media');
  });

  test('converts generation and size to string', () => {
    const response = objectRecordToResponse(record);
    expect(response.generation).toBe('1704067200000000');
    expect(response.size).toBe('11');
  });

  test('includes hashes', () => {
    const response = objectRecordToResponse(record);
    expect(response.md5Hash).toBe('abc123==');
    expect(response.crc32c).toBe('def456==');
  });

  test('deserializes metadata', () => {
    const response = objectRecordToResponse(record);
    expect(response.metadata).toEqual({ key: 'val' });
  });

  test('omits null optional fields', () => {
    const response = objectRecordToResponse(record);
    expect(response.contentEncoding).toBeUndefined();
    expect(response.contentDisposition).toBeUndefined();
  });
});

describe('requestToBucketRecord', () => {
  test('applies defaults', () => {
    const record = requestToBucketRecord('my-bucket', { name: 'my-bucket' }, 'proj-123');
    expect(record.location).toBe('US');
    expect(record.storageClass).toBe('STANDARD');
    expect(record.metageneration).toBe(1);
    expect(record.projectNumber).toBe('proj-123');
  });

  test('uses custom values', () => {
    const record = requestToBucketRecord(
      'my-bucket',
      { name: 'my-bucket', location: 'eu', storageClass: 'NEARLINE' },
      'proj-123'
    );
    expect(record.location).toBe('EU');
    expect(record.storageClass).toBe('NEARLINE');
  });

  test('serializes complex fields as JSON', () => {
    const record = requestToBucketRecord(
      'my-bucket',
      { name: 'my-bucket', labels: { env: 'test' } },
      'proj-123'
    );
    expect(record.labels).toBe('{"env":"test"}');
  });

  test('sets timestamps', () => {
    const record = requestToBucketRecord('my-bucket', { name: 'my-bucket' }, 'proj-123');
    expect(record.timeCreated).toBeTypeOf('string');
    expect(record.updated).toBeTypeOf('string');
  });
});

describe('requestToObjectRecord', () => {
  test('creates record with generation and metageneration', () => {
    const record = requestToObjectRecord('bucket', 'obj.txt', {
      size: 100,
      md5Hash: 'hash==',
      crc32c: 'crc==',
      blobPath: '/tmp/blob',
    });
    expect(record.generation).toBeTypeOf('string');
    expect(record.metageneration).toBe(1);
    expect(record.size).toBe(100);
    expect(record.contentType).toBe('application/octet-stream');
  });

  test('uses provided contentType', () => {
    const record = requestToObjectRecord('bucket', 'obj.txt', {
      size: 100,
      md5Hash: 'hash==',
      crc32c: 'crc==',
      blobPath: '/tmp/blob',
      contentType: 'text/plain',
    });
    expect(record.contentType).toBe('text/plain');
  });

  test('serializes metadata as JSON', () => {
    const record = requestToObjectRecord('bucket', 'obj.txt', {
      size: 10,
      md5Hash: 'h',
      crc32c: 'c',
      blobPath: '/tmp/b',
      metadata: { key: 'val' },
    });
    expect(record.metadata).toBe('{"key":"val"}');
  });

  test('sets hashes from input', () => {
    const record = requestToObjectRecord('bucket', 'obj.txt', {
      size: 10,
      md5Hash: 'abc==',
      crc32c: 'def==',
      blobPath: '/tmp/b',
    });
    expect(record.md5Hash).toBe('abc==');
    expect(record.crc32c).toBe('def==');
  });
});
