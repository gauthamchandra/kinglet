/**
 * LRO Operations Store - Unit Tests
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { OperationsStore } from './operations.ts';

let storage: StorageManager;
let store: OperationsStore;

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });
  store = new OperationsStore(storage);
  await store.initialize();
});

describe('createOperation', () => {
  test('creates an operation with correct metadata', async () => {
    const op = await store.createOperation(
      'test-project',
      'us-central1',
      'projects/test-project/locations/us-central1/workflows/my-wf',
      'create',
      { name: 'projects/test-project/locations/us-central1/workflows/my-wf' }
    );

    expect(op.name).toMatch(
      /^projects\/test-project\/locations\/us-central1\/operations\/[0-9a-f-]+$/
    );
    expect(op.done).toBe(true);
    expect(op.metadata.verb).toBe('create');
    expect(op.metadata.apiVersion).toBe('v1');
    expect(op.metadata.target).toBe('projects/test-project/locations/us-central1/workflows/my-wf');
    expect(op.metadata.createTime).toBeTypeOf('string');
    expect(op.metadata.endTime).toBeTypeOf('string');
    expect(op.response).toEqual({
      '@type': 'type.googleapis.com/google.cloud.workflows.v1.Workflow',
      name: 'projects/test-project/locations/us-central1/workflows/my-wf',
    });
  });

  test('creates an operation without response', async () => {
    const op = await store.createOperation(
      'p',
      'l',
      'projects/p/locations/l/workflows/w',
      'delete'
    );

    expect(op.done).toBe(true);
    expect(op.response).toBeUndefined();
    expect(op.error).toBeUndefined();
  });
});

describe('getOperation', () => {
  test('returns operation when found', async () => {
    const created = await store.createOperation(
      'p',
      'l',
      'projects/p/locations/l/workflows/w',
      'create'
    );

    const found = await store.getOperation(created.name);

    expect(found).not.toBeNull();
    expect(found?.name).toBe(created.name);
    expect(found?.metadata.verb).toBe('create');
  });

  test('returns null when not found', async () => {
    const found = await store.getOperation('projects/p/locations/l/operations/nonexistent');

    expect(found).toBeNull();
  });
});

describe('listOperations', () => {
  test('returns empty list when no operations exist', async () => {
    const result = await store.listOperations('p', 'l');

    expect(result.operations).toEqual([]);
    expect(result.nextPageToken).toBeUndefined();
  });

  test('returns operations matching project and location', async () => {
    await store.createOperation('p', 'l', 'target-1', 'create');
    await store.createOperation('p', 'l', 'target-2', 'update');
    await store.createOperation('other', 'l', 'target-3', 'create');

    const result = await store.listOperations('p', 'l');

    expect(result.operations).toHaveLength(2);
  });

  test('paginates results', async () => {
    await store.createOperation('p', 'l', 't1', 'create');
    await store.createOperation('p', 'l', 't2', 'update');
    await store.createOperation('p', 'l', 't3', 'delete');

    const page1 = await store.listOperations('p', 'l', 2);

    expect(page1.operations).toHaveLength(2);
    expect(page1.nextPageToken).toBeDefined();

    const page2 = await store.listOperations('p', 'l', 2, page1.nextPageToken);

    expect(page2.operations).toHaveLength(1);
    expect(page2.nextPageToken).toBeUndefined();
  });
});

describe('deleteOperation', () => {
  test('deletes an existing operation', async () => {
    const created = await store.createOperation('p', 'l', 'target', 'create');

    const deleted = await store.deleteOperation(created.name);

    expect(deleted).toBe(true);

    const found = await store.getOperation(created.name);

    expect(found).toBeNull();
  });

  test('returns false when operation not found', async () => {
    const deleted = await store.deleteOperation('projects/p/locations/l/operations/nonexistent');

    expect(deleted).toBe(false);
  });
});
