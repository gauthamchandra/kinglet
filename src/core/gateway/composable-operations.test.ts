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
import { MemorystoreService } from '@/services/memorystore/index.ts';
import { CloudWorkflowsService } from '@/services/workflows/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { buildComposedOperationsRoutes } from './composable-operations.ts';
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
