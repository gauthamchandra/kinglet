import { describe, expect, test } from 'bun:test';
import type { HttpMethod } from '@/core/gateway/request-router.ts';
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
});
