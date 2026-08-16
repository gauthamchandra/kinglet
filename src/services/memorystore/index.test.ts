/**
 * Unit tests for MemorystoreService
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { MemorystoreService } from './index.ts';

const FAKE_VALKEY_SERVER = join(import.meta.dir, '__fixtures__', 'fake-valkey-server.ts');

// All 38 method/path pairs the discovery document mandates (see the route
// table in the memorystore implementation plan). Asserted verbatim so a
// route with the wrong HTTP method or a missing `:verb` colon-suffix fails
// this test, rather than only the route COUNT.
const EXPECTED_ROUTES = [
  ['GET', '/v1/projects/:project/locations'],
  ['GET', '/v1/projects/:project/locations/:location'],
  ['GET', '/v1/projects/:project/locations/:location/sharedRegionalCertificateAuthority'],

  ['GET', '/v1/projects/:project/locations/:location/operations'],
  ['GET', '/v1/projects/:project/locations/:location/operations/:operation'],
  ['DELETE', '/v1/projects/:project/locations/:location/operations/:operation'],
  ['POST', '/v1/projects/:project/locations/:location/operations/:operation:cancel'],

  ['POST', '/v1/projects/:project/locations/:location/instances'],
  ['GET', '/v1/projects/:project/locations/:location/instances'],
  ['GET', '/v1/projects/:project/locations/:location/instances/:instance'],
  ['PATCH', '/v1/projects/:project/locations/:location/instances/:instance'],
  ['DELETE', '/v1/projects/:project/locations/:location/instances/:instance'],
  ['GET', '/v1/projects/:project/locations/:location/instances/:instance/certificateAuthority'],
  ['POST', '/v1/projects/:project/locations/:location/instances/:instance:backup'],
  ['POST', '/v1/projects/:project/locations/:location/instances/:instance:startMigration'],
  ['POST', '/v1/projects/:project/locations/:location/instances/:instance:finishMigration'],
  ['POST', '/v1/projects/:project/locations/:location/instances/:instance:rescheduleMaintenance'],
  ['POST', '/v1/projects/:project/locations/:location/instances/:instance:addTokenAuthUser'],

  ['GET', '/v1/projects/:project/locations/:location/instances/:instance/tokenAuthUsers'],
  [
    'GET',
    '/v1/projects/:project/locations/:location/instances/:instance/tokenAuthUsers/:tokenAuthUser',
  ],
  [
    'DELETE',
    '/v1/projects/:project/locations/:location/instances/:instance/tokenAuthUsers/:tokenAuthUser',
  ],
  [
    'POST',
    '/v1/projects/:project/locations/:location/instances/:instance/tokenAuthUsers/:tokenAuthUser:addAuthToken',
  ],
  [
    'GET',
    '/v1/projects/:project/locations/:location/instances/:instance/tokenAuthUsers/:tokenAuthUser/authTokens',
  ],
  [
    'GET',
    '/v1/projects/:project/locations/:location/instances/:instance/tokenAuthUsers/:tokenAuthUser/authTokens/:authToken',
  ],
  [
    'DELETE',
    '/v1/projects/:project/locations/:location/instances/:instance/tokenAuthUsers/:tokenAuthUser/authTokens/:authToken',
  ],

  ['GET', '/v1/projects/:project/locations/:location/backupCollections'],
  ['GET', '/v1/projects/:project/locations/:location/backupCollections/:backupCollection'],
  ['GET', '/v1/projects/:project/locations/:location/backupCollections/:backupCollection/backups'],
  [
    'GET',
    '/v1/projects/:project/locations/:location/backupCollections/:backupCollection/backups/:backup',
  ],
  [
    'DELETE',
    '/v1/projects/:project/locations/:location/backupCollections/:backupCollection/backups/:backup',
  ],
  [
    'POST',
    '/v1/projects/:project/locations/:location/backupCollections/:backupCollection/backups/:backup:export',
  ],

  ['POST', '/v1/projects/:project/locations/:location/aclPolicies'],
  ['GET', '/v1/projects/:project/locations/:location/aclPolicies'],
  ['GET', '/v1/projects/:project/locations/:location/aclPolicies/:aclPolicy'],
  ['PATCH', '/v1/projects/:project/locations/:location/aclPolicies/:aclPolicy'],
  ['DELETE', '/v1/projects/:project/locations/:location/aclPolicies/:aclPolicy'],
  ['GET', '/v1/projects/:project/locations/:location/aclPolicies/:aclPolicy/revisions'],
  ['GET', '/v1/projects/:project/locations/:location/aclPolicies/:aclPolicy/revisions/:revision'],
] as const;

async function isPortListening(port: number, host = '127.0.0.1'): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: host,
      port,
      socket: {
        data() {},
        open() {},
        close() {},
        error() {},
      },
    });

    socket.end();

    return true;
  } catch {
    return false;
  }
}

describe('MemorystoreService', () => {
  let storage: StorageManager;
  let logger: Logger;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    logger = new Logger('test', 'error');
  });

  test('getRoutes_calledBeforeInitialize_throws', () => {
    const service = new MemorystoreService(storage, logger, { enabled: false });

    expect(() => service.getRoutes()).toThrow();
  });

  test('getRoutes_afterInitialize_returnsExactlyThirtyEightUniqueRouteIds', async () => {
    const service = new MemorystoreService(storage, logger, { enabled: false });

    await service.initialize();

    const routes = service.getRoutes();

    expect(routes).toHaveLength(38);
    expect(new Set(routes.map(r => r.id)).size).toBe(38);
  });

  test('getRoutes_everyRouteIdIsPrefixedWithMemorystore', async () => {
    const service = new MemorystoreService(storage, logger, { enabled: false });

    await service.initialize();

    const routes = service.getRoutes();

    expect(routes.every(r => r.id.startsWith('memorystore.'))).toBe(true);
  });

  test('getRoutes_afterInitialize_matchesTheExactDiscoveryDocumentMethodAndPathTable', async () => {
    const service = new MemorystoreService(storage, logger, { enabled: false });

    await service.initialize();

    const routes = service.getRoutes();
    const actual = new Set(routes.map(r => `${r.method} ${r.path}`));
    const expected = new Set(EXPECTED_ROUTES.map(([method, path]) => `${method} ${path}`));

    expect(actual).toEqual(expected);
  });

  test('initialize_onRestart_reSpawnsAServerForEveryPersistedActiveInstanceAndRewritesDiscoveryEndpoints', async () => {
    const dataPlaneOptions = {
      enabled: true,
      binaryPath: FAKE_VALKEY_SERVER,
      portRangeStart: 18500,
      portRangeEnd: 18510,
    };

    const firstService = new MemorystoreService(storage, logger, dataPlaneOptions);

    await firstService.initialize();

    const createRoute = firstService.getRoutes().find(r => r.id === 'memorystore.instances.create');

    if (!createRoute) throw new Error('memorystore.instances.create route not found');

    const createResponse = await createRoute.handler(
      {
        method: 'POST',
        path: '/v1/projects/p/locations/us-central1/instances',
        query: { instanceId: 'restart-me' },
        headers: {},
        params: { project: 'p', location: 'us-central1' },
        body: {},
        originalRequest: new Request('http://localhost'),
      },
      { routeId: 'test', startTime: Date.now(), metadata: {}, logger }
    );

    const createdOperation = createResponse.body as {
      response?: { discoveryEndpoints?: Array<{ port: number }> };
    };
    const originalPort = createdOperation.response?.discoveryEndpoints?.[0]?.port;

    if (originalPort == null) {
      throw new Error('created instance did not report a discoveryEndpoints port');
    }

    expect(originalPort).toBeGreaterThanOrEqual(18500);
    expect(originalPort).toBeLessThanOrEqual(18510);
    expect(await isPortListening(originalPort)).toBe(true);

    await firstService.stop();

    // Proves the port was actually torn down by THIS service instance,
    // rather than merely re-checking a port number that could coincidentally
    // match a leaked, still-running process.
    expect(await isPortListening(originalPort)).toBe(false);

    const secondService = new MemorystoreService(storage, logger, dataPlaneOptions);

    await secondService.initialize();

    const getRoute = secondService.getRoutes().find(r => r.id === 'memorystore.instances.get');

    if (!getRoute) throw new Error('memorystore.instances.get route not found');

    const getResponse = await getRoute.handler(
      {
        method: 'GET',
        path: '/v1/projects/p/locations/us-central1/instances/restart-me',
        query: {},
        headers: {},
        params: { project: 'p', location: 'us-central1', instance: 'restart-me' },
        body: undefined,
        originalRequest: new Request('http://localhost'),
      },
      { routeId: 'test', startTime: Date.now(), metadata: {}, logger }
    );

    const rehydratedInstance = getResponse.body as {
      discoveryEndpoints?: Array<{ port: number }>;
    };
    const rehydratedPort = rehydratedInstance.discoveryEndpoints?.[0]?.port;

    if (rehydratedPort == null) {
      throw new Error('rehydrated instance did not report a discoveryEndpoints port');
    }

    // Proves the port came from the manager's allocator on THIS restart, not
    // simply replayed from the stale persisted row.
    expect(rehydratedPort).toBeGreaterThanOrEqual(18500);
    expect(rehydratedPort).toBeLessThanOrEqual(18510);
    expect(await isPortListening(rehydratedPort)).toBe(true);

    await secondService.stop();

    expect(await isPortListening(rehydratedPort)).toBe(false);
  });

  test('initialize_whenOneActiveInstanceCannotAcquireADataPlanePort_degradesThatInstanceInsteadOfAbortingStartup', async () => {
    const ctx = { routeId: 'test', startTime: Date.now(), metadata: {}, logger };

    const seed = new MemorystoreService(storage, logger, {
      enabled: true,
      binaryPath: FAKE_VALKEY_SERVER,
      portRangeStart: 18900,
      portRangeEnd: 18902,
    });

    await seed.initialize();

    const createRoute = seed.getRoutes().find(r => r.id === 'memorystore.instances.create');

    if (!createRoute) throw new Error('memorystore.instances.create route not found');

    for (const instanceId of ['alpha', 'beta']) {
      await createRoute.handler(
        {
          method: 'POST',
          path: '/v1/projects/p/locations/us-central1/instances',
          query: { instanceId },
          headers: {},
          params: { project: 'p', location: 'us-central1' },
          body: {},
          originalRequest: new Request('http://localhost'),
        },
        ctx
      );
    }

    await seed.stop();

    // Restart with a single-port range: only one of the two persisted ACTIVE
    // instances can acquire a data-plane port; the other's degraded fallback
    // throws FAILED_PRECONDITION. That must degrade only that instance, not
    // abort the whole emulator's startup.
    const restarted = new MemorystoreService(storage, logger, {
      enabled: true,
      binaryPath: FAKE_VALKEY_SERVER,
      portRangeStart: 18950,
      portRangeEnd: 18950,
    });

    await restarted.initialize();

    const listRoute = restarted.getRoutes().find(r => r.id === 'memorystore.instances.list');

    if (!listRoute) throw new Error('memorystore.instances.list route not found');

    const listResponse = await listRoute.handler(
      {
        method: 'GET',
        path: '/v1/projects/p/locations/us-central1/instances',
        query: {},
        headers: {},
        params: { project: 'p', location: 'us-central1' },
        body: undefined,
        originalRequest: new Request('http://localhost'),
      },
      ctx
    );

    const body = listResponse.body as { instances: unknown[] };

    expect(body.instances.length).toBe(2);

    await restarted.stop();
  });

  test('handleListOperations_givenANegativePageSize_returnsAllOperationsWithNoBogusNextPageToken', async () => {
    const service = new MemorystoreService(storage, logger, { enabled: false });

    await service.initialize();

    const routes = service.getRoutes();
    const ctx = { routeId: 'test', startTime: Date.now(), metadata: {}, logger };
    const createRoute = routes.find(r => r.id === 'memorystore.instances.create');
    const listRoute = routes.find(r => r.id === 'memorystore.operations.list');

    if (!createRoute || !listRoute) throw new Error('required routes not found');

    for (const instanceId of ['cache1', 'cache2', 'cache3']) {
      await createRoute.handler(
        {
          method: 'POST',
          path: '/v1/projects/p/locations/us-central1/instances',
          query: { instanceId },
          headers: {},
          params: { project: 'p', location: 'us-central1' },
          body: {},
          originalRequest: new Request('http://localhost'),
        },
        ctx
      );
    }

    const response = await listRoute.handler(
      {
        method: 'GET',
        path: '/v1/projects/p/locations/us-central1/operations',
        query: { pageSize: '-1' },
        headers: {},
        params: { project: 'p', location: 'us-central1' },
        body: undefined,
        originalRequest: new Request('http://localhost'),
      },
      ctx
    );

    const body = response.body as { operations: unknown[]; nextPageToken?: string };

    // A negative pageSize reaching the memory provider slices to `-1` and mints
    // a self-referential nextPageToken of "-1"; sanitizing it to undefined
    // returns the full set with no token.
    expect(body.operations.length).toBe(3);
    expect(body.nextPageToken).toBeUndefined();
  });
});
