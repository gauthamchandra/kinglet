/**
 * Regression test for the operations-route-shadowing bug: Workflows and
 * Memorystore both register `/v1/projects/:project/locations/:location/operations[/:operationId]`
 * routes, and a real `RequestRouter`'s specificity scoring picks exactly one
 * winner per path (see request-router.ts `matchPath`). Every other test
 * boots either service alone, so this composes both on one router the same
 * way src/index.ts does in production.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { AlloyDbService } from '@/services/alloydb/index.ts';
import { MemorystoreService } from '@/services/memorystore/index.ts';
import { CloudWorkflowsService } from '@/services/workflows/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import type { ComposableOperationsStore } from './composable-operations.ts';
import { buildComposedOperationsRoutes } from './composable-operations.ts';
import type { RouteDefinition, RouteResponse } from './request-router.ts';
import { RequestRouter } from './request-router.ts';

const PROJECT = 'p';
const LOCATION = 'us-central1';

async function buildComposedRouter(): Promise<{
  router: RequestRouter;
  memorystoreService: MemorystoreService;
  workflowsService: CloudWorkflowsService;
}> {
  const storage = new StorageManager();

  await storage.initialize({ type: 'memory' });

  const memorystoreService = new MemorystoreService(storage, new Logger('test', 'error'), {
    enabled: false,
  });
  const workflowsService = new CloudWorkflowsService(storage, new Logger('test', 'error'));

  await memorystoreService.initialize();
  await workflowsService.initialize();

  const router = new RequestRouter(new Logger('test', 'error'));

  // Registered first, exactly as src/index.ts does, so the composed routes
  // win the router's tie-break over each service's own operations routes.
  for (const route of buildComposedOperationsRoutes(
    [
      memorystoreService.getComposableOperationsStore(),
      workflowsService.getComposableOperationsStore(),
    ],
    new Logger('test', 'error')
  )) {
    router.addRoute(route);
  }

  for (const route of workflowsService.getRoutes()) {
    router.addRoute(route);
  }

  for (const route of memorystoreService.getRoutes()) {
    router.addRoute(route);
  }

  return { router, memorystoreService, workflowsService };
}

describe('composed operations routing (Memorystore + Workflows on one RequestRouter)', () => {
  let router: RequestRouter;

  beforeEach(async () => {
    ({ router } = await buildComposedRouter());
  });

  test('composedOperations_getRoute_returnsAMemorystoreCreateOperationEvenThoughWorkflowsRegistersTheSamePathShape', async () => {
    const createResponse = await router.route(
      new Request(
        `http://localhost/v1/projects/${PROJECT}/locations/${LOCATION}/instances?instanceId=cache1`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      )
    );

    expect(createResponse.status).toBe(200);

    const operation = (await createResponse.json()) as { name: string };

    const getResponse = await router.route(new Request(`http://localhost/v1/${operation.name}`));

    expect(getResponse.status).toBe(200);

    const fetchedOperation = (await getResponse.json()) as { name: string };

    expect(fetchedOperation.name).toBe(operation.name);
  });

  test('composedOperations_getRoute_returnsAWorkflowsCreateOperationTooSoNeitherServiceIsPermanentlyShadowed', async () => {
    const createResponse = await router.route(
      new Request(
        `http://localhost/v1/projects/${PROJECT}/locations/${LOCATION}/workflows?workflowId=w`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sourceContents: 'main:\n  steps: []' }),
        }
      )
    );

    expect(createResponse.status).toBe(200);

    const operation = (await createResponse.json()) as { name: string };

    const getResponse = await router.route(new Request(`http://localhost/v1/${operation.name}`));

    expect(getResponse.status).toBe(200);

    const fetchedOperation = (await getResponse.json()) as { name: string };

    expect(fetchedOperation.name).toBe(operation.name);
  });

  test('composedOperations_listRoute_mergesOperationsFromBothServices', async () => {
    await router.route(
      new Request(
        `http://localhost/v1/projects/${PROJECT}/locations/${LOCATION}/instances?instanceId=cache1`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      )
    );

    await router.route(
      new Request(
        `http://localhost/v1/projects/${PROJECT}/locations/${LOCATION}/workflows?workflowId=w`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sourceContents: 'main:\n  steps: []' }),
        }
      )
    );

    const listResponse = await router.route(
      new Request(`http://localhost/v1/projects/${PROJECT}/locations/${LOCATION}/operations`)
    );

    expect(listResponse.status).toBe(200);

    const result = (await listResponse.json()) as {
      operations: Array<{ metadata: { target: string } }>;
    };

    expect(result.operations.some(op => op.metadata.target.includes('/instances/cache1'))).toBe(
      true
    );
    expect(result.operations.some(op => op.metadata.target.includes('/workflows/w'))).toBe(true);
  });

  test('composedOperations_listRoute_givenPageSize_truncatesTheMergedResultInsteadOfApplyingPageSizePerStore', async () => {
    for (const instanceId of ['cache1', 'cache2', 'cache3']) {
      await router.route(
        new Request(
          `http://localhost/v1/projects/${PROJECT}/locations/${LOCATION}/instances?instanceId=${instanceId}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          }
        )
      );
    }

    for (const workflowId of ['w1', 'w2', 'w3']) {
      await router.route(
        new Request(
          `http://localhost/v1/projects/${PROJECT}/locations/${LOCATION}/workflows?workflowId=${workflowId}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sourceContents: 'main:\n  steps: []' }),
          }
        )
      );
    }

    const listResponse = await router.route(
      new Request(
        `http://localhost/v1/projects/${PROJECT}/locations/${LOCATION}/operations?pageSize=2`
      )
    );

    expect(listResponse.status).toBe(200);

    const result = (await listResponse.json()) as {
      operations: Array<{ name: string }>;
      nextPageToken?: string;
    };

    // 6 operations exist across both stores (3 Memorystore + 3 Workflows); a
    // pageSize of 2 fanned out per-store instead of applied to the merged
    // result would return up to 4 here instead of exactly 2.
    expect(result.operations.length).toBe(2);
    expect(result.nextPageToken).toBe('2');
  });

  test('composedOperations_listRoute_givenNoPageSize_appliesTheSameHundredRowDefaultEachServiceAppliesAlone', async () => {
    for (let index = 0; index < 101; index++) {
      await router.route(
        new Request(
          `http://localhost/v1/projects/${PROJECT}/locations/${LOCATION}/instances?instanceId=cache${String(index).padStart(3, '0')}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          }
        )
      );
    }

    const listResponse = await router.route(
      new Request(`http://localhost/v1/projects/${PROJECT}/locations/${LOCATION}/operations`)
    );

    expect(listResponse.status).toBe(200);

    const result = (await listResponse.json()) as {
      operations: Array<{ name: string }>;
      nextPageToken?: string;
    };

    // Each service's own listOperations defaults an absent pageSize to 100, so
    // a composed route that treats it as unbounded makes pagination depend on
    // which services happen to be running rather than on the request.
    expect(result.operations.length).toBe(100);
    expect(result.nextPageToken).toBe('100');
  });

  test('composedOperations_listRoute_givenAZeroOrNegativePageSize_returnsAllOperationsWithNoNextPageTokenInsteadOfLoopingForever', async () => {
    await router.route(
      new Request(
        `http://localhost/v1/projects/${PROJECT}/locations/${LOCATION}/instances?instanceId=cache1`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      )
    );

    for (const pageSize of ['0', '-5']) {
      const listResponse = await router.route(
        new Request(
          `http://localhost/v1/projects/${PROJECT}/locations/${LOCATION}/operations?pageSize=${pageSize}`
        )
      );

      expect(listResponse.status).toBe(200);

      const result = (await listResponse.json()) as {
        operations: Array<{ name: string }>;
        nextPageToken?: string;
      };

      // pageSize=0 means "server default" in GCP; treating it as a literal
      // page of size 0 previously returned [] with nextPageToken='0', a
      // token that re-requests the same empty page forever.
      expect(result.operations.length).toBe(1);
      expect(result.nextPageToken).toBeUndefined();
    }
  });

  test('composedOperations_listRoute_givenAMalformedPageToken_startsFromTheBeginningInsteadOfSlicingAtNaN', async () => {
    await router.route(
      new Request(
        `http://localhost/v1/projects/${PROJECT}/locations/${LOCATION}/instances?instanceId=cache1`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      )
    );

    const listResponse = await router.route(
      new Request(
        `http://localhost/v1/projects/${PROJECT}/locations/${LOCATION}/operations?pageSize=1&pageToken=abc`
      )
    );

    expect(listResponse.status).toBe(200);

    const result = (await listResponse.json()) as { operations: Array<{ name: string }> };

    expect(result.operations.length).toBe(1);
  });
});

describe('cancel composition across services', () => {
  /**
   * Regression: AlloyDB and Memorystore both register a structurally identical
   * `.../operations/{id}:cancel`. `buildComposedOperationsRoutes` originally
   * composed only list/get/delete, so cancel fell through to `RequestRouter`'s
   * one-winner-per-path scoring — where the tie-break is raw path length, and
   * AlloyDB's `:operationId` beat Memorystore's `:operation` by two characters.
   * The result was a 404 when cancelling a Memorystore LRO that existed.
   */
  test('buildComposedOperationsRoutes_includesCancelSoNoServicesCancelIsShadowed', () => {
    const routes = buildComposedOperationsRoutes([stubStore(), stubStore()], testLogger());

    const cancelRoute = routes.find(route => route.id === 'composedOperations.cancel');

    expect(cancelRoute?.method).toBe('POST');
    expect(cancelRoute?.path).toBe(
      '/v1/projects/:project/locations/:location/operations/:operationId:cancel'
    );
  });

  test('composedCancel_cancelsThroughWhicheverStoreOwnsTheOperation', async () => {
    const owning = stubStore({ 'projects/p/locations/l/operations/op-1': true });
    const other = stubStore();
    const routes = buildComposedOperationsRoutes([other, owning], testLogger());

    const response = await invokeRoute(routes, 'composedOperations.cancel', 'op-1');

    expect(response.status).toBe(200);
    expect(owning.cancelled).toEqual(['projects/p/locations/l/operations/op-1']);
  });

  test('composedCancel_givenAnOperationNoStoreOwns_returns404', async () => {
    const routes = buildComposedOperationsRoutes([stubStore(), stubStore()], testLogger());

    const response = await invokeRoute(routes, 'composedOperations.cancel', 'missing');

    expect(response.status).toBe(404);
  });

  /**
   * Workflows' API has no `operations.cancel`, so its store omits the method. A
   * store without it must be skipped rather than crashing the composed handler.
   */
  test('composedCancel_skipsAStoreThatDoesNotSupportCancelling', async () => {
    const cancellable = stubStore({ 'projects/p/locations/l/operations/op-1': true });
    const notCancellable = stubStore();

    delete (notCancellable as { cancelOperation?: unknown }).cancelOperation;

    const routes = buildComposedOperationsRoutes([notCancellable, cancellable], testLogger());
    const response = await invokeRoute(routes, 'composedOperations.cancel', 'op-1');

    expect(response.status).toBe(200);
    expect(cancellable.cancelled).toEqual(['projects/p/locations/l/operations/op-1']);
  });
});

interface StubStore extends ComposableOperationsStore {
  cancelled: string[];
}

function stubStore(cancellable: Record<string, boolean> = {}): StubStore {
  const cancelled: string[] = [];

  return {
    cancelled,
    getOperation: async () => null,
    listOperations: async () => ({ operations: [] }),
    deleteOperation: async () => false,
    cancelOperation: async (name: string) => {
      if (cancellable[name] !== true) return false;

      cancelled.push(name);

      return true;
    },
  };
}

function testLogger() {
  return new Logger('composed-operations-test', 'error');
}

async function invokeRoute(
  routes: RouteDefinition[],
  routeId: string,
  operationId: string
): Promise<RouteResponse> {
  const route = routes.find(candidate => candidate.id === routeId);

  if (!route) throw new Error(`No route with id "${routeId}"`);

  return route.handler(
    {
      method: route.method,
      path: '/',
      query: {},
      headers: {},
      params: { project: 'p', location: 'l', operationId },
      originalRequest: new Request('http://localhost/'),
    },
    { routeId, startTime: 0, metadata: {}, logger: testLogger() }
  );
}

describe('composed operations routing (AlloyDB + Memorystore on one RequestRouter)', () => {
  let router: RequestRouter;

  beforeEach(async () => {
    const storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    const memorystoreService = new MemorystoreService(storage, new Logger('test', 'error'), {
      enabled: false,
    });
    const alloydbService = new AlloyDbService(storage, new Logger('test', 'error'));

    await memorystoreService.initialize();
    await alloydbService.initialize();

    router = new RequestRouter(new Logger('test', 'error'));

    for (const route of buildComposedOperationsRoutes(
      [
        memorystoreService.getComposableOperationsStore(),
        alloydbService.getComposableOperationsStore(),
      ],
      new Logger('test', 'error')
    )) {
      router.addRoute(route);
    }

    for (const route of memorystoreService.getRoutes()) {
      router.addRoute(route);
    }

    for (const route of alloydbService.getRoutes()) {
      router.addRoute(route);
    }
  });

  async function createMemorystoreInstanceOperation(): Promise<string> {
    const response = await router.route(
      new Request(
        `http://localhost/v1/projects/${PROJECT}/locations/${LOCATION}/instances?instanceId=cache1`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      )
    );

    expect(response.status).toBe(200);

    return ((await response.json()) as { name: string }).name;
  }

  async function createAlloyDbClusterOperation(): Promise<string> {
    const response = await router.route(
      new Request(
        `http://localhost/v1/projects/${PROJECT}/locations/${LOCATION}/clusters?clusterId=db1`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            initialUser: { user: 'postgres' },
            networkConfig: { network: 'projects/p/global/networks/default' },
          }),
        }
      )
    );

    expect(response.status).toBe(200);

    return ((await response.json()) as { name: string }).name;
  }

  /**
   * The bug this pins: AlloyDB's cancel path is two characters longer than
   * Memorystore's (`:operationId` vs `:operation`), and the router's tie-break is
   * raw path length — so before cancel was composed, AlloyDB's handler answered
   * every cancel and a real Memorystore operation reported 404.
   */
  test('composedOperations_cancelRoute_cancelsAMemorystoreOperationRatherThanRoutingItToAlloyDb', async () => {
    const operationName = await createMemorystoreInstanceOperation();

    const cancelResponse = await router.route(
      new Request(`http://localhost/v1/${operationName}:cancel`, { method: 'POST' })
    );

    expect(cancelResponse.status).toBe(200);

    const afterwards = await router.route(new Request(`http://localhost/v1/${operationName}`));
    const operation = (await afterwards.json()) as {
      metadata: { requestedCancellation?: boolean };
    };

    expect(operation.metadata.requestedCancellation).toBe(true);
  });

  test('composedOperations_cancelRoute_alsoCancelsAnAlloyDbOperation', async () => {
    const operationName = await createAlloyDbClusterOperation();

    const cancelResponse = await router.route(
      new Request(`http://localhost/v1/${operationName}:cancel`, { method: 'POST' })
    );

    expect(cancelResponse.status).toBe(200);

    const afterwards = await router.route(new Request(`http://localhost/v1/${operationName}`));
    const operation = (await afterwards.json()) as {
      metadata: { requestedCancellation?: boolean };
    };

    expect(operation.metadata.requestedCancellation).toBe(true);
  });

  test('composedOperations_cancelRoute_givenAnOperationNeitherServiceOwns_returns404', async () => {
    const response = await router.route(
      new Request(
        `http://localhost/v1/projects/${PROJECT}/locations/${LOCATION}/operations/nope:cancel`,
        { method: 'POST' }
      )
    );

    expect(response.status).toBe(404);
  });

  test('composedOperations_getRoute_reachesBothServicesOperations', async () => {
    const memorystoreOperation = await createMemorystoreInstanceOperation();
    const alloydbOperation = await createAlloyDbClusterOperation();

    for (const name of [memorystoreOperation, alloydbOperation]) {
      const response = await router.route(new Request(`http://localhost/v1/${name}`));

      expect(response.status).toBe(200);
      expect(((await response.json()) as { name: string }).name).toBe(name);
    }
  });
});
