/**
 * Workflow Repository - Unit Tests
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { WorkflowRepository } from './repository.ts';
import type { WorkflowRecord, WorkflowRevisionRecord } from './types.ts';

let storage: StorageManager;
let repo: WorkflowRepository;

const baseWorkflowData: Omit<WorkflowRecord, keyof BaseRecord> = {
  name: 'projects/test-project/locations/us-central1/workflows/test-workflow',
  description: 'Test workflow',
  state: 'ACTIVE',
  revisionId: '000001-abc',
  revisionCreateTime: '2024-01-01T00:00:00.000Z',
  labels: '{}',
  serviceAccount: 'sa@test.iam.gserviceaccount.com',
  sourceContents: 'main:\n  steps: []',
  cryptoKeyName: null,
  stateError: null,
  callLogLevel: 'CALL_LOG_LEVEL_UNSPECIFIED',
  userEnvVars: null,
  executionHistoryLevel: 'EXECUTION_HISTORY_LEVEL_UNSPECIFIED',
  tags: null,
};

const baseRevisionData: Omit<WorkflowRevisionRecord, keyof BaseRecord> = {
  workflowName: 'projects/test-project/locations/us-central1/workflows/test-workflow',
  revisionId: '000001-abc',
  description: 'Test workflow',
  state: 'ACTIVE',
  revisionCreateTime: '2024-01-01T00:00:00.000Z',
  labels: '{}',
  serviceAccount: 'sa@test.iam.gserviceaccount.com',
  sourceContents: 'main:\n  steps: []',
  cryptoKeyName: null,
  stateError: null,
  callLogLevel: 'CALL_LOG_LEVEL_UNSPECIFIED',
  userEnvVars: null,
  executionHistoryLevel: 'EXECUTION_HISTORY_LEVEL_UNSPECIFIED',
  tags: null,
};

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });
  repo = new WorkflowRepository(storage);
  await repo.initialize();
});

describe('initialize', () => {
  test('creates tables without error', async () => {
    const newStorage = new StorageManager();
    await newStorage.initialize({ type: 'memory' });

    const newRepo = new WorkflowRepository(newStorage);
    await newRepo.initialize();

    // Verify we can perform operations after initialization
    const result = await newRepo.listWorkflows('p', 'l');

    expect(result.workflows).toEqual([]);
  });
});

describe('createWorkflow', () => {
  test('creates a workflow and returns it with base record fields', async () => {
    const created = await repo.createWorkflow(baseWorkflowData);

    expect(created.name).toBe(baseWorkflowData.name);
    expect(created.description).toBe('Test workflow');
    expect(created.state).toBe('ACTIVE');
    expect(created.revisionId).toBe('000001-abc');
    expect(created.id).toBeTypeOf('string');
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
  });

  test('enforces uniqueness on workflow name', async () => {
    await repo.createWorkflow(baseWorkflowData);

    const promise = repo.createWorkflow(baseWorkflowData);

    await expect(promise).rejects.toThrow('already exists');
  });
});

describe('createRevision', () => {
  test('creates a revision record', async () => {
    const created = await repo.createRevision(baseRevisionData);

    expect(created.workflowName).toBe(baseRevisionData.workflowName);
    expect(created.revisionId).toBe('000001-abc');
    expect(created.id).toBeTypeOf('string');
  });
});

describe('getWorkflowByName', () => {
  test('returns workflow when found', async () => {
    await repo.createWorkflow(baseWorkflowData);

    const found = await repo.getWorkflowByName(baseWorkflowData.name);

    expect(found).not.toBeNull();
    expect(found?.name).toBe(baseWorkflowData.name);
  });

  test('returns null when not found', async () => {
    const found = await repo.getWorkflowByName('projects/p/locations/l/workflows/nonexistent');

    expect(found).toBeNull();
  });
});

describe('getWorkflowRevision', () => {
  test('returns revision when found', async () => {
    await repo.createRevision(baseRevisionData);

    const found = await repo.getWorkflowRevision(baseRevisionData.workflowName, '000001-abc');

    expect(found).not.toBeNull();
    expect(found?.revisionId).toBe('000001-abc');
  });

  test('returns null when revision not found', async () => {
    const found = await repo.getWorkflowRevision(baseRevisionData.workflowName, 'nonexistent');

    expect(found).toBeNull();
  });
});

describe('listWorkflows', () => {
  test('returns empty list when no workflows exist', async () => {
    const result = await repo.listWorkflows('test-project', 'us-central1');

    expect(result.workflows).toEqual([]);
    expect(result.nextPageToken).toBeUndefined();
  });

  test('returns workflows matching project and location', async () => {
    await repo.createWorkflow(baseWorkflowData);
    await repo.createWorkflow({
      ...baseWorkflowData,
      name: 'projects/test-project/locations/us-central1/workflows/second-workflow',
    });
    await repo.createWorkflow({
      ...baseWorkflowData,
      name: 'projects/other-project/locations/us-central1/workflows/other-workflow',
    });

    const result = await repo.listWorkflows('test-project', 'us-central1');

    expect(result.workflows).toHaveLength(2);
  });

  test('paginates results correctly', async () => {
    await repo.createWorkflow({
      ...baseWorkflowData,
      name: 'projects/p/locations/l/workflows/a',
    });
    await repo.createWorkflow({
      ...baseWorkflowData,
      name: 'projects/p/locations/l/workflows/b',
    });
    await repo.createWorkflow({
      ...baseWorkflowData,
      name: 'projects/p/locations/l/workflows/c',
    });

    const page1 = await repo.listWorkflows('p', 'l', 2);

    expect(page1.workflows).toHaveLength(2);
    expect(page1.nextPageToken).toBeDefined();

    const page2 = await repo.listWorkflows('p', 'l', 2, page1.nextPageToken);

    expect(page2.workflows).toHaveLength(1);
    expect(page2.nextPageToken).toBeUndefined();
  });
});

describe('listRevisions', () => {
  test('returns revisions in reverse chronological order', async () => {
    await repo.createRevision({
      ...baseRevisionData,
      revisionId: '000001-aaa',
      revisionCreateTime: '2024-01-01T00:00:00.000Z',
    });
    await repo.createRevision({
      ...baseRevisionData,
      revisionId: '000002-bbb',
      revisionCreateTime: '2024-01-02T00:00:00.000Z',
    });

    const result = await repo.listRevisions(baseRevisionData.workflowName);

    expect(result.revisions).toHaveLength(2);
    expect(result.revisions[0]?.revisionId).toBe('000002-bbb');
    expect(result.revisions[1]?.revisionId).toBe('000001-aaa');
  });

  test('paginates revisions', async () => {
    await repo.createRevision({
      ...baseRevisionData,
      revisionId: '000001-aaa',
      revisionCreateTime: '2024-01-01T00:00:00.000Z',
    });
    await repo.createRevision({
      ...baseRevisionData,
      revisionId: '000002-bbb',
      revisionCreateTime: '2024-01-02T00:00:00.000Z',
    });
    await repo.createRevision({
      ...baseRevisionData,
      revisionId: '000003-ccc',
      revisionCreateTime: '2024-01-03T00:00:00.000Z',
    });

    const page1 = await repo.listRevisions(baseRevisionData.workflowName, 2);

    expect(page1.revisions).toHaveLength(2);
    expect(page1.nextPageToken).toBeDefined();

    const page2 = await repo.listRevisions(baseRevisionData.workflowName, 2, page1.nextPageToken);

    expect(page2.revisions).toHaveLength(1);
    expect(page2.nextPageToken).toBeUndefined();
  });
});

describe('updateWorkflow', () => {
  test('updates workflow fields', async () => {
    await repo.createWorkflow(baseWorkflowData);

    const updated = await repo.updateWorkflow(baseWorkflowData.name, {
      description: 'Updated description',
      revisionId: '000002-def',
    });

    expect(updated).not.toBeNull();
    expect(updated?.description).toBe('Updated description');
    expect(updated?.revisionId).toBe('000002-def');
  });

  test('returns null when workflow not found', async () => {
    const result = await repo.updateWorkflow('projects/p/locations/l/workflows/nonexistent', {
      description: 'test',
    });

    expect(result).toBeNull();
  });
});

describe('deleteWorkflow', () => {
  test('deletes workflow and its revisions', async () => {
    await repo.createWorkflow(baseWorkflowData);
    await repo.createRevision(baseRevisionData);
    await repo.createRevision({
      ...baseRevisionData,
      revisionId: '000002-bbb',
      revisionCreateTime: '2024-01-02T00:00:00.000Z',
    });

    const deleted = await repo.deleteWorkflow(baseWorkflowData.name);

    expect(deleted).toBe(true);

    const found = await repo.getWorkflowByName(baseWorkflowData.name);

    expect(found).toBeNull();

    const revisions = await repo.listRevisions(baseWorkflowData.name);

    expect(revisions.revisions).toHaveLength(0);
  });

  test('returns false when workflow not found', async () => {
    const deleted = await repo.deleteWorkflow('projects/p/locations/l/workflows/nonexistent');

    expect(deleted).toBe(false);
  });
});
