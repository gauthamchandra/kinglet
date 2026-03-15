/**
 * Unit tests for Pub/Sub types, helpers, and Zod schemas
 */

import { describe, expect, test } from 'bun:test';
import type { BaseRecord } from '@/core/storage/types.ts';
import type { SchemaRecord, TopicRecord } from './types.ts';
import {
  buildSchemaName,
  buildSnapshotName,
  buildSubscriptionName,
  buildTopicName,
  PubSubError,
  parseSchemaName,
  parseSnapshotName,
  parseSubscriptionName,
  parseTopicName,
  schemaRecordToResponse,
  topicRecordToResponse,
} from './types.ts';

// ── Resource Name Helpers ──

describe('parseTopicName', () => {
  test('parses a valid topic name', () => {
    const result = parseTopicName('projects/my-project/topics/my-topic');

    expect(result.project).toBe('my-project');
    expect(result.topic).toBe('my-topic');
  });

  test('throws on invalid format', () => {
    expect(() => parseTopicName('invalid')).toThrow();
    expect(() => parseTopicName('projects/p/locations/l/topics/t')).toThrow();
    expect(() => parseTopicName('')).toThrow();
  });
});

describe('buildTopicName', () => {
  test('builds a valid topic name', () => {
    expect(buildTopicName('my-project', 'my-topic')).toBe('projects/my-project/topics/my-topic');
  });
});

describe('parseSubscriptionName', () => {
  test('parses a valid subscription name', () => {
    const result = parseSubscriptionName('projects/my-project/subscriptions/my-sub');

    expect(result.project).toBe('my-project');
    expect(result.subscription).toBe('my-sub');
  });

  test('throws on invalid format', () => {
    expect(() => parseSubscriptionName('invalid')).toThrow();
    expect(() => parseSubscriptionName('projects/p/topics/t')).toThrow();
    expect(() => parseSubscriptionName('')).toThrow();
  });
});

describe('buildSubscriptionName', () => {
  test('builds a valid subscription name', () => {
    expect(buildSubscriptionName('my-project', 'my-sub')).toBe(
      'projects/my-project/subscriptions/my-sub'
    );
  });
});

describe('parseSnapshotName', () => {
  test('parses a valid snapshot name', () => {
    const result = parseSnapshotName('projects/my-project/snapshots/my-snap');

    expect(result.project).toBe('my-project');
    expect(result.snapshot).toBe('my-snap');
  });

  test('throws on invalid format', () => {
    expect(() => parseSnapshotName('invalid')).toThrow();
    expect(() => parseSnapshotName('')).toThrow();
  });
});

describe('buildSnapshotName', () => {
  test('builds a valid snapshot name', () => {
    expect(buildSnapshotName('my-project', 'my-snap')).toBe(
      'projects/my-project/snapshots/my-snap'
    );
  });
});

// ── Schema Resource Name Helpers ──

describe('parseSchemaName', () => {
  test('parses a valid schema name', () => {
    const result = parseSchemaName('projects/my-project/schemas/my-schema');

    expect(result.project).toBe('my-project');
    expect(result.schema).toBe('my-schema');
  });

  test('throws on invalid format', () => {
    expect(() => parseSchemaName('invalid')).toThrow();
    expect(() => parseSchemaName('projects/p/topics/t')).toThrow();
    expect(() => parseSchemaName('')).toThrow();
  });
});

describe('buildSchemaName', () => {
  test('builds a valid schema name', () => {
    expect(buildSchemaName('my-project', 'my-schema')).toBe(
      'projects/my-project/schemas/my-schema'
    );
  });
});

// ── Schema Record to Response Conversion ──

describe('schemaRecordToResponse', () => {
  const baseRecord: BaseRecord = {
    id: 'test-id',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };

  test('converts a schema record to response', () => {
    const record: SchemaRecord = {
      ...baseRecord,
      name: 'projects/p/schemas/s',
      type: 'AVRO',
      definition: '{"type":"record","name":"Test"}',
      revisionId: 'rev-1',
      revisionCreateTime: '2024-01-01T00:00:00.000Z',
    };

    const response = schemaRecordToResponse(record);

    expect(response.name).toBe('projects/p/schemas/s');
    expect(response.type).toBe('AVRO');
    expect(response.definition).toBe('{"type":"record","name":"Test"}');
    expect(response.revisionId).toBe('rev-1');
    expect(response.revisionCreateTime).toBe('2024-01-01T00:00:00.000Z');
  });

  test('omits definition when null', () => {
    const record: SchemaRecord = {
      ...baseRecord,
      name: 'projects/p/schemas/s',
      type: 'PROTOCOL_BUFFER',
      definition: null,
      revisionId: 'rev-1',
      revisionCreateTime: '2024-01-01T00:00:00.000Z',
    };

    const response = schemaRecordToResponse(record);

    expect(response.name).toBe('projects/p/schemas/s');
    expect(response.type).toBe('PROTOCOL_BUFFER');
    expect(response.definition).toBeUndefined();
  });
});

// ── Record to Response Conversion ──

describe('topicRecordToResponse', () => {
  const baseRecord: BaseRecord = {
    id: 'test-id',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };

  test('converts a minimal topic record', () => {
    const record: TopicRecord = {
      ...baseRecord,
      name: 'projects/p/topics/t',
      labels: null,
      messageRetentionDuration: null,
      kmsKeyName: null,
      schemaSettings: null,
      satisfiesPzs: null,
      messageStoragePolicy: null,
      ingestionDataSourceSettings: null,
      state: 'ACTIVE',
    };

    const response = topicRecordToResponse(record);

    expect(response.name).toBe('projects/p/topics/t');
    expect(response.state).toBe('ACTIVE');
  });

  test('converts a topic record with labels', () => {
    const record: TopicRecord = {
      ...baseRecord,
      name: 'projects/p/topics/t',
      labels: JSON.stringify({ env: 'test' }),
      messageRetentionDuration: '604800s',
      kmsKeyName: null,
      schemaSettings: null,
      satisfiesPzs: null,
      messageStoragePolicy: null,
      ingestionDataSourceSettings: null,
      state: 'ACTIVE',
    };

    const response = topicRecordToResponse(record);

    expect(response.labels).toEqual({ env: 'test' });
    expect(response.messageRetentionDuration).toBe('604800s');
  });
});

// ── PubSubError ──

describe('PubSubError', () => {
  test('creates error with code and message', () => {
    const err = new PubSubError('NOT_FOUND', 'Topic not found');

    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('Topic not found');
  });

  test('supports all error codes', () => {
    expect(new PubSubError('ALREADY_EXISTS', 'exists').code).toBe('ALREADY_EXISTS');
    expect(new PubSubError('INVALID_ARGUMENT', 'bad').code).toBe('INVALID_ARGUMENT');
    expect(new PubSubError('FAILED_PRECONDITION', 'fail').code).toBe('FAILED_PRECONDITION');
  });
});
