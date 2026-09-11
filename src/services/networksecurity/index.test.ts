import { describe, expect, test } from 'bun:test';
import type { HttpMethod, RouteRequest } from '@/core/gateway/request-router.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { NetworkSecurityService } from './index.ts';

const EXPECTED_ROUTES: ReadonlyArray<{ id: string; method: HttpMethod; path: string }> = [
  {
    id: 'networksecurity.operations.list',
    method: 'GET',
    path: '/v1/projects/:project/locations/:location/operations',
  },
  {
    id: 'networksecurity.operations.cancel',
    method: 'POST',
    path: '/v1/projects/:project/locations/:location/operations/:operationId:cancel',
  },
  {
    id: 'networksecurity.operations.get',
    method: 'GET',
    path: '/v1/projects/:project/locations/:location/operations/:operationId',
  },
  {
    id: 'networksecurity.operations.delete',
    method: 'DELETE',
    path: '/v1/projects/:project/locations/:location/operations/:operationId',
  },
  {
    id: 'networksecurity.addressGroups.create',
    method: 'POST',
    path: '/v1/projects/:project/locations/:location/addressGroups',
  },
  {
    id: 'networksecurity.addressGroups.list',
    method: 'GET',
    path: '/v1/projects/:project/locations/:location/addressGroups',
  },
  {
    id: 'networksecurity.addressGroups.get',
    method: 'GET',
    path: '/v1/projects/:project/locations/:location/addressGroups/:addressGroup',
  },
  {
    id: 'networksecurity.addressGroups.patch',
    method: 'PATCH',
    path: '/v1/projects/:project/locations/:location/addressGroups/:addressGroup',
  },
  {
    id: 'networksecurity.addressGroups.delete',
    method: 'DELETE',
    path: '/v1/projects/:project/locations/:location/addressGroups/:addressGroup',
  },
];

async function makeService(): Promise<NetworkSecurityService> {
  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  return new NetworkSecurityService(storage, new Logger('test', 'error'));
}

describe('NetworkSecurityService', () => {
  test('getRoutes throws before initialize', async () => {
    const service = await makeService();

    expect(() => service.getRoutes()).toThrow();
  });

  test('exposes the address-group and operations surface after initialize', async () => {
    const service = await makeService();
    await service.initialize();

    const routes = service.getRoutes().map(route => ({
      id: route.id,
      method: route.method,
      path: route.path,
    }));

    expect(routes).toEqual([...EXPECTED_ROUTES]);
  });

  test('start and stop are safe lifecycle no-ops', async () => {
    const service = await makeService();
    await service.initialize();

    expect(() => service.start()).not.toThrow();
    await expect(service.stop()).resolves.toBeUndefined();
  });

  test('operations get/list/delete/cancel round-trip a create LRO', async () => {
    const service = await makeService();
    await service.initialize();

    const created = await callRoute(service, 'networksecurity.addressGroups.create', {
      method: 'POST',
      params: { project: 'p', location: 'global' },
      query: { addressGroupId: 'web-allow' },
      body: { type: 'IPV4', capacity: 10 },
    });

    expect(created.status).toBe(200);

    const operationName = (created.body as { name: string }).name;
    const operationId = operationName.split('/').pop() ?? '';

    const fetched = await callRoute(service, 'networksecurity.operations.get', {
      params: { project: 'p', location: 'global', operationId },
    });

    expect(fetched.status).toBe(200);
    expect((fetched.body as { name: string }).name).toBe(operationName);

    const listed = await callRoute(service, 'networksecurity.operations.list', {
      params: { project: 'p', location: 'global' },
    });

    expect(listed.status).toBe(200);
    expect((listed.body as { operations: unknown[] }).operations).toHaveLength(1);

    const cancelled = await callRoute(service, 'networksecurity.operations.cancel', {
      method: 'POST',
      params: { project: 'p', location: 'global', operationId },
    });

    expect(cancelled.status).toBe(200);

    const deleted = await callRoute(service, 'networksecurity.operations.delete', {
      method: 'DELETE',
      params: { project: 'p', location: 'global', operationId },
    });

    expect(deleted.status).toBe(200);

    const missing = await callRoute(service, 'networksecurity.operations.get', {
      params: { project: 'p', location: 'global', operationId },
    });

    expect(missing.status).toBe(404);
  });

  test('getComposableOperationsStore throws before initialize', async () => {
    const service = await makeService();

    expect(() => service.getComposableOperationsStore()).toThrow();
  });

  test('getComposableOperationsStore reads and lists operations created by the service', async () => {
    const service = await makeService();
    await service.initialize();

    const created = await callRoute(service, 'networksecurity.addressGroups.create', {
      method: 'POST',
      params: { project: 'p', location: 'global' },
      query: { addressGroupId: 'web-allow' },
      body: { type: 'IPV4', capacity: 10 },
    });

    const name = (created.body as { name: string }).name;
    const store = service.getComposableOperationsStore();
    const operation = await store.getOperation(name);

    expect(operation?.name).toBe(name);

    const listed = await store.listOperations('p', 'global', 10);

    expect(listed.operations).toHaveLength(1);
    expect(store.cancelOperation).toBeTypeOf('function');
    expect(await store.cancelOperation?.(name)).toBe(true);
    expect(await store.deleteOperation(name)).toBe(true);
    expect(await store.getOperation(name)).toBeNull();
  });

  test('operations handlers return 404 for a missing operation', async () => {
    const service = await makeService();
    await service.initialize();

    const params = { project: 'p', location: 'global', operationId: 'missing' };

    expect((await callRoute(service, 'networksecurity.operations.get', { params })).status).toBe(
      404
    );
    expect(
      (await callRoute(service, 'networksecurity.operations.delete', { method: 'DELETE', params }))
        .status
    ).toBe(404);
    expect(
      (await callRoute(service, 'networksecurity.operations.cancel', { method: 'POST', params }))
        .status
    ).toBe(404);
  });
});

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

async function callRoute(
  service: NetworkSecurityService,
  routeId: string,
  overrides: Partial<RouteRequest> = {}
) {
  const route = service.getRoutes().find(candidate => candidate.id === routeId);

  if (!route) {
    throw new Error(`No route registered with id "${routeId}"`);
  }

  return route.handler(request(overrides), {
    routeId,
    startTime: 0,
    metadata: {},
    logger: new Logger('test', 'error'),
  });
}
