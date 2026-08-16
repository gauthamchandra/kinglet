/**
 * Unit tests for InstanceHandlers
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RouteContext, RouteDefinition, RouteRequest } from '@/core/gateway/request-router.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { InstanceHandlers } from './instance-handlers.ts';
import type { InstanceService } from './instance-service.ts';
import { MemoryStoreError } from './types.ts';

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/v1/projects/p/locations/us-central1/instances',
    query: {},
    headers: {},
    params: {},
    body: undefined,
    originalRequest: new Request('http://localhost'),
    ...overrides,
  };
}

function makeContext(): RouteContext {
  return {
    routeId: 'test',
    startTime: Date.now(),
    metadata: {},
    logger: new Logger('test', 'error'),
  };
}

function findRoute(routes: RouteDefinition[], id: string) {
  const route = routes.find(r => r.id === id);

  if (!route) throw new Error(`Route ${id} not found`);

  return route;
}

function makeOperationResponse(verb: string) {
  return {
    name: 'projects/p/locations/us-central1/operations/op-1',
    metadata: {
      '@type': 'type.googleapis.com/google.cloud.memorystore.v1.OperationMetadata',
      createTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:00:00.000Z',
      target: 'projects/p/locations/us-central1/instances/i',
      verb,
      apiVersion: 'v1',
    },
    done: true,
  };
}

describe('InstanceHandlers', () => {
  let mockService: InstanceService;
  let handlers: InstanceHandlers;

  beforeEach(() => {
    mockService = {
      createInstance: mock(() => Promise.resolve(makeOperationResponse('create'))),
      getInstance: mock(() =>
        Promise.resolve({ name: 'projects/p/locations/us-central1/instances/i', state: 'ACTIVE' })
      ),
      listInstances: mock(() => Promise.resolve({ instances: [] })),
      updateInstance: mock(() => Promise.resolve(makeOperationResponse('update'))),
      deleteInstance: mock(() => Promise.resolve(makeOperationResponse('delete'))),
      getCertificateAuthority: mock(() => Promise.resolve({ managedServerCa: {} })),
      backupInstance: mock(() => Promise.resolve(makeOperationResponse('backup'))),
      startMigration: mock(() => Promise.resolve(makeOperationResponse('startMigration'))),
      finishMigration: mock(() => Promise.resolve(makeOperationResponse('finishMigration'))),
      rescheduleMaintenance: mock(() =>
        Promise.resolve(makeOperationResponse('rescheduleMaintenance'))
      ),
      addTokenAuthUser: mock(() => Promise.resolve(makeOperationResponse('addTokenAuthUser'))),
    } as unknown as InstanceService;

    handlers = new InstanceHandlers(mockService, new Logger('test', 'error'));
  });

  test('getRoutes_returnsAllElevenInstanceRouteIds', () => {
    const ids = handlers.getRoutes().map(r => r.id);

    expect(ids).toContain('memorystore.instances.create');
    expect(ids).toContain('memorystore.instances.list');
    expect(ids).toContain('memorystore.instances.get');
    expect(ids).toContain('memorystore.instances.patch');
    expect(ids).toContain('memorystore.instances.delete');
    expect(ids).toContain('memorystore.instances.getCertificateAuthority');
    expect(ids).toContain('memorystore.instances.backup');
    expect(ids).toContain('memorystore.instances.startMigration');
    expect(ids).toContain('memorystore.instances.finishMigration');
    expect(ids).toContain('memorystore.instances.rescheduleMaintenance');
    expect(ids).toContain('memorystore.instances.addTokenAuthUser');
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('handleCreateInstance_returnsAnOperationWithMemorystoreOperationMetadataType', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.instances.create');

    const response = await route.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', location: 'us-central1' },
        query: { instanceId: 'i' },
        body: {},
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    const body = response.body as { done: boolean; metadata: { '@type': string } };

    expect(body.done).toBe(true);
    expect(body.metadata['@type']).toBe(
      'type.googleapis.com/google.cloud.memorystore.v1.OperationMetadata'
    );
    expect(mockService.createInstance).toHaveBeenCalled();
  });

  test('handleCreateInstance_passesInstanceIdQueryParamThroughToTheService', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.instances.create');

    await route.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', location: 'us-central1' },
        query: { instanceId: 'my-instance' },
        body: {},
      }),
      makeContext()
    );

    const call = (mockService.createInstance as ReturnType<typeof mock>).mock.calls[0] as unknown[];

    expect(call[2]).toBe('my-instance');
  });

  test('handleCreateInstance_missingInstanceId_returnsBadRequestAndPersistsNothing', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.instances.create');

    const response = await route.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', location: 'us-central1' },
        query: {},
        body: {},
      }),
      makeContext()
    );

    expect(response.status).toBe(400);
    expect(mockService.createInstance).not.toHaveBeenCalled();
  });

  test('handleGetInstance_returnsTheBareInstanceResource', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.instances.get');

    const response = await route.handler(
      makeRequest({ params: { project: 'p', location: 'us-central1', instance: 'i' } }),
      makeContext()
    );

    expect(response.status).toBe(200);
    const body = response.body as { name: string };

    expect(body.name).toBe('projects/p/locations/us-central1/instances/i');
  });

  test('handleGetInstance_givenNotFoundError_mapsTo404', async () => {
    (mockService.getInstance as ReturnType<typeof mock>).mockImplementation(() => {
      throw new MemoryStoreError('NOT_FOUND', 'Instance not found');
    });

    const route = findRoute(handlers.getRoutes(), 'memorystore.instances.get');

    const response = await route.handler(
      makeRequest({ params: { project: 'p', location: 'us-central1', instance: 'missing' } }),
      makeContext()
    );

    expect(response.status).toBe(404);
  });

  test('handleListInstances_passesPageSizePageTokenFilterAndOrderByToTheService', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.instances.list');

    await route.handler(
      makeRequest({
        params: { project: 'p', location: 'us-central1' },
        query: { pageSize: '10', pageToken: '20', filter: 'state=ACTIVE', orderBy: 'name' },
      }),
      makeContext()
    );

    const call = (mockService.listInstances as ReturnType<typeof mock>).mock.calls[0] as unknown[];

    expect(call).toEqual(['p', 'us-central1', 10, '20', 'state=ACTIVE', 'name']);
  });

  test('handleListInstances_omitsNextPageTokenWhenThereIsNoNextPage', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.instances.list');

    const response = await route.handler(
      makeRequest({ params: { project: 'p', location: 'us-central1' } }),
      makeContext()
    );

    const body = response.body as Record<string, unknown>;

    expect(body.instances).toEqual([]);
    expect('nextPageToken' in body).toBe(false);
  });

  test('handleUpdateInstance_passesUpdateMaskAndRequestIdQueryParamsToTheService', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.instances.patch');

    await route.handler(
      makeRequest({
        method: 'PATCH',
        params: { project: 'p', location: 'us-central1', instance: 'i' },
        query: { updateMask: 'replicaCount', requestId: 'req-1' },
        body: { replicaCount: 2 },
      }),
      makeContext()
    );

    expect(mockService.updateInstance).toHaveBeenCalled();
    const call = (mockService.updateInstance as ReturnType<typeof mock>).mock.calls[0] as unknown[];

    expect(call[2]).toBe('replicaCount');
  });

  test('handleDeleteInstance_returnsADoneOperation', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.instances.delete');

    const response = await route.handler(
      makeRequest({
        method: 'DELETE',
        params: { project: 'p', location: 'us-central1', instance: 'i' },
      }),
      makeContext()
    );

    const body = response.body as { done: boolean };

    expect(body.done).toBe(true);
  });

  test('handleBackupInstance_returnsADoneOperationWithBackupVerb', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.instances.backup');

    const response = await route.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', location: 'us-central1', instance: 'i' },
        body: { ttl: '3600s' },
      }),
      makeContext()
    );

    const body = response.body as { metadata: { verb: string } };

    expect(body.metadata.verb).toBe('backup');
  });

  test('handleAddTokenAuthUser_returnsADoneOperation', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.instances.addTokenAuthUser');

    const response = await route.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', location: 'us-central1', instance: 'i' },
        body: { tokenAuthUser: { name: 'u' } },
      }),
      makeContext()
    );

    const body = response.body as { done: boolean };

    expect(response.status).toBe(200);
    expect(body.done).toBe(true);
  });

  test('ALREADY_EXISTS maps to 409 for createInstance', async () => {
    (mockService.createInstance as ReturnType<typeof mock>).mockImplementation(() => {
      throw new MemoryStoreError('ALREADY_EXISTS', 'Instance already exists');
    });

    const route = findRoute(handlers.getRoutes(), 'memorystore.instances.create');

    const response = await route.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', location: 'us-central1' },
        query: { instanceId: 'i' },
        body: {},
      }),
      makeContext()
    );

    expect(response.status).toBe(409);
  });
});
