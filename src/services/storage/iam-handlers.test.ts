import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RouteContext, RouteDefinition, RouteRequest } from '@/core/gateway/request-router.ts';
import { createMockLogger } from '../../../test-utils/mock-logger.ts';
import { GcsError } from './bucket-service.ts';
import { IamHandlers } from './iam-handlers.ts';
import type { IamService } from './iam-service.ts';

/**
 * Stale bucket IAM etag HTTP status this emulator returns.
 * The assertion also accepts 412. Update this record if the mapping changes.
 * 412 is not a fidelity failure.
 */
const RECORDED_STALE_BUCKET_IAM_ETAG_STATUS = 409;

function createRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/storage/v1/b/iam-bucket/iam',
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

describe('IamHandlers', () => {
  let mockService: IamService;
  let handlers: IamHandlers;

  beforeEach(() => {
    mockService = {
      getIamPolicy: mock(() =>
        Promise.resolve({
          kind: 'storage#policy',
          resourceId: 'projects/_/buckets/iam-bucket',
          version: 1,
          etag: 'etag-1',
          bindings: [],
        })
      ),
      setIamPolicy: mock(() =>
        Promise.resolve({
          kind: 'storage#policy',
          resourceId: 'projects/_/buckets/iam-bucket',
          version: 1,
          etag: 'etag-2',
          bindings: [],
        })
      ),
      testIamPermissions: mock(() =>
        Promise.resolve({
          kind: 'storage#testIamPermissionsResponse',
          permissions: ['storage.buckets.get'],
        })
      ),
    } as unknown as IamService;

    handlers = new IamHandlers(mockService, createMockLogger());
  });

  test('getRoutes returns the three bucket IAM routes', () => {
    const routes = handlers.getRoutes();

    expect(routes).toHaveLength(3);
    expect(findRoute(routes, 'storage.buckets.getIamPolicy')).toMatchObject({
      method: 'GET',
      path: '/storage/v1/b/:bucket/iam',
    });
    expect(findRoute(routes, 'storage.buckets.setIamPolicy')).toMatchObject({
      method: 'PUT',
      path: '/storage/v1/b/:bucket/iam',
    });
    expect(findRoute(routes, 'storage.buckets.testIamPermissions')).toMatchObject({
      method: 'GET',
      path: '/storage/v1/b/:bucket/iam/testPermissions',
    });
  });

  test('getIamPolicy does not let optionsRequestedPolicyVersion rewrite the policy', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.buckets.getIamPolicy');
    const result = await route.handler(
      createRequest({
        params: { bucket: 'iam-bucket' },
        query: { optionsRequestedPolicyVersion: '3', userProject: 'other' },
      }),
      createContext()
    );

    expect(result.status).toBe(200);
    expect(mockService.getIamPolicy).toHaveBeenCalledWith('iam-bucket');
    expect(result.body).toMatchObject({ version: 1, kind: 'storage#policy' });
  });

  test('setIamPolicy passes the body through', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.buckets.setIamPolicy');
    const body = { bindings: [], etag: 'etag-1' };
    const result = await route.handler(
      createRequest({ method: 'PUT', params: { bucket: 'iam-bucket' }, body }),
      createContext()
    );

    expect(result.status).toBe(200);
    expect(mockService.setIamPolicy).toHaveBeenCalledWith('iam-bucket', body);
  });

  test('testIamPermissions accepts one permission or several', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.buckets.testIamPermissions');

    await route.handler(
      createRequest({
        params: { bucket: 'iam-bucket' },
        query: { permissions: 'storage.buckets.get' },
      }),
      createContext()
    );
    await route.handler(
      createRequest({
        params: { bucket: 'iam-bucket' },
        query: { permissions: ['storage.buckets.get', 'storage.objects.list'] },
      }),
      createContext()
    );

    expect(mockService.testIamPermissions).toHaveBeenNthCalledWith(1, 'iam-bucket', [
      'storage.buckets.get',
    ]);
    expect(mockService.testIamPermissions).toHaveBeenNthCalledWith(2, 'iam-bucket', [
      'storage.buckets.get',
      'storage.objects.list',
    ]);
  });

  test('testIamPermissions without permissions is 400', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.buckets.testIamPermissions');
    const result = await route.handler(
      createRequest({ params: { bucket: 'iam-bucket' }, query: {} }),
      createContext()
    );

    expect(result.status).toBe(400);
    expect(mockService.testIamPermissions).not.toHaveBeenCalled();
  });

  test('a stale etag is 409 or 412', async () => {
    (mockService.setIamPolicy as ReturnType<typeof mock>).mockRejectedValue(
      new GcsError('ABORTED', 'The IAM policy etag does not match')
    );

    const route = findRoute(handlers.getRoutes(), 'storage.buckets.setIamPolicy');
    const result = await route.handler(
      createRequest({
        method: 'PUT',
        params: { bucket: 'iam-bucket' },
        body: { etag: 'stale', bindings: [] },
      }),
      createContext()
    );

    expect([409, 412]).toContain(result.status);
    expect(result.status).toBe(RECORDED_STALE_BUCKET_IAM_ETAG_STATUS);
    expect(result.body).toMatchObject({
      error: {
        code: RECORDED_STALE_BUCKET_IAM_ETAG_STATUS,
        status: 'ABORTED',
      },
    });
  });

  test('NOT_FOUND maps to 404', async () => {
    (mockService.getIamPolicy as ReturnType<typeof mock>).mockRejectedValue(
      new GcsError('NOT_FOUND', 'Bucket missing')
    );

    const route = findRoute(handlers.getRoutes(), 'storage.buckets.getIamPolicy');
    const result = await route.handler(
      createRequest({ params: { bucket: 'missing' } }),
      createContext()
    );

    expect(result.status).toBe(404);
  });
});
