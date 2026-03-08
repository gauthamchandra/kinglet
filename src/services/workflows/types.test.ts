/**
 * Cloud Workflows Types - Unit Tests
 */

import { describe, expect, test } from 'bun:test';
import type { BaseRecord } from '@/core/storage/types.ts';
import type { OperationRecord, WorkflowRecord, WorkflowRevisionRecord } from './types.ts';
import {
  buildOperationName,
  buildWorkflowName,
  CallLogLevel,
  CreateWorkflowRequestSchema,
  ExecutionHistoryLevel,
  generateRevisionId,
  operationRecordToResponse,
  parseWorkflowName,
  requestToWorkflowRecord,
  revisionRecordToResponse,
  UpdateWorkflowRequestSchema,
  WorkflowState,
  workflowRecordToResponse,
} from './types.ts';

// ── Resource Name Helpers ──

describe('parseWorkflowName', () => {
  test('parses a valid workflow resource name', () => {
    const result = parseWorkflowName(
      'projects/my-project/locations/us-central1/workflows/my-workflow'
    );

    expect(result).toEqual({
      project: 'my-project',
      location: 'us-central1',
      workflowId: 'my-workflow',
    });
  });

  test('throws for invalid format', () => {
    expect(() => parseWorkflowName('invalid/name')).toThrow('Invalid workflow resource name');
  });

  test('throws for empty string', () => {
    expect(() => parseWorkflowName('')).toThrow('Invalid workflow resource name');
  });

  test('throws for missing segments', () => {
    expect(() => parseWorkflowName('projects/my-project/locations/us-central1')).toThrow(
      'Invalid workflow resource name'
    );
  });
});

describe('buildWorkflowName', () => {
  test('builds a valid workflow resource name', () => {
    const result = buildWorkflowName('my-project', 'us-central1', 'my-workflow');

    expect(result).toBe('projects/my-project/locations/us-central1/workflows/my-workflow');
  });
});

describe('buildOperationName', () => {
  test('builds a valid operation resource name', () => {
    const result = buildOperationName('my-project', 'us-central1', 'op-123');

    expect(result).toBe('projects/my-project/locations/us-central1/operations/op-123');
  });
});

// ── Revision ID Generation ──

describe('generateRevisionId', () => {
  test('generates ID with zero-padded ordinal', () => {
    const id = generateRevisionId(1);

    expect(id).toMatch(/^000001-[0-9a-f]{3}$/);
  });

  test('generates ID for larger ordinals', () => {
    const id = generateRevisionId(42);

    expect(id).toMatch(/^000042-[0-9a-f]{3}$/);
  });

  test('generates unique IDs for same ordinal', () => {
    const ids = new Set<string>();

    for (let i = 0; i < 20; i++) {
      ids.add(generateRevisionId(1));
    }

    // With 3 hex chars (4096 possibilities), 20 iterations should produce at least 2 unique
    expect(ids.size).toBeGreaterThanOrEqual(2);
  });
});

// ── Zod Schemas ──

describe('CreateWorkflowRequestSchema', () => {
  test('validates a minimal valid request', () => {
    const result = CreateWorkflowRequestSchema.safeParse({
      sourceContents: 'main:\n  steps:\n    - step1:\n        return: "hello"',
    });

    expect(result.success).toBe(true);
  });

  test('validates a full request with all optional fields', () => {
    const result = CreateWorkflowRequestSchema.safeParse({
      sourceContents: 'main:\n  steps: []',
      description: 'Test workflow',
      labels: { env: 'test' },
      serviceAccount: 'sa@project.iam.gserviceaccount.com',
      cryptoKeyName: 'projects/p/locations/l/keyRings/kr/cryptoKeys/k',
      callLogLevel: 'LOG_ALL_CALLS',
      userEnvVars: { MY_VAR: 'value' },
    });

    expect(result.success).toBe(true);
  });

  test('rejects request without sourceContents', () => {
    const result = CreateWorkflowRequestSchema.safeParse({
      description: 'Missing source',
    });

    expect(result.success).toBe(false);
  });

  test('rejects empty sourceContents', () => {
    const result = CreateWorkflowRequestSchema.safeParse({
      sourceContents: '',
    });

    expect(result.success).toBe(false);
  });

  test('rejects invalid callLogLevel', () => {
    const result = CreateWorkflowRequestSchema.safeParse({
      sourceContents: 'main: {}',
      callLogLevel: 'INVALID_LEVEL',
    });

    expect(result.success).toBe(false);
  });

  test('validates executionHistoryLevel enum values', () => {
    const valid = CreateWorkflowRequestSchema.safeParse({
      sourceContents: 'main: {}',
      executionHistoryLevel: 'EXECUTION_HISTORY_DETAILED',
    });

    expect(valid.success).toBe(true);

    const invalid = CreateWorkflowRequestSchema.safeParse({
      sourceContents: 'main: {}',
      executionHistoryLevel: 'INVALID',
    });

    expect(invalid.success).toBe(false);
  });

  test('validates tags as map of strings', () => {
    const valid = CreateWorkflowRequestSchema.safeParse({
      sourceContents: 'main: {}',
      tags: { team: 'backend', env: 'dev' },
    });

    expect(valid.success).toBe(true);
  });
});

describe('UpdateWorkflowRequestSchema', () => {
  test('validates partial update with only sourceContents', () => {
    const result = UpdateWorkflowRequestSchema.safeParse({
      sourceContents: 'updated: true',
    });

    expect(result.success).toBe(true);
  });

  test('validates partial update with only description', () => {
    const result = UpdateWorkflowRequestSchema.safeParse({
      description: 'Updated description',
    });

    expect(result.success).toBe(true);
  });

  test('validates empty update (all fields optional)', () => {
    const result = UpdateWorkflowRequestSchema.safeParse({});

    expect(result.success).toBe(true);
  });
});

// ── Conversion Functions ──

describe('workflowRecordToResponse', () => {
  const baseRecord: Pick<BaseRecord, 'id' | 'createdAt' | 'updatedAt'> = {
    id: 'rec-1',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
  };

  test('converts a minimal workflow record', () => {
    const record: WorkflowRecord = {
      ...baseRecord,
      name: 'projects/p/locations/l/workflows/w',
      description: '',
      state: WorkflowState.ACTIVE,
      revisionId: '000001-abc',
      revisionCreateTime: '2024-01-01T00:00:00.000Z',
      labels: '{}',
      serviceAccount: '',
      sourceContents: 'main: {}',
      cryptoKeyName: null,
      stateError: null,
      callLogLevel: CallLogLevel.CALL_LOG_LEVEL_UNSPECIFIED,
      userEnvVars: null,
      executionHistoryLevel: ExecutionHistoryLevel.EXECUTION_HISTORY_LEVEL_UNSPECIFIED,
      tags: null,
    };

    const response = workflowRecordToResponse(record);

    expect(response.name).toBe('projects/p/locations/l/workflows/w');
    expect(response.state).toBe('ACTIVE');
    expect(response.revisionId).toBe('000001-abc');
    expect(response.createTime).toBe('2024-01-01T00:00:00.000Z');
    expect(response.updateTime).toBe('2024-01-02T00:00:00.000Z');
    expect(response.labels).toEqual({});
    expect(response.sourceContents).toBe('main: {}');
    expect(response.cryptoKeyName).toBeUndefined();
    expect(response.stateError).toBeUndefined();
    expect(response.callLogLevel).toBeUndefined();
    expect(response.userEnvVars).toBeUndefined();
    expect(response.executionHistoryLevel).toBeUndefined();
    expect(response.tags).toBeUndefined();
    expect(response.allKmsKeys).toBeUndefined();
    expect(response.allKmsKeysVersions).toEqual([]);
    expect(response.cryptoKeyVersion).toBe('');
  });

  test('includes optional fields when present', () => {
    const record: WorkflowRecord = {
      ...baseRecord,
      name: 'projects/p/locations/l/workflows/w',
      description: 'desc',
      state: WorkflowState.ACTIVE,
      revisionId: '000001-abc',
      revisionCreateTime: '2024-01-01T00:00:00.000Z',
      labels: '{"env":"prod"}',
      serviceAccount: 'sa@p.iam.gserviceaccount.com',
      sourceContents: 'main: {}',
      cryptoKeyName: 'projects/p/locations/l/keyRings/kr/cryptoKeys/k',
      stateError: '{"details":"some error","type":"KMS_ERROR"}',
      callLogLevel: CallLogLevel.LOG_ALL_CALLS,
      userEnvVars: '{"MY_VAR":"value"}',
      executionHistoryLevel: ExecutionHistoryLevel.EXECUTION_HISTORY_DETAILED,
      tags: '{"team":"backend"}',
    };

    const response = workflowRecordToResponse(record);

    expect(response.labels).toEqual({ env: 'prod' });
    expect(response.cryptoKeyName).toBe('projects/p/locations/l/keyRings/kr/cryptoKeys/k');
    expect(response.stateError).toEqual({
      details: 'some error',
      type: 'KMS_ERROR',
    });
    expect(response.callLogLevel).toBe('LOG_ALL_CALLS');
    expect(response.userEnvVars).toEqual({ MY_VAR: 'value' });
    expect(response.executionHistoryLevel).toBe('EXECUTION_HISTORY_DETAILED');
    expect(response.tags).toEqual({ team: 'backend' });
    expect(response.allKmsKeys).toEqual(['projects/p/locations/l/keyRings/kr/cryptoKeys/k']);
    expect(response.allKmsKeysVersions).toEqual([]);
    expect(response.cryptoKeyVersion).toBe('');
  });
});

describe('revisionRecordToResponse', () => {
  test('converts a revision record with original createTime', () => {
    const record: WorkflowRevisionRecord = {
      id: 'rev-1',
      createdAt: new Date('2024-01-05T00:00:00Z'),
      updatedAt: new Date('2024-01-05T00:00:00Z'),
      workflowName: 'projects/p/locations/l/workflows/w',
      revisionId: '000002-def',
      description: 'rev desc',
      state: WorkflowState.ACTIVE,
      revisionCreateTime: '2024-01-05T00:00:00.000Z',
      labels: '{}',
      serviceAccount: 'sa@p.iam.gserviceaccount.com',
      sourceContents: 'updated: true',
      cryptoKeyName: null,
      stateError: null,
      callLogLevel: CallLogLevel.CALL_LOG_LEVEL_UNSPECIFIED,
      userEnvVars: null,
      executionHistoryLevel: ExecutionHistoryLevel.EXECUTION_HISTORY_LEVEL_UNSPECIFIED,
      tags: null,
    };

    const originalCreatedAt = new Date('2024-01-01T00:00:00Z');
    const response = revisionRecordToResponse(record, originalCreatedAt);

    expect(response.name).toBe('projects/p/locations/l/workflows/w');
    expect(response.revisionId).toBe('000002-def');
    expect(response.createTime).toBe('2024-01-01T00:00:00.000Z');
    expect(response.updateTime).toBe('2024-01-05T00:00:00.000Z');
    expect(response.allKmsKeysVersions).toEqual([]);
    expect(response.cryptoKeyVersion).toBe('');
  });
});

describe('requestToWorkflowRecord', () => {
  test('converts a create request to a record', () => {
    const record = requestToWorkflowRecord(
      'projects/p/locations/l/workflows/w',
      { sourceContents: 'main: {}' },
      '000001-abc'
    );

    expect(record.name).toBe('projects/p/locations/l/workflows/w');
    expect(record.description).toBe('');
    expect(record.state).toBe('ACTIVE');
    expect(record.revisionId).toBe('000001-abc');
    expect(record.labels).toBe('{}');
    expect(record.serviceAccount).toBe('');
    expect(record.sourceContents).toBe('main: {}');
    expect(record.cryptoKeyName).toBeNull();
    expect(record.stateError).toBeNull();
    expect(record.callLogLevel).toBe('CALL_LOG_LEVEL_UNSPECIFIED');
    expect(record.userEnvVars).toBeNull();
    expect(record.executionHistoryLevel).toBe('EXECUTION_HISTORY_LEVEL_UNSPECIFIED');
    expect(record.tags).toBeNull();
  });

  test('converts a full create request with all optional fields', () => {
    const record = requestToWorkflowRecord(
      'projects/p/locations/l/workflows/w',
      {
        sourceContents: 'main: {}',
        description: 'Test',
        labels: { env: 'test' },
        serviceAccount: 'sa@p.iam.gserviceaccount.com',
        cryptoKeyName: 'key-name',
        callLogLevel: 'LOG_ALL_CALLS',
        userEnvVars: { VAR: 'val' },
        executionHistoryLevel: 'EXECUTION_HISTORY_DETAILED',
        tags: { team: 'backend' },
      },
      '000001-abc'
    );

    expect(record.description).toBe('Test');
    expect(record.labels).toBe('{"env":"test"}');
    expect(record.serviceAccount).toBe('sa@p.iam.gserviceaccount.com');
    expect(record.cryptoKeyName).toBe('key-name');
    expect(record.callLogLevel).toBe('LOG_ALL_CALLS');
    expect(record.userEnvVars).toBe('{"VAR":"val"}');
    expect(record.executionHistoryLevel).toBe('EXECUTION_HISTORY_DETAILED');
    expect(record.tags).toBe('{"team":"backend"}');
  });
});

describe('operationRecordToResponse', () => {
  test('converts a completed operation record with @type annotations', () => {
    const record: OperationRecord = {
      id: 'op-rec-1',
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z'),
      name: 'projects/p/locations/l/operations/op-1',
      metadata: JSON.stringify({
        createTime: '2024-01-01T00:00:00.000Z',
        endTime: '2024-01-01T00:00:00.000Z',
        target: 'projects/p/locations/l/workflows/w',
        verb: 'create',
        apiVersion: 'v1',
      }),
      done: 1,
      response: JSON.stringify({ name: 'projects/p/locations/l/workflows/w' }),
      error: null,
    };

    const response = operationRecordToResponse(record);

    expect(response.name).toBe('projects/p/locations/l/operations/op-1');
    expect(response.done).toBe(true);
    expect(response.metadata['@type']).toBe(
      'type.googleapis.com/google.cloud.workflows.v1.OperationMetadata'
    );
    expect(response.metadata.verb).toBe('create');
    expect(response.metadata.apiVersion).toBe('v1');
    expect(response.response).toEqual({
      '@type': 'type.googleapis.com/google.cloud.workflows.v1.Workflow',
      name: 'projects/p/locations/l/workflows/w',
    });
    expect(response.error).toBeUndefined();
  });

  test('converts an operation record with error', () => {
    const record: OperationRecord = {
      id: 'op-rec-2',
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z'),
      name: 'projects/p/locations/l/operations/op-2',
      metadata: JSON.stringify({
        createTime: '2024-01-01T00:00:00.000Z',
        endTime: '2024-01-01T00:00:00.000Z',
        target: 'projects/p/locations/l/workflows/w',
        verb: 'delete',
        apiVersion: 'v1',
      }),
      done: 1,
      response: null,
      error: JSON.stringify({ code: 5, message: 'Not found' }),
    };

    const response = operationRecordToResponse(record);

    expect(response.done).toBe(true);
    expect(response.metadata['@type']).toBe(
      'type.googleapis.com/google.cloud.workflows.v1.OperationMetadata'
    );
    expect(response.response).toBeUndefined();
    expect(response.error).toEqual({ code: 5, message: 'Not found' });
  });
});
