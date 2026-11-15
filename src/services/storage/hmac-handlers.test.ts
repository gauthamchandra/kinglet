import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RouteContext, RouteDefinition, RouteRequest } from '@/core/gateway/request-router.ts';
import { createMockLogger } from '../../../test-utils/mock-logger.ts';
import { GcsError } from './bucket-service.ts';
import { HmacKeyHandlers } from './hmac-handlers.ts';
import type { HmacKeyService } from './hmac-service.ts';

function createRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/storage/v1/projects/proj/hmacKeys',
    query: {},
    headers: {},
    params: {},
    body: undefined,
    originalRequest: null as unknown as Request,
    ...overrides,
  };
}

function createContext(): RouteContext {
  return {
    routeId: 'test',
    startTime: Date.now(),
    metadata: {},
    logger: createMockLogger(),
  };
}

function findRoute(routes: RouteDefinition[], id: string): RouteDefinition {
  const route = routes.find(r => r.id === id);

  if (!route) {
    throw new Error(`Route ${id} not found`);
  }

  return route;
}

const metadata = {
  kind: 'storage#hmacKeyMetadata' as const,
  id: 'proj/GOOG1TEST',
  selfLink: 'https://www.googleapis.com/storage/v1/projects/proj/hmacKeys/GOOG1TEST',
  accessId: 'GOOG1TEST',
  projectId: 'proj',
  serviceAccountEmail: 'sa@proj.iam.gserviceaccount.com',
  state: 'ACTIVE' as const,
  timeCreated: '2020-01-01T00:00:00.000Z',
  updated: '2020-01-01T00:00:00.000Z',
  etag: 'etag-1',
};

describe('HmacKeyHandlers', () => {
  let mockService: HmacKeyService;
  let handlers: HmacKeyHandlers;

  beforeEach(() => {
    mockService = {
      createKey: mock(() => Promise.resolve({ kind: 'storage#hmacKey', metadata, secret: 'once' })),
      getKey: mock(() => Promise.resolve(metadata)),
      listKeys: mock(() => Promise.resolve({ kind: 'storage#hmacKeysMetadata', items: [] })),
      updateKey: mock(() => Promise.resolve({ ...metadata, state: 'INACTIVE' })),
      deleteKey: mock(() => Promise.resolve()),
    } as unknown as HmacKeyService;

    handlers = new HmacKeyHandlers(mockService, createMockLogger());
  });

  test('getRoutes returns the five hmacKeys methods', () => {
    const routes = handlers.getRoutes();

    expect(routes.map(route => [route.method, route.path, route.id])).toEqual([
      ['POST', '/storage/v1/projects/:projectId/hmacKeys', 'storage.projects.hmacKeys.create'],
      [
        'GET',
        '/storage/v1/projects/:projectId/hmacKeys/:accessId',
        'storage.projects.hmacKeys.get',
      ],
      ['GET', '/storage/v1/projects/:projectId/hmacKeys', 'storage.projects.hmacKeys.list'],
      [
        'PUT',
        '/storage/v1/projects/:projectId/hmacKeys/:accessId',
        'storage.projects.hmacKeys.update',
      ],
      [
        'DELETE',
        '/storage/v1/projects/:projectId/hmacKeys/:accessId',
        'storage.projects.hmacKeys.delete',
      ],
    ]);
  });

  test('create forwards projectId and serviceAccountEmail and ignores userProject', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.projects.hmacKeys.create');
    const result = await route.handler(
      createRequest({
        method: 'POST',
        params: { projectId: 'proj' },
        query: { serviceAccountEmail: metadata.serviceAccountEmail, userProject: 'billing' },
      }),
      createContext()
    );

    expect(result.status).toBe(200);
    expect(mockService.createKey).toHaveBeenCalledWith('proj', metadata.serviceAccountEmail);
  });

  test('list forwards maxResults, pageToken, service account, and showDeletedKeys', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.projects.hmacKeys.list');
    await route.handler(
      createRequest({
        params: { projectId: 'proj' },
        query: {
          maxResults: '10',
          pageToken: '5',
          serviceAccountEmail: metadata.serviceAccountEmail,
          showDeletedKeys: 'true',
          userProject: 'billing',
        },
      }),
      createContext()
    );

    expect(mockService.listKeys).toHaveBeenCalledWith('proj', {
      maxResults: 10,
      pageToken: '5',
      serviceAccountEmail: metadata.serviceAccountEmail,
      showDeletedKeys: true,
    });
  });

  test('list treats a missing or non-positive maxResults and a false showDeletedKeys as unset', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.projects.hmacKeys.list');
    await route.handler(
      createRequest({
        params: { projectId: 'proj' },
        query: { maxResults: '0', showDeletedKeys: 'false' },
      }),
      createContext()
    );

    expect(mockService.listKeys).toHaveBeenCalledWith('proj', {
      maxResults: undefined,
      pageToken: undefined,
      serviceAccountEmail: undefined,
      showDeletedKeys: false,
    });
  });

  test('get, update, and delete forward the path ids', async () => {
    const routes = handlers.getRoutes();
    const getRoute = findRoute(routes, 'storage.projects.hmacKeys.get');
    const updateRoute = findRoute(routes, 'storage.projects.hmacKeys.update');
    const deleteRoute = findRoute(routes, 'storage.projects.hmacKeys.delete');
    const params = { projectId: 'proj', accessId: 'GOOG1TEST' };
    const body = { state: 'INACTIVE', etag: 'etag-1' };

    const got = await getRoute.handler(createRequest({ params }), createContext());
    const updated = await updateRoute.handler(
      createRequest({ method: 'PUT', params, body }),
      createContext()
    );
    const deleted = await deleteRoute.handler(
      createRequest({ method: 'DELETE', params, query: { userProject: 'billing' } }),
      createContext()
    );

    expect(got.status).toBe(200);
    expect(mockService.getKey).toHaveBeenCalledWith('proj', 'GOOG1TEST');
    expect(updated.status).toBe(200);
    expect(mockService.updateKey).toHaveBeenCalledWith('proj', 'GOOG1TEST', body);
    expect(deleted.status).toBe(204);
    expect(mockService.deleteKey).toHaveBeenCalledWith('proj', 'GOOG1TEST');
  });

  test('INVALID_ARGUMENT maps to 400 and NOT_FOUND maps to 404', async () => {
    (mockService.deleteKey as ReturnType<typeof mock>).mockRejectedValue(
      new GcsError('INVALID_ARGUMENT', 'Cannot delete keys in ACTIVE state.')
    );
    (mockService.getKey as ReturnType<typeof mock>).mockRejectedValue(
      new GcsError('NOT_FOUND', 'GOOG1MISSING')
    );

    const deleteRoute = findRoute(handlers.getRoutes(), 'storage.projects.hmacKeys.delete');
    const getRoute = findRoute(handlers.getRoutes(), 'storage.projects.hmacKeys.get');

    const deleted = await deleteRoute.handler(
      createRequest({ method: 'DELETE', params: { projectId: 'proj', accessId: 'GOOG1TEST' } }),
      createContext()
    );
    const missing = await getRoute.handler(
      createRequest({ params: { projectId: 'proj', accessId: 'GOOG1MISSING' } }),
      createContext()
    );

    expect(deleted.status).toBe(400);
    expect(deleted.body).toMatchObject({
      error: {
        code: 400,
        message: 'Cannot delete keys in ACTIVE state.',
        status: 'INVALID_ARGUMENT',
      },
    });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({
      error: { code: 404, status: 'NOT_FOUND' },
    });
  });
});
