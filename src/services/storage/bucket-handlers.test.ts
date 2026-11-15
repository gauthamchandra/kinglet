import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RouteContext, RouteDefinition, RouteRequest } from '@/core/gateway/request-router.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import { createMockLogger } from '../../../test-utils/mock-logger.ts';
import { BucketHandlers } from './bucket-handlers.ts';
import { BucketRepository } from './bucket-repository.ts';
import { BucketService, GcsError } from './bucket-service.ts';
import { IamPolicyRepository } from './iam-repository.ts';
import { ObjectRepository } from './object-repository.ts';

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
    expect(mockService.getBucket).toHaveBeenCalledWith('my-bucket', undefined);
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
    expect(mockService.patchBucket).toHaveBeenCalledWith(
      'patch-bucket',
      { labels: { env: 'test' } },
      undefined
    );
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

  test('BUCKET_NOT_EMPTY maps to 409 FAILED_PRECONDITION', async () => {
    (mockService.deleteBucket as ReturnType<typeof mock>).mockRejectedValue(
      new GcsError('BUCKET_NOT_EMPTY', 'Bucket not empty')
    );

    const route = findRoute(handlers.getRoutes(), 'storage.buckets.delete');
    const result = await route.handler(
      createRequest({ params: { bucket: 'nonempty' } }),
      createContext()
    );

    expect(result.status).toBe(409);

    const error = (result.body as { error: { code: number; message: string; status: string } })
      .error;

    expect(error.code).toBe(409);
    expect(error.status).toBe('FAILED_PRECONDITION');
    expect(error.message).toBe('Bucket not empty');
  });

  test('CONDITION_NOT_MET maps to 412 FAILED_PRECONDITION', async () => {
    (mockService.updateBucket as ReturnType<typeof mock>).mockRejectedValue(
      new GcsError('CONDITION_NOT_MET', 'metageneration mismatch')
    );

    const route = findRoute(handlers.getRoutes(), 'storage.buckets.update');
    const result = await route.handler(
      createRequest({
        method: 'PUT',
        params: { bucket: 'b' },
        body: {},
        query: { ifMetagenerationMatch: '1' },
      }),
      createContext()
    );

    expect(result.status).toBe(412);

    const error = (result.body as { error: { code: number; message: string; status: string } })
      .error;

    expect(error.code).toBe(412);
    expect(error.status).toBe('FAILED_PRECONDITION');
    expect(error.message).toBe('metageneration mismatch');
  });

  test('bucket GET ifMetagenerationNotMatch returns 304 with an empty body', async () => {
    const storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    const bucketRepo = new BucketRepository(storage);
    await bucketRepo.initialize();

    const objectRepo = new ObjectRepository(storage);
    await objectRepo.initialize();

    const iamRepo = new IamPolicyRepository(storage);
    await iamRepo.initialize();

    const service = new BucketService(bucketRepo, objectRepo, iamRepo, new ResourceMutex());
    await service.createBucket('proj', { name: 'get-304' });

    const realHandlers = new BucketHandlers(service, createMockLogger());
    const route = findRoute(realHandlers.getRoutes(), 'storage.buckets.get');
    const result = await route.handler(
      createRequest({
        params: { bucket: 'get-304' },
        query: { ifMetagenerationNotMatch: '1' },
      }),
      createContext()
    );

    expect(result.status).toBe(304);
    expect(result.body).toBeUndefined();
  });

  test('NOT_MODIFIED maps to 304 with an empty body', async () => {
    (mockService.getBucket as ReturnType<typeof mock>).mockRejectedValue(
      new GcsError('NOT_MODIFIED', 'not modified')
    );

    const route = findRoute(handlers.getRoutes(), 'storage.buckets.get');
    const result = await route.handler(createRequest({ params: { bucket: 'b' } }), createContext());

    expect(result.status).toBe(304);
    expect(result.body).toBeUndefined();
  });

  test('PERMISSION_DENIED maps to 403', async () => {
    (mockService.updateBucket as ReturnType<typeof mock>).mockRejectedValue(
      new GcsError('PERMISSION_DENIED', 'retention locked')
    );

    const route = findRoute(handlers.getRoutes(), 'storage.buckets.update');
    const result = await route.handler(
      createRequest({ method: 'PUT', params: { bucket: 'b' }, body: {} }),
      createContext()
    );

    expect(result.status).toBe(403);

    const error = (result.body as { error: { code: number; status: string } }).error;

    expect(error.code).toBe(403);
    expect(error.status).toBe('PERMISSION_DENIED');
  });

  test('handleUpdateBucket passes metageneration preconditions from the query', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.buckets.update');

    const req = createRequest({
      method: 'PUT',
      params: { bucket: 'upd-bucket' },
      body: { storageClass: 'NEARLINE' },
      query: { ifMetagenerationMatch: '2', ifMetagenerationNotMatch: '1' },
    });

    const result = await route.handler(req, createContext());

    expect(result.status).toBe(200);
    expect(mockService.updateBucket).toHaveBeenCalledWith(
      'upd-bucket',
      { storageClass: 'NEARLINE' },
      { ifMetagenerationMatch: '2', ifMetagenerationNotMatch: '1' }
    );
  });

  test('handleGetBucket passes metageneration preconditions from the query', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.buckets.get');

    const req = createRequest({
      params: { bucket: 'get-bucket' },
      query: { ifMetagenerationMatch: '4' },
    });

    await route.handler(req, createContext());

    expect(mockService.getBucket).toHaveBeenCalledWith('get-bucket', {
      ifMetagenerationMatch: '4',
    });
  });

  test('handlePatchBucket passes metageneration preconditions from the query', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.buckets.patch');

    const req = createRequest({
      params: { bucket: 'patch-bucket' },
      body: { labels: { env: 'test' } },
      query: { ifMetagenerationNotMatch: '3' },
    });

    await route.handler(req, createContext());

    expect(mockService.patchBucket).toHaveBeenCalledWith(
      'patch-bucket',
      { labels: { env: 'test' } },
      { ifMetagenerationNotMatch: '3' }
    );
  });

  test('handleDeleteBucket passes metageneration preconditions from the query', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.buckets.delete');

    const req = createRequest({
      params: { bucket: 'del-bucket' },
      query: { ifMetagenerationMatch: ['1', '5'] },
    });

    const result = await route.handler(req, createContext());

    expect(result.status).toBe(204);
    expect(mockService.deleteBucket).toHaveBeenCalledWith('del-bucket', {
      ifMetagenerationMatch: '5',
    });
  });
});
