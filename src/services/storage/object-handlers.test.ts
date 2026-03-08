import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RouteContext, RouteDefinition, RouteRequest } from '@/core/gateway/request-router.ts';
import { createMockLogger } from '../../../test-utils/mock-logger.ts';
import { GcsError } from './bucket-service.ts';
import { ObjectHandlers } from './object-handlers.ts';
import type { ObjectService } from './object-service.ts';

function createRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/storage/v1/b/bucket/o',
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

describe('ObjectHandlers', () => {
  let mockService: ObjectService;
  let handlers: ObjectHandlers;

  beforeEach(() => {
    mockService = {
      insertObject: mock(() =>
        Promise.resolve({
          kind: 'storage#object',
          name: 'test.txt',
          size: '5',
          contentType: 'text/plain',
        })
      ),
      getObject: mock(() =>
        Promise.resolve({ kind: 'storage#object', name: 'test.txt', contentType: 'text/plain' })
      ),
      getObjectMedia: mock(() => Promise.resolve(new TextEncoder().encode('hello'))),
      listObjects: mock(() =>
        Promise.resolve({ kind: 'storage#objects', items: [], prefixes: [] })
      ),
      deleteObject: mock(() => Promise.resolve()),
      patchObject: mock(() => Promise.resolve({ kind: 'storage#object', name: 'test.txt' })),
      copyObject: mock(() => Promise.resolve({ kind: 'storage#object', name: 'copy.txt' })),
      rewriteObject: mock(() =>
        Promise.resolve({ kind: 'storage#rewriteResponse', done: true, resource: {} })
      ),
      composeObjects: mock(() => Promise.resolve({ kind: 'storage#object', name: 'composed.txt' })),
    } as unknown as ObjectService;

    handlers = new ObjectHandlers(mockService, createMockLogger());
  });

  test('getRoutes returns 10 routes', () => {
    const routes = handlers.getRoutes();
    expect(routes).toHaveLength(10);

    const ids = routes.map(r => r.id);
    expect(ids).toContain('storage.objects.insert');
    expect(ids).toContain('storage.objects.resumable');
    expect(ids).toContain('storage.objects.get');
    expect(ids).toContain('storage.objects.list');
    expect(ids).toContain('storage.objects.delete');
    expect(ids).toContain('storage.objects.patch');
    expect(ids).toContain('storage.objects.update');
    expect(ids).toContain('storage.objects.compose');
    expect(ids).toContain('storage.objects.copy');
    expect(ids).toContain('storage.objects.rewrite');
  });

  test('getRoutes includes upload path', () => {
    const route = findRoute(handlers.getRoutes(), 'storage.objects.insert');
    expect(route.path).toBe('/upload/storage/v1/b/:bucket/o');
  });

  test('handleInsertObject reads body and extracts name from query', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.objects.insert');

    const body = new TextEncoder().encode('test data');
    const originalRequest = new Request(
      'http://localhost/upload/storage/v1/b/bucket/o?name=test.txt',
      {
        method: 'POST',
        body,
      }
    );

    const req = createRequest({
      method: 'POST',
      params: { bucket: 'my-bucket' },
      query: { name: 'test.txt' },
      headers: { 'content-type': 'text/plain' },
      originalRequest,
    });

    const result = await route.handler(req, createContext());
    expect(result.status).toBe(200);
  });

  test('handleGetObject without alt=media returns JSON', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.objects.get');

    const req = createRequest({
      params: { bucket: 'my-bucket', object: 'test.txt' },
    });

    const result = await route.handler(req, createContext());
    expect(result.status).toBe(200);
    expect(mockService.getObject).toHaveBeenCalled();
  });

  test('handleGetObject with alt=media returns binary', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.objects.get');

    const req = createRequest({
      params: { bucket: 'my-bucket', object: 'test.txt' },
      query: { alt: 'media' },
    });

    const result = await route.handler(req, createContext());
    expect(result.status).toBe(200);
    expect(result.headers?.['content-type']).toBe('text/plain');
    expect(mockService.getObjectMedia).toHaveBeenCalled();
  });

  test('handleListObjects passes query params', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.objects.list');

    const req = createRequest({
      params: { bucket: 'my-bucket' },
      query: { prefix: 'docs/', delimiter: '/', maxResults: '10', pageToken: '5' },
    });

    await route.handler(req, createContext());
    expect(mockService.listObjects).toHaveBeenCalledWith('my-bucket', {
      prefix: 'docs/',
      delimiter: '/',
      maxResults: 10,
      pageToken: '5',
    });
  });

  test('handleDeleteObject returns 204', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.objects.delete');

    const req = createRequest({
      params: { bucket: 'my-bucket', object: 'test.txt' },
    });

    const result = await route.handler(req, createContext());
    expect(result.status).toBe(204);
  });

  test('handleCopyObject extracts src/dst from params', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.objects.copy');

    const req = createRequest({
      method: 'POST',
      params: {
        srcBucket: 'src-bucket',
        srcObject: 'src.txt',
        dstBucket: 'dst-bucket',
        dstObject: 'dst.txt',
      },
    });

    const result = await route.handler(req, createContext());
    expect(result.status).toBe(200);
    expect(mockService.copyObject).toHaveBeenCalledWith(
      'src-bucket',
      'src.txt',
      'dst-bucket',
      'dst.txt'
    );
  });

  test('handleRewriteObject extracts src/dst from params', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.objects.rewrite');

    const req = createRequest({
      method: 'POST',
      params: {
        srcBucket: 'src-b',
        srcObject: 'src.txt',
        dstBucket: 'dst-b',
        dstObject: 'dst.txt',
      },
    });

    const result = await route.handler(req, createContext());
    expect(result.status).toBe(200);
  });

  test('handleComposeObject extracts destination from params', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.objects.compose');

    const req = createRequest({
      method: 'POST',
      params: { bucket: 'my-bucket', object: 'composed.txt' },
      body: { sourceObjects: [{ name: 'a.txt' }, { name: 'b.txt' }] },
    });

    const result = await route.handler(req, createContext());
    expect(result.status).toBe(200);
    expect(mockService.composeObjects).toHaveBeenCalledWith('my-bucket', 'composed.txt', {
      sourceObjects: [{ name: 'a.txt' }, { name: 'b.txt' }],
    });
  });

  // ── Error mapping ──

  test('NOT_FOUND maps to 404', async () => {
    (mockService.getObject as ReturnType<typeof mock>).mockRejectedValue(
      new GcsError('NOT_FOUND', 'Object not found')
    );

    const route = findRoute(handlers.getRoutes(), 'storage.objects.get');
    const result = await route.handler(
      createRequest({ params: { bucket: 'b', object: 'o' } }),
      createContext()
    );

    expect(result.status).toBe(404);
  });

  test('INVALID_ARGUMENT maps to 400', async () => {
    (mockService.composeObjects as ReturnType<typeof mock>).mockRejectedValue(
      new GcsError('INVALID_ARGUMENT', 'Bad compose')
    );

    const route = findRoute(handlers.getRoutes(), 'storage.objects.compose');
    const result = await route.handler(
      createRequest({ params: { bucket: 'b', object: 'o' }, body: {} }),
      createContext()
    );

    expect(result.status).toBe(400);
  });
});
