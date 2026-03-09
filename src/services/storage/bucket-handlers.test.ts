import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RouteContext, RouteDefinition, RouteRequest } from '@/core/gateway/request-router.ts';
import { createMockLogger } from '../../../test-utils/mock-logger.ts';
import { BucketHandlers } from './bucket-handlers.ts';
import type { BucketService } from './bucket-service.ts';
import { GcsError } from './bucket-service.ts';

function createRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/storage/v1/b',
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

describe('BucketHandlers', () => {
  let mockService: BucketService;
  let handlers: BucketHandlers;

  beforeEach(() => {
    mockService = {
      createBucket: mock(() => Promise.resolve({ kind: 'storage#bucket', name: 'test-bucket' })),
      getBucket: mock(() => Promise.resolve({ kind: 'storage#bucket', name: 'test-bucket' })),
      listBuckets: mock(() => Promise.resolve({ kind: 'storage#buckets', items: [] })),
      deleteBucket: mock(() => Promise.resolve()),
      patchBucket: mock(() => Promise.resolve({ kind: 'storage#bucket', name: 'test-bucket' })),
      updateBucket: mock(() => Promise.resolve({ kind: 'storage#bucket', name: 'test-bucket' })),
    } as unknown as BucketService;

    handlers = new BucketHandlers(mockService, createMockLogger());
  });

  test('getRoutes returns 6 routes', () => {
    const routes = handlers.getRoutes();
    expect(routes).toHaveLength(6);
    expect(routes.every(r => r.path.startsWith('/storage/v1/b'))).toBe(true);
  });

  test('handleInsertBucket extracts project from query', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.buckets.insert');

    const req = createRequest({
      method: 'POST',
      query: { project: 'my-project' },
      body: { name: 'new-bucket' },
    });

    const result = await route.handler(req, createContext());
    expect(result.status).toBe(200);
    expect(mockService.createBucket).toHaveBeenCalledWith('my-project', { name: 'new-bucket' });
  });

  test('handleGetBucket extracts bucket from params', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.buckets.get');

    const req = createRequest({ params: { bucket: 'my-bucket' } });
    const result = await route.handler(req, createContext());

    expect(result.status).toBe(200);
    expect(mockService.getBucket).toHaveBeenCalledWith('my-bucket');
  });

  test('handleListBuckets passes pagination from query', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.buckets.list');

    const req = createRequest({
      query: { project: 'proj', maxResults: '10', pageToken: '5' },
    });
    await route.handler(req, createContext());

    expect(mockService.listBuckets).toHaveBeenCalledWith('proj', 10, '5');
  });

  test('handleDeleteBucket returns 204', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.buckets.delete');

    const req = createRequest({ params: { bucket: 'del-bucket' } });
    const result = await route.handler(req, createContext());

    expect(result.status).toBe(204);
  });

  test('handlePatchBucket passes body', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.buckets.patch');

    const req = createRequest({
      params: { bucket: 'patch-bucket' },
      body: { labels: { env: 'test' } },
    });
    const result = await route.handler(req, createContext());

    expect(result.status).toBe(200);
    expect(mockService.patchBucket).toHaveBeenCalledWith('patch-bucket', {
      labels: { env: 'test' },
    });
  });

  // ── Error mapping ──

  test('NOT_FOUND maps to 404', async () => {
    (mockService.getBucket as ReturnType<typeof mock>).mockRejectedValue(
      new GcsError('NOT_FOUND', 'Bucket not found')
    );

    const route = findRoute(handlers.getRoutes(), 'storage.buckets.get');
    const result = await route.handler(
      createRequest({ params: { bucket: 'nope' } }),
      createContext()
    );

    expect(result.status).toBe(404);
  });

  test('ALREADY_EXISTS maps to 409', async () => {
    (mockService.createBucket as ReturnType<typeof mock>).mockRejectedValue(
      new GcsError('ALREADY_EXISTS', 'Bucket exists')
    );

    const route = findRoute(handlers.getRoutes(), 'storage.buckets.insert');
    const result = await route.handler(
      createRequest({ query: { project: 'p' }, body: { name: 'x' } }),
      createContext()
    );

    expect(result.status).toBe(409);
  });

  test('INVALID_ARGUMENT maps to 400', async () => {
    (mockService.createBucket as ReturnType<typeof mock>).mockRejectedValue(
      new GcsError('INVALID_ARGUMENT', 'Bad request')
    );

    const route = findRoute(handlers.getRoutes(), 'storage.buckets.insert');
    const result = await route.handler(
      createRequest({ query: { project: 'p' }, body: {} }),
      createContext()
    );

    expect(result.status).toBe(400);
  });

  test('FAILED_PRECONDITION maps to 409 for non-empty bucket', async () => {
    (mockService.deleteBucket as ReturnType<typeof mock>).mockRejectedValue(
      new GcsError('FAILED_PRECONDITION', 'Bucket not empty')
    );

    const route = findRoute(handlers.getRoutes(), 'storage.buckets.delete');
    const result = await route.handler(
      createRequest({ params: { bucket: 'nonempty' } }),
      createContext()
    );

    expect(result.status).toBe(409);
  });
});
