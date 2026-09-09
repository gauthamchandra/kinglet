import { beforeEach, describe, expect, test } from 'bun:test';
import { ConfigSchema } from '@/config/schema.ts';
import type { HttpMethod, RouteDefinition, RouteRequest } from '@/core/gateway/request-router.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { AlloyDbService, DEFAULT_ALLOYDB_DATA_PLANE_OPTIONS } from './index.ts';

/**
 * The full route table, transcribed from the discovery document's `flatPath` for
 * each of the 21 methods this service registers. Asserted verbatim rather than by
 * count: a typo'd path is invisible to a count check and fatal to a real client.
 *
 * The generic locations.list/get pair is served once by the shared gateway routes
 * (src/core/gateway/location-routes.ts), not by this service — one owner per path,
 * per docs/adrs/009-shared-route-namespace.md.
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
  // The static flag catalogue; generic locations.list/get are served by the shared
  // gateway routes, not by AlloyDB (see src/core/gateway/location-routes.ts).
  {
    id: 'alloydb.supportedDatabaseFlags.list',
    method: 'GET',
    path: '/v1/projects/:project/locations/:location/supportedDatabaseFlags',
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
      initialUser: { user: 'postgres', password: 'hunter2' },
      networkConfig: { network: 'projects/p/global/networks/default' },
    },
  });

  return (response.body as { name: string }).name;
}

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  service = new AlloyDbService(storage, new Logger('test', 'error'), { enabled: false });
  await service.initialize();
});

describe('initialize', () => {
  test('service data-plane defaults match the config schema defaults', () => {
    const schemaDefaults = ConfigSchema.parse({
      server: {},
      storage: {},
      auth: {},
      services: {
        pubsub: {},
        scheduler: {},
        tasks: {},
        secrets: {},
        storage: {},
        workflows: {},
        kms: {},
      },
      logging: {},
    }).services.alloydb.dataPlane;

    expect(DEFAULT_ALLOYDB_DATA_PLANE_OPTIONS).toMatchObject({
      enabled: schemaDefaults.enabled,
      portRangeStart: schemaDefaults.portRangeStart,
      portRangeEnd: schemaDefaults.portRangeEnd,
      postgis: schemaDefaults.postgis,
    });
  });

  test('getRoutes_calledBeforeInitialize_throws', () => {
    const uninitialized = new AlloyDbService(storage, new Logger('test', 'error'), {
      enabled: false,
    });

    expect(() => uninitialized.getRoutes()).toThrow(/initialize/);
  });

  test('getComposableOperationsStore_calledBeforeInitialize_throws', () => {
    const uninitialized = new AlloyDbService(storage, new Logger('test', 'error'), {
      enabled: false,
    });

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

  test('getRoutes_registersTwentyOneOfTheApis40Methods', () => {
    expect(service.getRoutes()).toHaveLength(21);
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
        initialUser: { user: 'postgres', password: 'hunter2' },
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
        initialUser: { user: 'postgres', password: 'hunter2' },
        networkConfig: { network: 'projects/p/global/networks/default' },
      },
    });

    const store = service.getComposableOperationsStore();
    const firstPage = await store.listOperations('p', 'us-central1', 1);

    expect(firstPage.operations).toHaveLength(1);
    expect(firstPage.nextPageToken).toBe('1');
  });
});

/**
 * The data plane is off in every other test here, so none of the wiring below —
 * the user lookup the wire server authenticates against, the port accessor,
 * stop(), or the restart-time rehydration — is otherwise exercised. Mirrors
 * src/services/cloudsql/index.test.ts, which covers the same shared stack.
 */
describe('data plane', () => {
  const PORT_RANGE_START = 46800;
  const PROJECT = 'p1';
  const LOCATION = 'us-central1';
  const CLUSTER = 'c1';
  const INSTANCE = 'i1';
  const PASSWORD = 's3cret';

  async function startService(): Promise<AlloyDbService> {
    const dataPlaneService = new AlloyDbService(storage, new Logger('AlloyDbTest', 'error'), {
      enabled: true,
      portRangeStart: PORT_RANGE_START,
      portRangeEnd: PORT_RANGE_START + 4,
      storageType: 'memory',
      sqlitePath: './data/emulator.db',
      postgis: false,
    });

    await dataPlaneService.initialize();

    return dataPlaneService;
  }

  async function callRoute(
    target: AlloyDbService,
    routeId: string,
    overrides: Partial<RouteRequest>
  ) {
    const route = target.getRoutes().find((candidate: RouteDefinition) => candidate.id === routeId);

    if (!route) throw new Error(`No route registered with id "${routeId}"`);

    return route.handler(request(overrides), {
      routeId,
      startTime: 0,
      metadata: {},
      logger: new Logger('test', 'error'),
    });
  }

  async function createClusterAndInstance(target: AlloyDbService): Promise<void> {
    const cluster = await callRoute(target, 'alloydb.clusters.create', {
      method: 'POST',
      params: { project: PROJECT, location: LOCATION },
      query: { clusterId: CLUSTER },
      body: {
        initialUser: { user: 'postgres', password: PASSWORD },
        networkConfig: { network: 'projects/p1/global/networks/default' },
      },
    });

    expect(cluster.status).toBe(200);

    const instance = await callRoute(target, 'alloydb.clusters.instances.create', {
      method: 'POST',
      params: { project: PROJECT, location: LOCATION, cluster: CLUSTER },
      query: { instanceId: INSTANCE },
      body: { instanceType: 'PRIMARY' },
    });

    expect(instance.status).toBe(200);
  }

  async function queryOne(port: number): Promise<Record<string, unknown>[]> {
    const client = new Bun.SQL({
      url: `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/postgres`,
      tls: false,
      max: 1,
    });

    try {
      const rows: Record<string, unknown>[] = await client.unsafe('SELECT 1 AS one');

      return rows.map(row => ({ ...row }));
    } finally {
      await client.end();
    }
  }

  /**
   * Exercises the lookupUser callback: the cluster's initialUser password is
   * what the wire server has to authenticate this connection against.
   */
  test('a created instance is reachable with the initial user password', async () => {
    const dataPlaneService = await startService();

    await createClusterAndInstance(dataPlaneService);

    // Read the port back rather than assuming the allocator handed out the
    // first in the range.
    const port = dataPlaneService.getDataPlanePort(PROJECT, LOCATION, CLUSTER, INSTANCE);

    expect(port).not.toBeNull();
    expect(await queryOne(port ?? 0)).toEqual([{ one: 1 }]);

    await dataPlaneService.stop();
  });

  test('stop closes the endpoint so its port can be bound again', async () => {
    const dataPlaneService = await startService();

    await createClusterAndInstance(dataPlaneService);
    await dataPlaneService.stop();

    // The wire server binds 0.0.0.0, so this check has to as well: on macOS a
    // 127.0.0.1 bind succeeds beside a live wildcard listener, which would let
    // this pass with the endpoint still open.
    const rebound = Bun.listen({
      hostname: '0.0.0.0',
      port: PORT_RANGE_START,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });

    expect(rebound.port).toBe(PORT_RANGE_START);

    rebound.stop(true);
  });

  /**
   * Without rehydration a persisted instance keeps being listed and described
   * while nothing listens on its endpoint, and no admin call short of a
   * recreate brings it back.
   */
  test('brings persisted instances back up on a fresh service over the same storage', async () => {
    const first = await startService();

    await createClusterAndInstance(first);
    await first.stop();

    const revived = await startService();

    expect(await queryOne(PORT_RANGE_START)).toEqual([{ one: 1 }]);

    await revived.stop();
  });

  /**
   * initialize_calledTwice_doesNotThrow above runs with the data plane off. On, a
   * second call used to build a second manager and re-run rehydration, so the
   * first manager's listener stayed bound with nothing left holding it.
   */
  test('a second initialize keeps the first data plane rather than orphaning it', async () => {
    const dataPlaneService = await startService();

    await createClusterAndInstance(dataPlaneService);
    await dataPlaneService.initialize();
    await dataPlaneService.stop();

    // The wire server binds 0.0.0.0, so this check has to as well: on macOS a
    // 127.0.0.1 bind succeeds beside a live wildcard listener, which would let
    // this pass with the endpoint still open.
    const rebound = Bun.listen({
      hostname: '0.0.0.0',
      port: PORT_RANGE_START,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });

    expect(rebound.port).toBe(PORT_RANGE_START);

    rebound.stop(true);
  });

  test('reports no port for an instance that was never created', async () => {
    const dataPlaneService = await startService();

    expect(dataPlaneService.getDataPlanePort(PROJECT, LOCATION, CLUSTER, 'ghost')).toBeNull();

    await dataPlaneService.stop();
  });
});
