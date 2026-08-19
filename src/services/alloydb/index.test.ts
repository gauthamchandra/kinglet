import { beforeEach, describe, expect, test } from 'bun:test';
import type { HttpMethod, RouteDefinition, RouteRequest } from '@/core/gateway/request-router.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { AlloyDbService } from './index.ts';

/**
 * The full route table, transcribed from the discovery document's `flatPath` for
 * each of the 23 implemented methods. Asserted verbatim rather than by count:
 * a typo'd path is invisible to a count check and fatal to a real client.
 *
 * Deliberately absent (see the README): backups.*, clusters.createsecondary,
 * .promote, .switchover, .restore, .restoreFromCloudSQL, .export, .import,
 * .upgrade, instances.createsecondary, .failover, .injectFault, .restart.
 */
const EXPECTED_ROUTES: ReadonlyArray<{ id: string; method: HttpMethod; path: string }> = [
  // operations — registered first so the composed set can win the tie-break
  {
    id: 'alloydb.operations.list',
    method: 'GET',
    path: '/v1/projects/:project/locations/:location/operations',
  },
  {
    id: 'alloydb.operations.cancel',
    method: 'POST',
    path: '/v1/projects/:project/locations/:location/operations/:operationId:cancel',
  },
  {
    id: 'alloydb.operations.get',
    method: 'GET',
    path: '/v1/projects/:project/locations/:location/operations/:operationId',
  },
  {
    id: 'alloydb.operations.delete',
    method: 'DELETE',
    path: '/v1/projects/:project/locations/:location/operations/:operationId',
  },
  // instances
  {
    id: 'alloydb.clusters.instances.create',
    method: 'POST',
    path: '/v1/projects/:project/locations/:location/clusters/:cluster/instances',
  },
  {
    id: 'alloydb.clusters.instances.list',
    method: 'GET',
    path: '/v1/projects/:project/locations/:location/clusters/:cluster/instances',
  },
  {
    id: 'alloydb.clusters.instances.getConnectionInfo',
    method: 'GET',
    path: '/v1/projects/:project/locations/:location/clusters/:cluster/instances/:instance/connectionInfo',
  },
  {
    id: 'alloydb.clusters.instances.get',
    method: 'GET',
    path: '/v1/projects/:project/locations/:location/clusters/:cluster/instances/:instance',
  },
  {
    id: 'alloydb.clusters.instances.patch',
    method: 'PATCH',
    path: '/v1/projects/:project/locations/:location/clusters/:cluster/instances/:instance',
  },
  {
    id: 'alloydb.clusters.instances.delete',
    method: 'DELETE',
    path: '/v1/projects/:project/locations/:location/clusters/:cluster/instances/:instance',
  },
  // users
  {
    id: 'alloydb.clusters.users.create',
    method: 'POST',
    path: '/v1/projects/:project/locations/:location/clusters/:cluster/users',
  },
  {
    id: 'alloydb.clusters.users.list',
    method: 'GET',
    path: '/v1/projects/:project/locations/:location/clusters/:cluster/users',
  },
  {
    id: 'alloydb.clusters.users.get',
    method: 'GET',
    path: '/v1/projects/:project/locations/:location/clusters/:cluster/users/:user',
  },
  {
    id: 'alloydb.clusters.users.patch',
    method: 'PATCH',
    path: '/v1/projects/:project/locations/:location/clusters/:cluster/users/:user',
  },
  {
    id: 'alloydb.clusters.users.delete',
    method: 'DELETE',
    path: '/v1/projects/:project/locations/:location/clusters/:cluster/users/:user',
  },
  // clusters
  {
    id: 'alloydb.clusters.create',
    method: 'POST',
    path: '/v1/projects/:project/locations/:location/clusters',
  },
  {
    id: 'alloydb.clusters.list',
    method: 'GET',
    path: '/v1/projects/:project/locations/:location/clusters',
  },
  {
    id: 'alloydb.clusters.get',
    method: 'GET',
    path: '/v1/projects/:project/locations/:location/clusters/:cluster',
  },
  {
    id: 'alloydb.clusters.patch',
    method: 'PATCH',
    path: '/v1/projects/:project/locations/:location/clusters/:cluster',
  },
  {
    id: 'alloydb.clusters.delete',
    method: 'DELETE',
    path: '/v1/projects/:project/locations/:location/clusters/:cluster',
  },
  // locations and the static flag catalogue
  {
    id: 'alloydb.locations.list',
    method: 'GET',
    path: '/v1/projects/:project/locations',
  },
  {
    id: 'alloydb.supportedDatabaseFlags.list',
    method: 'GET',
    path: '/v1/projects/:project/locations/:location/supportedDatabaseFlags',
  },
  {
    id: 'alloydb.locations.get',
    method: 'GET',
    path: '/v1/projects/:project/locations/:location',
  },
];

let storage: StorageManager;
let service: AlloyDbService;

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/',
    query: {},
    headers: {},
    params: {},
    originalRequest: new Request('http://localhost/'),
    ...overrides,
  };
}

async function invoke(routeId: string, overrides: Partial<RouteRequest> = {}) {
  const route = service.getRoutes().find((candidate: RouteDefinition) => candidate.id === routeId);

  if (!route) throw new Error(`No route registered with id "${routeId}"`);

  return route.handler(request(overrides), {
    routeId,
    startTime: 0,
    metadata: {},
    logger: new Logger('test', 'error'),
  });
}

/** Create a cluster so there is a real AlloyDB operation to look up. */
async function createClusterOperation(): Promise<string> {
  const response = await invoke('alloydb.clusters.create', {
    method: 'POST',
    params: { project: 'p', location: 'us-central1' },
    query: { clusterId: 'c1' },
    body: {
      initialUser: { user: 'postgres' },
      networkConfig: { network: 'projects/p/global/networks/default' },
    },
  });

  return (response.body as { name: string }).name;
}

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  service = new AlloyDbService(storage, new Logger('test', 'error'));
  await service.initialize();
});

describe('initialize', () => {
  test('getRoutes_calledBeforeInitialize_throws', () => {
    const uninitialized = new AlloyDbService(storage, new Logger('test', 'error'));

    expect(() => uninitialized.getRoutes()).toThrow(/initialize/);
  });

  test('getComposableOperationsStore_calledBeforeInitialize_throws', () => {
    const uninitialized = new AlloyDbService(storage, new Logger('test', 'error'));

    expect(() => uninitialized.getComposableOperationsStore()).toThrow(/initialize/);
  });

  test('initialize_createsEveryTableTheServiceOwns', async () => {
    const tables = await storage.listTables();

    expect(tables).toContain('alloydb_clusters');
    expect(tables).toContain('alloydb_instances');
    expect(tables).toContain('alloydb_users');
    expect(tables).toContain('alloydb_operations');
  });

  test('initialize_calledTwice_doesNotThrow', async () => {
    await service.initialize();

    expect(service.getRoutes()).toHaveLength(EXPECTED_ROUTES.length);
  });
});

describe('route table', () => {
  test('getRoutes_matchesTheDiscoveryDocumentMethodAndPathTableExactly', () => {
    const actual = service
      .getRoutes()
      .map(route => ({ id: route.id, method: route.method, path: route.path }));

    expect(actual).toEqual([...EXPECTED_ROUTES]);
  });

  test('getRoutes_registersTwentyThreeOfTheApis40Methods', () => {
    expect(service.getRoutes()).toHaveLength(23);
  });

  test('getRoutes_everyRouteIdIsPrefixedWithAlloydb', () => {
    for (const route of service.getRoutes()) {
      expect(route.id).toStartWith('alloydb.');
    }
  });

  test('getRoutes_registersNoRouteForAnUnimplementedCustomVerb', () => {
    const paths = service.getRoutes().map(route => route.path);

    for (const absentVerb of [
      ':promote',
      ':switchover',
      ':restore',
      ':failover',
      ':injectFault',
      ':restart',
      ':upgrade',
      ':export',
      ':import',
      ':createsecondary',
      'backups',
    ]) {
      expect(paths.some(path => path.includes(absentVerb))).toBe(false);
    }
  });
});

describe('operations routes', () => {
  test('get_returnsAnOperationTheServiceCreated', async () => {
    const operationName = await createClusterOperation();
    const operationId = operationName.split('/').pop() ?? '';

    const response = await invoke('alloydb.operations.get', {
      params: { project: 'p', location: 'us-central1', operationId },
    });

    expect(response.status).toBe(200);
    expect((response.body as { name: string }).name).toBe(operationName);
    expect((response.body as { done: boolean }).done).toBe(true);
  });

  test('get_givenAnUnknownOperation_returns404', async () => {
    const response = await invoke('alloydb.operations.get', {
      params: { project: 'p', location: 'us-central1', operationId: 'missing' },
    });

    expect(response.status).toBe(404);
    expect((response.body as { error: { status: string } }).error.status).toBe('NOT_FOUND');
  });

  test('list_keysTheResponseOnOperations', async () => {
    await createClusterOperation();

    const response = await invoke('alloydb.operations.list', {
      params: { project: 'p', location: 'us-central1' },
    });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('operations');
    expect(response.body).not.toHaveProperty('items');
  });

  test('list_paginatesWithPageSizeAndPageToken', async () => {
    await createClusterOperation();
    await invoke('alloydb.clusters.create', {
      method: 'POST',
      params: { project: 'p', location: 'us-central1' },
      query: { clusterId: 'c2' },
      body: {
        initialUser: { user: 'postgres' },
        networkConfig: { network: 'projects/p/global/networks/default' },
      },
    });

    const firstPage = await invoke('alloydb.operations.list', {
      params: { project: 'p', location: 'us-central1' },
      query: { pageSize: '1' },
    });

    expect((firstPage.body as { operations: unknown[] }).operations).toHaveLength(1);
    expect((firstPage.body as { nextPageToken: string }).nextPageToken).toBe('1');
  });

  /**
   * Cancel records the request without pretending to undo work that already
   * completed — the emulator's operations are born done.
   */
  test('cancel_flagsRequestedCancellationAndLeavesTheOperationDone', async () => {
    const operationName = await createClusterOperation();
    const operationId = operationName.split('/').pop() ?? '';

    const cancelled = await invoke('alloydb.operations.cancel', {
      method: 'POST',
      params: { project: 'p', location: 'us-central1', operationId },
    });

    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({});

    const afterwards = await invoke('alloydb.operations.get', {
      params: { project: 'p', location: 'us-central1', operationId },
    });
    const operation = afterwards.body as {
      done: boolean;
      metadata: { requestedCancellation?: boolean };
    };

    expect(operation.metadata.requestedCancellation).toBe(true);
    expect(operation.done).toBe(true);
  });

  test('cancel_givenAnUnknownOperation_returns404', async () => {
    const response = await invoke('alloydb.operations.cancel', {
      method: 'POST',
      params: { project: 'p', location: 'us-central1', operationId: 'missing' },
    });

    expect(response.status).toBe(404);
  });

  test('delete_removesTheOperationAndReturnsAnEmptyObject', async () => {
    const operationName = await createClusterOperation();
    const operationId = operationName.split('/').pop() ?? '';

    const deleted = await invoke('alloydb.operations.delete', {
      method: 'DELETE',
      params: { project: 'p', location: 'us-central1', operationId },
    });

    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({});

    const afterwards = await invoke('alloydb.operations.get', {
      params: { project: 'p', location: 'us-central1', operationId },
    });

    expect(afterwards.status).toBe(404);
  });

  test('delete_givenAnUnknownOperation_returns404', async () => {
    const response = await invoke('alloydb.operations.delete', {
      method: 'DELETE',
      params: { project: 'p', location: 'us-central1', operationId: 'missing' },
    });

    expect(response.status).toBe(404);
  });
});

describe('getComposableOperationsStore', () => {
  /**
   * Three services now expose identically shaped `/operations` routes and the
   * router picks one winner per path, so AlloyDB's LROs are only reachable through
   * the composed set if this adapter round-trips them.
   */
  test('getComposableOperationsStore_roundTripsAnOperationCreatedByThisService', async () => {
    const operationName = await createClusterOperation();
    const store = service.getComposableOperationsStore();

    expect((await store.getOperation(operationName))?.name).toBe(operationName);

    const listed = await store.listOperations('p', 'us-central1');

    expect(listed.operations.map(operation => operation.name)).toContain(operationName);
  });

  test('getComposableOperationsStore_reportsAnUnknownOperationAsNull', async () => {
    const store = service.getComposableOperationsStore();

    expect(await store.getOperation('projects/p/locations/us-central1/operations/nope')).toBeNull();
  });

  test('getComposableOperationsStore_deletesThroughToTheUnderlyingStore', async () => {
    const operationName = await createClusterOperation();
    const store = service.getComposableOperationsStore();

    expect(await store.deleteOperation(operationName)).toBe(true);
    expect(await store.getOperation(operationName)).toBeNull();
    expect(await store.deleteOperation(operationName)).toBe(false);
  });

  test('getComposableOperationsStore_propagatesPagination', async () => {
    await createClusterOperation();
    await invoke('alloydb.clusters.create', {
      method: 'POST',
      params: { project: 'p', location: 'us-central1' },
      query: { clusterId: 'c2' },
      body: {
        initialUser: { user: 'postgres' },
        networkConfig: { network: 'projects/p/global/networks/default' },
      },
    });

    const store = service.getComposableOperationsStore();
    const firstPage = await store.listOperations('p', 'us-central1', 1);

    expect(firstPage.operations).toHaveLength(1);
    expect(firstPage.nextPageToken).toBe('1');
  });
});
