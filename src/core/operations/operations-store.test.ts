import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import {
  buildOperationName,
  buildOperationsTableSchema,
  OperationsStore,
} from './operations-store.ts';

const TABLE = 'widgets_operations';
const API_TYPE_PREFIX = 'google.cloud.widgets.v1';
const TARGET = 'projects/p/locations/us-central1/widgets/w1';

let storage: StorageManager;
let store: OperationsStore;

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  store = new OperationsStore(storage, { tableName: TABLE, apiTypePrefix: API_TYPE_PREFIX });
  await store.initialize();
});

describe('schema', () => {
  /**
   * SQLite index names are schema-global, not table-scoped, so a hardcoded
   * `idx_operations_name` shared by two services' operations tables would
   * collide. Deriving the name from the table keeps them distinct.
   */
  test('buildOperationsTableSchema_derivesTheIndexNameFromTheTableSoTwoServicesCannotCollide', () => {
    const first = buildOperationsTableSchema('alloydb_operations');
    const second = buildOperationsTableSchema('memorystore_operations');

    expect(first.indexes?.[0]?.name).toBe('idx_alloydb_operations_name');
    expect(second.indexes?.[0]?.name).toBe('idx_memorystore_operations_name');
    expect(first.indexes?.[0]?.name).not.toBe(second.indexes?.[0]?.name);
  });

  test('buildOperationsTableSchema_uniquelyIndexesName', () => {
    const schema = buildOperationsTableSchema(TABLE);

    expect(schema.name).toBe(TABLE);
    expect(schema.columns.find(column => column.name === 'name')?.unique).toBe(true);
    expect(schema.indexes?.[0]?.unique).toBe(true);
  });
});

describe('buildOperationName', () => {
  test('buildOperationName_matchesGcpsLroResourceNameFormat', () => {
    expect(buildOperationName('p', 'us-central1', 'op-1')).toBe(
      'projects/p/locations/us-central1/operations/op-1'
    );
  });
});

describe('initialize', () => {
  test('initialize_calledTwice_doesNotThrow', async () => {
    await store.initialize();

    expect(await storage.listTables()).toContain(TABLE);
  });
});

describe('createOperation', () => {
  /**
   * The emulator has no asynchronous work behind a mutation, so an operation is
   * born complete. A client that polls until `done` therefore terminates on its
   * first read rather than spinning forever.
   */
  test('createOperation_returnsAnOperationThatIsAlreadyDone', async () => {
    const operation = await store.createOperation('p', 'us-central1', TARGET, 'create', 'Widget');

    expect(operation.done).toBe(true);
    expect(operation.name).toStartWith('projects/p/locations/us-central1/operations/');
  });

  test('createOperation_stampsMetadataWithTheConfiguredApiType', async () => {
    const operation = await store.createOperation('p', 'us-central1', TARGET, 'create', 'Widget');

    expect(operation.metadata['@type']).toBe(
      `type.googleapis.com/${API_TYPE_PREFIX}.OperationMetadata`
    );
    expect(operation.metadata.target).toBe(TARGET);
    expect(operation.metadata.verb).toBe('create');
    expect(operation.metadata.apiVersion).toBe('v1');
    expect(operation.metadata.createTime).toBeTypeOf('string');
    expect(operation.metadata.endTime).toBeTypeOf('string');
  });

  test('createOperation_givenAResource_embedsItUnderTheResourcesOwnApiType', async () => {
    const operation = await store.createOperation('p', 'us-central1', TARGET, 'create', 'Widget', {
      name: TARGET,
      state: 'READY',
    });

    expect(operation.response).toEqual({
      '@type': `type.googleapis.com/${API_TYPE_PREFIX}.Widget`,
      name: TARGET,
      state: 'READY',
    });
  });

  // A delete LRO has no resource to return, and an empty `response` key is not
  // the same thing as an absent one to a client checking for it.
  test('createOperation_withoutAResource_omitsTheResponseField', async () => {
    const operation = await store.createOperation('p', 'us-central1', TARGET, 'delete', 'Widget');

    expect(operation).not.toHaveProperty('response');
  });

  test('createOperation_givenTwoCalls_mintsDistinctOperationNames', async () => {
    const first = await store.createOperation('p', 'us-central1', TARGET, 'create', 'Widget');
    const second = await store.createOperation('p', 'us-central1', TARGET, 'create', 'Widget');

    expect(first.name).not.toBe(second.name);
  });
});

describe('buildUnpersistedOperation', () => {
  /**
   * A `validateOnly` request must answer with an Operation to match the real
   * API's response type while leaving nothing behind — otherwise a dry run
   * shows up in `operations.list`.
   */
  test('buildUnpersistedOperation_returnsACompleteOperationWithoutStoringIt', async () => {
    const operation = store.buildUnpersistedOperation(
      'p',
      'us-central1',
      TARGET,
      'create',
      'Widget',
      { name: TARGET }
    );

    expect(operation.done).toBe(true);
    expect(operation.metadata.verb).toBe('create');
    expect(operation.response).toEqual({
      '@type': `type.googleapis.com/${API_TYPE_PREFIX}.Widget`,
      name: TARGET,
    });

    expect(await store.getOperation(operation.name)).toBeNull();
    expect((await store.listOperations('p', 'us-central1')).operations).toEqual([]);
    expect(await storage.count(TABLE)).toBe(0);
  });

  test('buildUnpersistedOperation_withoutAResource_omitsTheResponseField', () => {
    const operation = store.buildUnpersistedOperation(
      'p',
      'us-central1',
      TARGET,
      'delete',
      'Widget'
    );

    expect(operation).not.toHaveProperty('response');
  });
});

describe('getOperation', () => {
  test('getOperation_givenAnExistingName_returnsIt', async () => {
    const created = await store.createOperation('p', 'us-central1', TARGET, 'create', 'Widget');
    const found = await store.getOperation(created.name);

    expect(found?.name).toBe(created.name);
    expect(found?.done).toBe(true);
  });

  test('getOperation_givenAnUnknownName_returnsNull', async () => {
    expect(await store.getOperation('projects/p/locations/us-central1/operations/nope')).toBeNull();
  });
});

describe('listOperations', () => {
  test('listOperations_returnsEveryOperationInTheLocation', async () => {
    await store.createOperation('p', 'us-central1', TARGET, 'create', 'Widget');
    await store.createOperation('p', 'us-central1', TARGET, 'delete', 'Widget');

    const result = await store.listOperations('p', 'us-central1');

    expect(result.operations).toHaveLength(2);
    expect(result.nextPageToken).toBeUndefined();
  });

  // Operation names are location-scoped; leaking another location's operations
  // into a list would let a client observe resources it never created.
  test('listOperations_excludesOperationsFromAnotherLocation', async () => {
    await store.createOperation('p', 'us-central1', TARGET, 'create', 'Widget');
    await store.createOperation('p', 'europe-west1', TARGET, 'create', 'Widget');

    const result = await store.listOperations('p', 'us-central1');

    expect(result.operations).toHaveLength(1);
  });

  test('listOperations_excludesOperationsFromAnotherProject', async () => {
    await store.createOperation('p', 'us-central1', TARGET, 'create', 'Widget');
    await store.createOperation('other', 'us-central1', TARGET, 'create', 'Widget');

    const result = await store.listOperations('p', 'us-central1');

    expect(result.operations).toHaveLength(1);
  });

  test('listOperations_givenAPageSizeSmallerThanTheResultSet_returnsANextPageToken', async () => {
    for (let i = 0; i < 3; i++) {
      await store.createOperation('p', 'us-central1', TARGET, 'create', 'Widget');
    }

    const firstPage = await store.listOperations('p', 'us-central1', 2);

    expect(firstPage.operations).toHaveLength(2);
    expect(firstPage.nextPageToken).toBe('2');

    const secondPage = await store.listOperations('p', 'us-central1', 2, firstPage.nextPageToken);

    expect(secondPage.operations).toHaveLength(1);
    expect(secondPage.nextPageToken).toBeUndefined();
  });

  test('listOperations_paginatesWithoutRepeatingAnOperationAcrossPages', async () => {
    for (let i = 0; i < 5; i++) {
      await store.createOperation('p', 'us-central1', TARGET, 'create', 'Widget');
    }

    const firstPage = await store.listOperations('p', 'us-central1', 3);
    const secondPage = await store.listOperations('p', 'us-central1', 3, firstPage.nextPageToken);
    const names = [...firstPage.operations, ...secondPage.operations].map(
      operation => operation.name
    );

    expect(new Set(names).size).toBe(5);
  });

  test('listOperations_givenNoOperations_returnsAnEmptyList', async () => {
    const result = await store.listOperations('p', 'us-central1');

    expect(result.operations).toEqual([]);
  });
});

describe('deleteOperation', () => {
  test('deleteOperation_givenAnExistingOperation_removesIt', async () => {
    const created = await store.createOperation('p', 'us-central1', TARGET, 'create', 'Widget');

    expect(await store.deleteOperation(created.name)).toBe(true);
    expect(await store.getOperation(created.name)).toBeNull();
  });

  test('deleteOperation_givenAnUnknownName_returnsFalse', async () => {
    expect(await store.deleteOperation('projects/p/locations/us-central1/operations/nope')).toBe(
      false
    );
  });
});

describe('cancelOperation', () => {
  /**
   * There is nothing to interrupt — the operation completed before the caller
   * could see it — so cancel records the request and leaves `done` alone, which
   * is what real GCP reports for an operation that finished before its cancel
   * arrived.
   */
  test('cancelOperation_recordsTheRequestWithoutUndoingACompletedOperation', async () => {
    const created = await store.createOperation('p', 'us-central1', TARGET, 'create', 'Widget');

    expect(await store.cancelOperation(created.name)).toBe(true);

    const after = await store.getOperation(created.name);

    expect(after?.metadata.requestedCancellation).toBe(true);
    expect(after?.done).toBe(true);
  });

  test('cancelOperation_givenAnUnknownName_returnsFalse', async () => {
    expect(await store.cancelOperation('projects/p/locations/us-central1/operations/nope')).toBe(
      false
    );
  });
});

describe('multi-tenancy', () => {
  // Two services sharing one implementation must not share one table, or
  // AlloyDB's operations would surface in Memorystore's list.
  test('twoStoresOnDistinctTables_doNotSeeEachOthersOperations', async () => {
    const otherStore = new OperationsStore(storage, {
      tableName: 'gadgets_operations',
      apiTypePrefix: 'google.cloud.gadgets.v1',
    });
    await otherStore.initialize();

    await store.createOperation('p', 'us-central1', TARGET, 'create', 'Widget');
    const gadgetOperation = await otherStore.createOperation(
      'p',
      'us-central1',
      TARGET,
      'create',
      'Gadget'
    );

    expect((await store.listOperations('p', 'us-central1')).operations).toHaveLength(1);
    expect(await store.getOperation(gadgetOperation.name)).toBeNull();
    expect(gadgetOperation.metadata['@type']).toBe(
      'type.googleapis.com/google.cloud.gadgets.v1.OperationMetadata'
    );
  });
});
