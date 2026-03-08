/**
 * Workflow Service - Unit Tests
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { OperationsStore } from './operations.ts';
import { WorkflowRepository } from './repository.ts';
import { WorkflowService, WorkflowsError } from './service.ts';

let storage: StorageManager;
let repo: WorkflowRepository;
let opsStore: OperationsStore;
let service: WorkflowService;

const project = 'test-project';
const location = 'us-central1';
const workflowId = 'my-workflow';

const validBody = {
  sourceContents: 'main:\n  steps:\n    - step1:\n        return: "hello"',
  description: 'Test workflow',
};

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  repo = new WorkflowRepository(storage);
  await repo.initialize();

  opsStore = new OperationsStore(storage);
  await opsStore.initialize();

  service = new WorkflowService(repo, opsStore);
});

describe('createWorkflow', () => {
  test('creates a workflow and returns an Operation wrapping the workflow', async () => {
    const op = await service.createWorkflow(project, location, workflowId, validBody);

    expect(op.done).toBe(true);
    expect(op.metadata.verb).toBe('create');
    expect(op.metadata.target).toBe(
      `projects/${project}/locations/${location}/workflows/${workflowId}`
    );

    const workflow = op.response as Record<string, unknown>;

    expect(workflow.name).toBe(`projects/${project}/locations/${location}/workflows/${workflowId}`);
    expect(workflow.state).toBe('ACTIVE');
    expect(workflow.revisionId).toMatch(/^000001-[0-9a-f]{3}$/);
    expect(workflow.description).toBe('Test workflow');
  });

  test('rejects duplicate workflow names', async () => {
    await service.createWorkflow(project, location, workflowId, validBody);

    const promise = service.createWorkflow(project, location, workflowId, validBody);

    await expect(promise).rejects.toBeInstanceOf(WorkflowsError);
    await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
  });

  test('rejects invalid request body', async () => {
    const promise = service.createWorkflow(project, location, workflowId, {
      description: 'Missing sourceContents',
    });

    await expect(promise).rejects.toBeInstanceOf(WorkflowsError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('rejects empty workflowId', async () => {
    const promise = service.createWorkflow(project, location, '', validBody);

    await expect(promise).rejects.toBeInstanceOf(WorkflowsError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('creates first revision alongside workflow', async () => {
    await service.createWorkflow(project, location, workflowId, validBody);

    const name = `projects/${project}/locations/${location}/workflows/${workflowId}`;
    const revisions = await service.listRevisions(name);

    expect(revisions.workflows).toHaveLength(1);
    expect(revisions.workflows[0]?.revisionId).toMatch(/^000001-[0-9a-f]{3}$/);
  });
});

describe('getWorkflow', () => {
  test('returns workflow by name', async () => {
    await service.createWorkflow(project, location, workflowId, validBody);

    const name = `projects/${project}/locations/${location}/workflows/${workflowId}`;
    const workflow = await service.getWorkflow(name);

    expect(workflow.name).toBe(name);
    expect(workflow.state).toBe('ACTIVE');
  });

  test('throws NOT_FOUND for nonexistent workflow', async () => {
    const promise = service.getWorkflow('projects/p/locations/l/workflows/nonexistent');

    await expect(promise).rejects.toBeInstanceOf(WorkflowsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('returns specific revision by revisionId', async () => {
    const createOp = await service.createWorkflow(project, location, workflowId, validBody);
    const created = createOp.response as Record<string, unknown>;
    const firstRevisionId = created.revisionId as string;

    const name = `projects/${project}/locations/${location}/workflows/${workflowId}`;
    const workflow = await service.getWorkflow(name, firstRevisionId);

    expect(workflow.revisionId).toBe(firstRevisionId);
  });

  test('throws NOT_FOUND for nonexistent revision', async () => {
    await service.createWorkflow(project, location, workflowId, validBody);

    const name = `projects/${project}/locations/${location}/workflows/${workflowId}`;
    const promise = service.getWorkflow(name, 'nonexistent-rev');

    await expect(promise).rejects.toBeInstanceOf(WorkflowsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });
});

describe('listWorkflows', () => {
  test('returns empty list when no workflows exist', async () => {
    const result = await service.listWorkflows(project, location);

    expect(result.workflows).toEqual([]);
  });

  test('returns workflows for project/location', async () => {
    await service.createWorkflow(project, location, 'wf-1', validBody);
    await service.createWorkflow(project, location, 'wf-2', validBody);

    const result = await service.listWorkflows(project, location);

    expect(result.workflows).toHaveLength(2);
  });

  test('paginates results', async () => {
    await service.createWorkflow(project, location, 'a', validBody);
    await service.createWorkflow(project, location, 'b', validBody);
    await service.createWorkflow(project, location, 'c', validBody);

    const page1 = await service.listWorkflows(project, location, 2);

    expect(page1.workflows).toHaveLength(2);
    expect(page1.nextPageToken).toBeDefined();

    const page2 = await service.listWorkflows(project, location, 2, page1.nextPageToken);

    expect(page2.workflows).toHaveLength(1);
    expect(page2.nextPageToken).toBeUndefined();
  });
});

describe('updateWorkflow', () => {
  test('updates description without creating new revision', async () => {
    const createOp = await service.createWorkflow(project, location, workflowId, validBody);
    const created = createOp.response as Record<string, unknown>;
    const originalRevisionId = created.revisionId as string;

    const name = `projects/${project}/locations/${location}/workflows/${workflowId}`;
    const updateOp = await service.updateWorkflow(name, {
      description: 'Updated description',
    });

    expect(updateOp.done).toBe(true);
    expect(updateOp.metadata.verb).toBe('update');

    const updated = updateOp.response as Record<string, unknown>;

    expect(updated.description).toBe('Updated description');
    expect(updated.revisionId).toBe(originalRevisionId);

    const revisions = await service.listRevisions(name);

    expect(revisions.workflows).toHaveLength(1);
  });

  test('creates new revision when sourceContents changes', async () => {
    await service.createWorkflow(project, location, workflowId, validBody);

    const name = `projects/${project}/locations/${location}/workflows/${workflowId}`;
    const updateOp = await service.updateWorkflow(name, {
      sourceContents: 'updated:\n  steps: []',
    });

    const updated = updateOp.response as Record<string, unknown>;

    expect(updated.revisionId).toMatch(/^000002-[0-9a-f]{3}$/);

    const revisions = await service.listRevisions(name);

    expect(revisions.workflows).toHaveLength(2);
  });

  test('creates new revision when serviceAccount changes', async () => {
    await service.createWorkflow(project, location, workflowId, validBody);

    const name = `projects/${project}/locations/${location}/workflows/${workflowId}`;
    await service.updateWorkflow(name, {
      serviceAccount: 'new-sa@p.iam.gserviceaccount.com',
    });

    const revisions = await service.listRevisions(name);

    expect(revisions.workflows).toHaveLength(2);
  });

  test('does not create new revision for labels-only update', async () => {
    await service.createWorkflow(project, location, workflowId, validBody);

    const name = `projects/${project}/locations/${location}/workflows/${workflowId}`;
    await service.updateWorkflow(name, {
      labels: { env: 'prod' },
    });

    const revisions = await service.listRevisions(name);

    expect(revisions.workflows).toHaveLength(1);
  });

  test('throws NOT_FOUND for nonexistent workflow', async () => {
    const promise = service.updateWorkflow('projects/p/locations/l/workflows/nonexistent', {
      description: 'test',
    });

    await expect(promise).rejects.toBeInstanceOf(WorkflowsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });
});

describe('deleteWorkflow', () => {
  test('deletes workflow and returns Operation', async () => {
    await service.createWorkflow(project, location, workflowId, validBody);

    const name = `projects/${project}/locations/${location}/workflows/${workflowId}`;
    const op = await service.deleteWorkflow(name);

    expect(op.done).toBe(true);
    expect(op.metadata.verb).toBe('delete');

    const promise = service.getWorkflow(name);

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('throws NOT_FOUND for nonexistent workflow', async () => {
    const promise = service.deleteWorkflow('projects/p/locations/l/workflows/nonexistent');

    await expect(promise).rejects.toBeInstanceOf(WorkflowsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });
});

describe('listRevisions', () => {
  test('returns revisions in reverse chronological order', async () => {
    await service.createWorkflow(project, location, workflowId, validBody);

    const name = `projects/${project}/locations/${location}/workflows/${workflowId}`;

    // Create a second revision by updating sourceContents
    await service.updateWorkflow(name, {
      sourceContents: 'updated:\n  steps: []',
    });

    const result = await service.listRevisions(name);

    expect(result.workflows).toHaveLength(2);
    expect(result.workflows[0]?.revisionId).toMatch(/^000002-/);
    expect(result.workflows[1]?.revisionId).toMatch(/^000001-/);
  });

  test('throws NOT_FOUND for nonexistent workflow', async () => {
    const promise = service.listRevisions('projects/p/locations/l/workflows/nonexistent');

    await expect(promise).rejects.toBeInstanceOf(WorkflowsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });
});
