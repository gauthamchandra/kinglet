/**
 * Tests for Cloud SQL types, schemas, and converters
 */

import { describe, expect, test } from 'bun:test';
import type { SqlInstanceRecord, SqlOperationRecord, SqlUserRecord } from './types.ts';
import {
  buildConnectionName,
  buildInstanceSelfLink,
  InsertInstanceRequestSchema,
  InsertUserRequestSchema,
  instanceRecordToResponse,
  operationRecordToResponse,
  userRecordToResponse,
} from './types.ts';

function makeInstanceRecord(overrides: Partial<SqlInstanceRecord> = {}): SqlInstanceRecord {
  return {
    id: 'rec-1',
    createdAt: new Date('2026-08-18T00:00:00Z'),
    updatedAt: new Date('2026-08-18T00:00:00Z'),
    project: 'test-project',
    name: 'my-instance',
    region: 'us-central1',
    databaseVersion: 'POSTGRES_16',
    state: 'RUNNABLE',
    settings: JSON.stringify({ tier: 'db-custom-1-3840' }),
    settingsVersion: 1,
    createTime: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('name helpers', () => {
  test('buildConnectionName joins project, region, and instance with colons', () => {
    expect(buildConnectionName('p1', 'us-east1', 'db1')).toBe('p1:us-east1:db1');
  });

  test('buildInstanceSelfLink produces the sqladmin v1 URL', () => {
    expect(buildInstanceSelfLink('p1', 'db1')).toBe(
      'https://sqladmin.googleapis.com/v1/projects/p1/instances/db1'
    );
  });
});

describe('InsertInstanceRequestSchema', () => {
  test('accepts a minimal valid Postgres instance request', () => {
    const parsed = InsertInstanceRequestSchema.safeParse({
      name: 'my-instance',
      databaseVersion: 'POSTGRES_16',
    });

    expect(parsed.success).toBe(true);
  });

  test('rejects an instance name starting with a digit', () => {
    const parsed = InsertInstanceRequestSchema.safeParse({
      name: '1bad',
      databaseVersion: 'POSTGRES_16',
    });

    expect(parsed.success).toBe(false);
  });

  test('rejects a missing databaseVersion', () => {
    const parsed = InsertInstanceRequestSchema.safeParse({ name: 'ok-name' });

    expect(parsed.success).toBe(false);
  });
});

describe('instanceRecordToResponse', () => {
  test('maps the record to a faithful sql#instance resource', () => {
    const response = instanceRecordToResponse(makeInstanceRecord());

    expect(response.kind).toBe('sql#instance');
    expect(response.name).toBe('my-instance');
    expect(response.project).toBe('test-project');
    expect(response.connectionName).toBe('test-project:us-central1:my-instance');
    expect(response.instanceType).toBe('CLOUD_SQL_INSTANCE');
    expect(response.backendType).toBe('SECOND_GEN');
    expect(response.ipAddresses).toEqual([{ type: 'PRIMARY', ipAddress: '127.0.0.1' }]);
    expect(response.settings).toEqual({
      kind: 'sql#settings',
      settingsVersion: 1,
      tier: 'db-custom-1-3840',
    });
    expect(response.etag).toBe('1');
  });
});

describe('userRecordToResponse', () => {
  test('omits the password from the response', () => {
    const record: SqlUserRecord = {
      id: 'rec-2',
      createdAt: new Date(),
      updatedAt: new Date(),
      project: 'test-project',
      instance: 'my-instance',
      name: 'app-user',
      host: '',
      type: 'BUILT_IN',
      password: 'secret',
    };

    const response = userRecordToResponse(record);

    expect(response.kind).toBe('sql#user');
    expect(response.name).toBe('app-user');
    expect(Object.keys(response)).not.toContain('password');
  });
});

describe('operationRecordToResponse', () => {
  test('maps a DONE operation with target links', () => {
    const record: SqlOperationRecord = {
      id: 'rec-3',
      createdAt: new Date(),
      updatedAt: new Date(),
      project: 'test-project',
      name: 'op-uuid-1',
      operationType: 'CREATE',
      status: 'DONE',
      targetId: 'my-instance',
      insertTime: '2026-08-18T00:00:00.000Z',
      startTime: '2026-08-18T00:00:00.000Z',
      endTime: '2026-08-18T00:00:01.000Z',
    };

    const response = operationRecordToResponse(record);

    expect(response.kind).toBe('sql#operation');
    expect(response.status).toBe('DONE');
    expect(response.operationType).toBe('CREATE');
    expect(response.targetProject).toBe('test-project');
    expect(response.targetLink).toBe(
      'https://sqladmin.googleapis.com/v1/projects/test-project/instances/my-instance'
    );
    expect(response.selfLink).toBe(
      'https://sqladmin.googleapis.com/v1/projects/test-project/operations/op-uuid-1'
    );
  });
});

describe('InsertUserRequestSchema', () => {
  test('defaults host and type when omitted', () => {
    const parsed = InsertUserRequestSchema.parse({ name: 'app-user' });

    expect(parsed.host).toBe('');
    expect(parsed.type).toBe('BUILT_IN');
  });
});
