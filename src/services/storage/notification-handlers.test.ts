import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RouteContext, RouteDefinition, RouteRequest } from '@/core/gateway/request-router.ts';
import { createMockLogger } from '../../../test-utils/mock-logger.ts';
import { GcsError } from './bucket-service.ts';
import { NotificationHandlers } from './notification-handlers.ts';
import type { NotificationService } from './notification-service.ts';

function createRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/storage/v1/b/bucket/notificationConfigs',
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

const stored = {
  kind: 'storage#notification' as const,
  id: 'n1',
  selfLink: 'https://www.googleapis.com/storage/v1/b/my-bucket/notificationConfigs/n1',
  topic: '//pubsub.googleapis.com/projects/p/topics/t',
  etag: 'etag',
  payload_format: 'JSON_API_V1' as const,
};

describe('NotificationHandlers', () => {
  let mockService: NotificationService;
  let handlers: NotificationHandlers;

  beforeEach(() => {
    mockService = {
      insertNotification: mock(() => Promise.resolve(stored)),
      getNotification: mock(() => Promise.resolve(stored)),
      listNotifications: mock(() =>
        Promise.resolve({ kind: 'storage#notifications' as const, items: [stored] })
      ),
      deleteNotification: mock(() => Promise.resolve()),
    } as unknown as NotificationService;

    handlers = new NotificationHandlers(mockService, createMockLogger());
  });

  test('getRoutes returns the four notification methods', () => {
    const routes = handlers.getRoutes();

    expect(routes.map(route => `${route.method} ${route.path}`).sort()).toEqual([
      'DELETE /storage/v1/b/:bucket/notificationConfigs/:notification',
      'GET /storage/v1/b/:bucket/notificationConfigs',
      'GET /storage/v1/b/:bucket/notificationConfigs/:notification',
      'POST /storage/v1/b/:bucket/notificationConfigs',
    ]);
    expect(routes.map(route => route.id).sort()).toEqual([
      'storage.notifications.delete',
      'storage.notifications.get',
      'storage.notifications.insert',
      'storage.notifications.list',
    ]);
  });

  test('insert passes the bucket and body', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.notifications.insert');
    const body = { topic: 'projects/p/topics/t', payload_format: 'JSON_API_V1' };

    const result = await route.handler(
      createRequest({ method: 'POST', params: { bucket: 'my-bucket' }, body }),
      createContext()
    );

    expect(result.status).toBe(200);
    expect(mockService.insertNotification).toHaveBeenCalledWith('my-bucket', body);
  });

  test('get passes the bucket and notification id', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.notifications.get');

    const result = await route.handler(
      createRequest({ params: { bucket: 'my-bucket', notification: 'n1' } }),
      createContext()
    );

    expect(result.status).toBe(200);
    expect(mockService.getNotification).toHaveBeenCalledWith('my-bucket', 'n1');
  });

  test('list passes the bucket', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.notifications.list');

    const result = await route.handler(
      createRequest({ params: { bucket: 'my-bucket' } }),
      createContext()
    );

    expect(result.status).toBe(200);
    expect(mockService.listNotifications).toHaveBeenCalledWith('my-bucket');
  });

  test('delete returns 204', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.notifications.delete');

    const result = await route.handler(
      createRequest({ params: { bucket: 'my-bucket', notification: 'n1' } }),
      createContext()
    );

    expect(result.status).toBe(204);
    expect(mockService.deleteNotification).toHaveBeenCalledWith('my-bucket', 'n1');
  });

  test('NOT_FOUND maps to 404', async () => {
    (mockService.getNotification as ReturnType<typeof mock>).mockRejectedValue(
      new GcsError('NOT_FOUND', 'missing')
    );

    const route = findRoute(handlers.getRoutes(), 'storage.notifications.get');
    const result = await route.handler(
      createRequest({ params: { bucket: 'my-bucket', notification: 'missing' } }),
      createContext()
    );

    expect(result.status).toBe(404);
  });

  test('INVALID_ARGUMENT maps to 400', async () => {
    (mockService.insertNotification as ReturnType<typeof mock>).mockRejectedValue(
      new GcsError('INVALID_ARGUMENT', 'Invalid custom attributes: eventType')
    );

    const route = findRoute(handlers.getRoutes(), 'storage.notifications.insert');
    const result = await route.handler(
      createRequest({ method: 'POST', params: { bucket: 'my-bucket' }, body: {} }),
      createContext()
    );

    expect(result.status).toBe(400);
    expect((result.body as { error: { status: string } }).error.status).toBe('INVALID_ARGUMENT');
  });
});
