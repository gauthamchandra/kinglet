/**
 * Cross-service route registration.
 *
 * Every emulated service registers into one RequestRouter on a single port, so two
 * services claiming the same method + path silently shadow each other. These tests
 * assemble the full route table the way src/index.ts does and prove it is conflict-free.
 */

import { describe, expect, test } from 'bun:test';
import {
  buildComposedOperationsRoutes,
  type ComposableOperationsStore,
  isComposedOperationsPath,
} from '@/core/gateway/composable-operations.ts';
import { createLocationRoutes } from '@/core/gateway/location-routes.ts';
import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import { RequestRouter } from '@/core/gateway/request-router.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { CloudKmsService } from '@/services/kms/index.ts';
import { MemorystoreService } from '@/services/memorystore/index.ts';
import { PubSubService } from '@/services/pubsub/index.ts';
import { SchedulerService } from '@/services/scheduler/index.ts';
import { CloudStorageService } from '@/services/storage/index.ts';
import { CloudTasksService } from '@/services/tasks/index.ts';
import { CloudWorkflowsService } from '@/services/workflows/index.ts';
import { Logger } from '@/shared/utils/logger.ts';

interface EmulatedService {
  initialize(): Promise<void>;
  getRoutes(): RouteDefinition[];
}

async function registerEveryService(): Promise<RequestRouter> {
  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const logger = new Logger('test', 'error');
  const router = new RequestRouter(logger);

  for (const route of createLocationRoutes(logger)) {
    router.addRoute(route);
  }

  const workflowsService = new CloudWorkflowsService(storage, logger);
  const memorystoreService = new MemorystoreService(storage, logger, { enabled: false });

  const services: EmulatedService[] = [
    new SchedulerService(storage, logger),
    new PubSubService(storage, logger),
    new CloudTasksService(storage, logger),
    new CloudStorageService(storage, logger),
    new CloudKmsService(storage, logger),
    workflowsService,
    memorystoreService,
  ];

  for (const service of services) {
    await service.initialize();
  }

  // Workflows and Memorystore share the operations paths; the composed set owns
  // them and each service's own copy is dropped, exactly as src/index.ts does.
  const stores: ComposableOperationsStore[] = [
    memorystoreService.getComposableOperationsStore(),
    workflowsService.getComposableOperationsStore(),
  ];

  for (const route of buildComposedOperationsRoutes(stores, logger)) {
    router.addRoute(route);
  }

  for (const service of services) {
    for (const route of service.getRoutes()) {
      if (isComposedOperationsPath(route.path)) continue;

      router.addRoute(route);
    }
  }

  return router;
}

describe('full route table', () => {
  test('registers every service without two of them claiming the same path', async () => {
    const router = await registerEveryService();

    expect(router.getAllRoutes().length).toBeGreaterThan(100);
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
});
