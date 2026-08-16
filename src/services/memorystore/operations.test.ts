/**
 * Memorystore LRO Operations Store - Unit Tests
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
  test('createOperation_givenInstanceTarget_createsOperationWithMemorystoreMetadataType', async () => {
    const op = await store.createOperation(
      'test-project',
      'us-central1',
      'projects/test-project/locations/us-central1/instances/my-instance',
      'create',
      'Instance',
      { name: 'projects/test-project/locations/us-central1/instances/my-instance' }
    );

    expect(op.name).toMatch(
      /^projects\/test-project\/locations\/us-central1\/operations\/[0-9a-f-]+$/
    );
    expect(op.done).toBe(true);
    expect(op.metadata.verb).toBe('create');
    expect(op.metadata['@type']).toBe(
      'type.googleapis.com/google.cloud.memorystore.v1.OperationMetadata'
    );
    expect(op.response).toEqual({
      '@type': 'type.googleapis.com/google.cloud.memorystore.v1.Instance',
      name: 'projects/test-project/locations/us-central1/instances/my-instance',
    });
  });

  test('createOperation_givenDeleteVerbWithoutResponse_createsDoneOperationWithoutResponse', async () => {
    const op = await store.createOperation(
      'p',
      'l',
      'projects/p/locations/l/instances/i',
      'delete',
      'Instance'
    );

    expect(op.done).toBe(true);
    expect(op.response).toBeUndefined();
    expect(op.error).toBeUndefined();
  });
});

describe('getOperation', () => {
  test('getOperation_givenExistingName_returnsOperation', async () => {
    const created = await store.createOperation(
      'p',
      'l',
      'projects/p/locations/l/instances/i',
      'create',
      'Instance'
    );

    const found = await store.getOperation(created.name);

    expect(found).not.toBeNull();
    expect(found?.name).toBe(created.name);
  });

  test('getOperation_givenMissingName_returnsNull', async () => {
    const found = await store.getOperation('projects/p/locations/l/operations/nonexistent');

    expect(found).toBeNull();
  });
});

describe('listOperations', () => {
  test('listOperations_scopesResultsToProjectAndLocation', async () => {
    await store.createOperation('p', 'l', 'target-1', 'create', 'Instance');
    await store.createOperation('p', 'l', 'target-2', 'update', 'Instance');
    await store.createOperation('other', 'l', 'target-3', 'create', 'Instance');

    const result = await store.listOperations('p', 'l');

    expect(result.operations).toHaveLength(2);
  });

  test('listOperations_paginatesWithStringifiedOffsetTokens', async () => {
    await store.createOperation('p', 'l', 't1', 'create', 'Instance');
    await store.createOperation('p', 'l', 't2', 'update', 'Instance');
    await store.createOperation('p', 'l', 't3', 'delete', 'Instance');

    const page1 = await store.listOperations('p', 'l', 2);

    expect(page1.operations).toHaveLength(2);
    expect(page1.nextPageToken).toBeDefined();

    const page2 = await store.listOperations('p', 'l', 2, page1.nextPageToken);

    expect(page2.operations).toHaveLength(1);
    expect(page2.nextPageToken).toBeUndefined();
  });
});

describe('deleteOperation', () => {
  test('deleteOperation_givenExistingOperation_removesItAndReturnsTrue', async () => {
    const created = await store.createOperation('p', 'l', 'target', 'create', 'Instance');

    const deleted = await store.deleteOperation(created.name);

    expect(deleted).toBe(true);

    const found = await store.getOperation(created.name);

    expect(found).toBeNull();
  });

  test('deleteOperation_givenMissingOperation_returnsFalse', async () => {
    const deleted = await store.deleteOperation('projects/p/locations/l/operations/nonexistent');

    expect(deleted).toBe(false);
  });
});

describe('cancelOperation', () => {
  test('cancelOperation_givenExistingOperation_flagsRequestedCancellationAndReturnsTrue', async () => {
    const created = await store.createOperation('p', 'l', 'target', 'create', 'Instance');

    const cancelled = await store.cancelOperation(created.name);

    expect(cancelled).toBe(true);

    const found = await store.getOperation(created.name);

    expect(found?.metadata.requestedCancellation).toBe(true);
  });

  test('cancelOperation_givenMissingOperation_returnsFalse', async () => {
    const cancelled = await store.cancelOperation('projects/p/locations/l/operations/nonexistent');

    expect(cancelled).toBe(false);
  });
});
