/**
 * Tests for CloudSqlService wiring
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { RouteContext, RouteRequest } from '@/core/gateway/request-router.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { CloudSqlService } from './index.ts';

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/v1/projects/p1/instances',
    query: {},
    headers: {},
    params: { project: 'p1' },
    body: undefined,
    originalRequest: new Request('http://localhost/'),
    ...overrides,
  };
}

function makeContext(): RouteContext {
  return {
    routeId: 'test',
    startTime: Date.now(),
    metadata: {},
    logger: new Logger('CloudSqlTest', 'error'),
  };
}

describe('CloudSqlService', () => {
  let storage: StorageManager;
  let service: CloudSqlService;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    service = new CloudSqlService(storage, new Logger('CloudSqlTest', 'error'));
  });

  test('getRoutes throws before initialize', () => {
    expect(() => service.getRoutes()).toThrow('not initialized');
  });

  test('initialize wires the 20 GCP routes', async () => {
    await service.initialize();

    expect(service.getRoutes()).toHaveLength(20);
  });

  test('a created instance is retrievable through the routes', async () => {
    await service.initialize();

    const routes = service.getRoutes();
    const insertRoute = routes.find(route => route.id === 'cloudsql.instances.insert');
    const getRoute = routes.find(route => route.id === 'cloudsql.instances.get');

    expect(insertRoute).toBeDefined();
    expect(getRoute).toBeDefined();

    const insertResponse = await insertRoute?.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p1' },
        body: { name: 'db-a', databaseVersion: 'POSTGRES_16' },
      }),
      makeContext()
    );

    expect(insertResponse?.status).toBe(200);

    const getResponse = await getRoute?.handler(
      makeRequest({ params: { project: 'p1', instance: 'db-a' } }),
      makeContext()
    );

    expect(getResponse?.status).toBe(200);

    const instance = getResponse?.body as { kind: string; state: string };

    expect(instance.kind).toBe('sql#instance');
    expect(instance.state).toBe('RUNNABLE');
  });

  test('control-plane records persist across service instances over the same storage', async () => {
    await service.initialize();

    const insertRoute = service.getRoutes().find(route => route.id === 'cloudsql.instances.insert');

    await insertRoute?.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p1' },
        body: { name: 'db-a', databaseVersion: 'POSTGRES_16' },
      }),
      makeContext()
    );

    await service.stop();

    const revived = new CloudSqlService(storage, new Logger('CloudSqlTest', 'error'));

    await revived.initialize();

    const getRoute = revived.getRoutes().find(route => route.id === 'cloudsql.instances.get');

    const response = await getRoute?.handler(
      makeRequest({ params: { project: 'p1', instance: 'db-a' } }),
      makeContext()
    );

    expect(response?.status).toBe(200);

    await revived.stop();
  });
});
