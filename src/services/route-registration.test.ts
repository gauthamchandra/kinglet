/**
 * Cross-service route registration.
 *
 * Every emulated service registers into one RequestRouter on a single port, so two
 * services claiming the same method + path silently shadow each other. These tests
 * assemble the full route table the way src/index.ts does and prove it is conflict-free.
 *
 * The fallback case is the signed-URL shape (`/:bucket/**`). It is registered here as
 * three dummy routes, not as storage handlers. ADR-020.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildComposedOperationsRoutes,
  type ComposableOperationsStore,
  isComposedOperationsPath,
} from '@/core/gateway/composable-operations.ts';
import { createLocationRoutes } from '@/core/gateway/location-routes.ts';
import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import { RequestRouter } from '@/core/gateway/request-router.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { buildHealthBody } from '@/health-status.ts';
import { AlloyDbService } from '@/services/alloydb/index.ts';
import { CloudSqlService } from '@/services/cloudsql/index.ts';
import { ComputeService } from '@/services/compute/index.ts';
import { CloudKmsService } from '@/services/kms/index.ts';
import { MemorystoreService } from '@/services/memorystore/index.ts';
import { NetworkSecurityService } from '@/services/networksecurity/index.ts';
import { PubSubService } from '@/services/pubsub/index.ts';
import { SchedulerService } from '@/services/scheduler/index.ts';
import { SecretsService } from '@/services/secrets/index.ts';
import { CloudStorageService } from '@/services/storage/index.ts';
import { CloudTasksService } from '@/services/tasks/index.ts';
import { CloudWorkflowsService } from '@/services/workflows/index.ts';
import { Logger } from '@/shared/utils/logger.ts';

/**
 * Fill a template with a colon-free token.
 *
 * <p>A value that itself contained `:pause` would also match the custom-verb
 * sibling, and that sibling wins the length tie-break. `**` is expanded to two
 * segments so a single-segment parameter does not stand in for a wildcard.
 */
function concretePath(template: string): string {
  return template
    .replace(/\{[^{}=]+\}/g, 'n')
    .replace(/(?<=\/):[a-zA-Z_][a-zA-Z0-9_]*/g, 'n')
    .replace(/\*\*/g, 'w/x')
    .replace(/\*/g, 'w');
}

function echoRoute(route: RouteDefinition): RouteDefinition {
  return {
    ...route,
    handler: () => ({ status: 200, body: { routeId: route.id } }),
  };
}

/**
 * @param echoRouteId Replace each handler with one that returns its route id.
 * Matching ignores the handler; this is how `route()` reports which id won.
 */
async function registerEveryService(echoRouteId = false): Promise<RequestRouter> {
  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const logger = new Logger('test', 'error');
  const router = new RequestRouter(logger);
  const blobRoot = await mkdtemp(join(tmpdir(), 'kinglet-routes-'));

  try {
    const add = (route: RouteDefinition): void => {
      router.addRoute(echoRouteId ? echoRoute(route) : route);
    };

    add({
      id: 'health',
      method: 'GET',
      path: '/health',
      handler: () => ({ status: 200, body: buildHealthBody() }),
    });

    for (const route of createLocationRoutes(logger)) {
      add(route);
    }

    const schedulerService = new SchedulerService(storage, logger);
    const pubsubService = new PubSubService(storage, logger);
    const tasksService = new CloudTasksService(storage, logger);
    const secretsService = new SecretsService(storage, logger);
    const cloudStorageService = new CloudStorageService(storage, logger, {
      blobPath: blobRoot,
      storageType: 'memory',
    });
    const workflowsService = new CloudWorkflowsService(storage, logger);
    const kmsService = new CloudKmsService(storage, logger);
    const memorystoreService = new MemorystoreService(storage, logger, { enabled: false });
    const alloydbService = new AlloyDbService(storage, logger, { enabled: false });
    const cloudSqlService = new CloudSqlService(storage, logger, { enabled: false });
    const computeService = new ComputeService(storage, logger);
    const networkSecurityService = new NetworkSecurityService(storage, logger);

    await schedulerService.initialize();
    await pubsubService.initialize();
    await tasksService.initialize();
    await secretsService.initialize();
    await cloudStorageService.initialize();
    await workflowsService.initialize();
    await kmsService.initialize();
    await memorystoreService.initialize();
    await alloydbService.initialize();
    await cloudSqlService.initialize();
    await computeService.initialize();
    await networkSecurityService.initialize();

    // Same order as src/index.ts. Scheduler, Pub/Sub, Tasks, Secrets, Storage,
    // KMS, Cloud SQL, and Compute register as they start. Workflows, Memorystore,
    // AlloyDB, and Network Security wait until the composed operations set owns
    // the shared paths.
    for (const route of schedulerService.getRoutes()) {
      add(route);
    }

    for (const route of pubsubService.getRoutes()) {
      add(route);
    }

    for (const route of tasksService.getRoutes()) {
      add(route);
    }

    for (const route of secretsService.getRoutes()) {
      add(route);
    }

    for (const route of cloudStorageService.getRoutes()) {
      add(route);
    }

    for (const route of kmsService.getRoutes()) {
      add(route);
    }

    for (const route of cloudSqlService.getRoutes()) {
      add(route);
    }

    for (const route of computeService.getRoutes()) {
      add(route);
    }

    const stores: ComposableOperationsStore[] = [
      memorystoreService.getComposableOperationsStore(),
      workflowsService.getComposableOperationsStore(),
      alloydbService.getComposableOperationsStore(),
      networkSecurityService.getComposableOperationsStore(),
    ];

    const composedOperationsRegistered = stores.length > 1;

    if (composedOperationsRegistered) {
      for (const route of buildComposedOperationsRoutes(stores, logger)) {
        add(route);
      }
    }

    const registerServiceRoutes = (routes: RouteDefinition[]): void => {
      for (const route of routes) {
        if (composedOperationsRegistered && isComposedOperationsPath(route.path)) {
          continue;
        }

        add(route);
      }
    };

    registerServiceRoutes(workflowsService.getRoutes());
    registerServiceRoutes(memorystoreService.getRoutes());
    registerServiceRoutes(alloydbService.getRoutes());
    registerServiceRoutes(networkSecurityService.getRoutes());

    return router;
  } finally {
    await rm(blobRoot, { recursive: true, force: true });
  }
}

const UNCLAIMED_PATH = '/my-bucket/nested/object';

async function matchedRouteId(
  router: RequestRouter,
  method: string,
  path: string
): Promise<{ status: number; routeId: string | undefined }> {
  const response = await router.route(new Request(`http://localhost${path}`, { method }));
  const body = (await response.json()) as { routeId?: string };

  return { status: response.status, routeId: body.routeId };
}

async function expectRoutesResolveToThemselves(
  router: RequestRouter,
  routes: readonly RouteDefinition[]
): Promise<void> {
  const failures: string[] = [];

  for (const route of routes) {
    const path = concretePath(route.path);
    const matched = await matchedRouteId(router, route.method, path);

    if (matched.status !== 200 || matched.routeId !== route.id) {
      failures.push(
        `${route.method} ${route.path} via ${path} => ${matched.status} ${matched.routeId ?? 'none'}, expected ${route.id}`
      );
    }
  }

  expect(failures).toEqual([]);
}

describe('full route table', () => {
  test('registers every service without two of them claiming the same path', async () => {
    const router = await registerEveryService();
    const ids = new Set(router.getAllRoutes().map(route => route.id));

    expect(router.getAllRoutes().length).toBeGreaterThan(100);
    expect(ids.has('health')).toBe(true);
    expect(ids.has('projects.secrets.create')).toBe(true);
    expect(ids.has('alloydb.clusters.instances.get')).toBe(true);
    expect(ids.has('cloudsql.instances.get')).toBe(true);
    expect(ids.has('compute.securityPolicies.get')).toBe(true);
  });

  test('serves the shared v1 locations endpoint rather than a per-service copy', async () => {
    const router = await registerEveryService();

    const res = await router.route(new Request('http://localhost/v1/projects/p/locations'));

    expect(res.status).toBe(200);

    const { locations } = (await res.json()) as { locations: Array<{ locationId: string }> };

    expect(locations.map(l => l.locationId)).toContain('global');
  });

  test('leaves the KMS location-level custom verb reachable', async () => {
    const router = await registerEveryService();

    const res = await router.route(
      new Request('http://localhost/v1/projects/p/locations/us-central1:generateRandomBytes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lengthBytes: 16 }),
      })
    );

    expect(res.status).toBe(200);

    const { data } = (await res.json()) as { data: string };

    expect(Buffer.from(data, 'base64').length).toBe(16);
  });

  test('resolves every registered route to itself before and after fallbacks', async () => {
    const router = await registerEveryService(true);
    const routes = router.getAllRoutes();

    await expectRoutesResolveToThemselves(router, routes);

    const unclaimed = await matchedRouteId(router, 'GET', UNCLAIMED_PATH);

    expect(unclaimed.status).toBe(404);

    const fallbacks = [
      { id: 'fallback.get', method: 'GET' },
      { id: 'fallback.put', method: 'PUT' },
      { id: 'fallback.delete', method: 'DELETE' },
    ] as const;

    for (const fallback of fallbacks) {
      router.addRoute({
        id: fallback.id,
        method: fallback.method,
        path: '/:bucket/**',
        fallback: true,
        handler: () => ({ status: 200, body: { routeId: fallback.id } }),
      });
    }

    expect(router.getAllRoutes().length).toBe(routes.length + fallbacks.length);

    await expectRoutesResolveToThemselves(router, routes);

    for (const fallback of fallbacks) {
      const matched = await matchedRouteId(router, fallback.method, UNCLAIMED_PATH);

      expect(matched).toEqual({ status: 200, routeId: fallback.id });
    }

    const post = await matchedRouteId(router, 'POST', UNCLAIMED_PATH);

    expect(post.status).toBe(404);
  });
});
