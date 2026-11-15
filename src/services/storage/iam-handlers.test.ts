import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RouteContext, RouteDefinition, RouteRequest } from '@/core/gateway/request-router.ts';
import { createMockLogger } from '../../../test-utils/mock-logger.ts';
import { GcsError } from './bucket-service.ts';
import { IamHandlers } from './iam-handlers.ts';
import type { IamService } from './iam-service.ts';

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
      getObjectIamPolicy: mock(() =>
        Promise.resolve({
          kind: 'storage#policy',
          resourceId: 'projects/_/buckets/obj-iam/objects/echo.txt',
          version: 1,
          etag: 'etag-1',
          bindings: [],
        })
      ),
      setObjectIamPolicy: mock(() =>
        Promise.resolve({
          kind: 'storage#policy',
          resourceId: 'projects/_/buckets/obj-iam/objects/echo.txt',
          version: 1,
          etag: 'etag-2',
          bindings: [],
        })
      ),
      testObjectIamPermissions: mock(() =>
        Promise.resolve({
          kind: 'storage#testIamPermissionsResponse',
          permissions: ['storage.objects.get'],
        })
      ),
    } as unknown as IamService;

    handlers = new IamHandlers(mockService, createMockLogger());
  });

  test('getRoutes returns the three bucket IAM routes', () => {
    const routes = handlers.getRoutes();

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

    // Recorded stale-etag status: 409 ABORTED. 412 is accepted and is not locked.
    expect([409, 412]).toContain(result.status);
    expect(result.body).toMatchObject({
      error: { code: result.status },
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

  test('getRoutes returns the three object IAM routes', () => {
    const routes = handlers.getRoutes();

    expect(routes).toHaveLength(6);
    expect(findRoute(routes, 'storage.objects.getIamPolicy')).toMatchObject({
      method: 'GET',
      path: '/storage/v1/b/:bucket/o/:object/iam',
    });
    expect(findRoute(routes, 'storage.objects.setIamPolicy')).toMatchObject({
      method: 'PUT',
      path: '/storage/v1/b/:bucket/o/:object/iam',
    });
    expect(findRoute(routes, 'storage.objects.testIamPermissions')).toMatchObject({
      method: 'GET',
      path: '/storage/v1/b/:bucket/o/:object/iam/testPermissions',
    });
  });

  test('object getIamPolicy decodes the name and does not rewrite version from the query', async () => {
    (mockService.getObjectIamPolicy as ReturnType<typeof mock>).mockResolvedValue({
      kind: 'storage#policy',
      resourceId: 'projects/_/buckets/obj-iam/objects/folder/nested.txt',
      version: 3,
      etag: 'etag-1',
      bindings: [],
    });

    const route = findRoute(handlers.getRoutes(), 'storage.objects.getIamPolicy');
    const result = await route.handler(
      createRequest({
        path: '/storage/v1/b/obj-iam/o/folder%2Fnested.txt/iam',
        params: { bucket: 'obj-iam', object: 'folder%2Fnested.txt' },
        query: { optionsRequestedPolicyVersion: '1', userProject: 'other' },
      }),
      createContext()
    );

    expect(result.status).toBe(200);
    expect(mockService.getObjectIamPolicy).toHaveBeenCalledWith('obj-iam', 'folder/nested.txt');
    expect(result.body).toMatchObject({ version: 3, kind: 'storage#policy' });
  });

  test('object setIamPolicy passes the decoded name and body through', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.objects.setIamPolicy');
    const body = { bindings: [], etag: 'etag-1' };
    const result = await route.handler(
      createRequest({
        method: 'PUT',
        params: { bucket: 'obj-iam', object: 'folder%2Fnested.txt' },
        body,
      }),
      createContext()
    );

    expect(result.status).toBe(200);
    expect(mockService.setObjectIamPolicy).toHaveBeenCalledWith(
      'obj-iam',
      'folder/nested.txt',
      body
    );
  });

  test('object testIamPermissions accepts one permission or several', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.objects.testIamPermissions');

    await route.handler(
      createRequest({
        params: { bucket: 'obj-iam', object: 'echo.txt' },
        query: { permissions: 'storage.objects.get' },
      }),
      createContext()
    );
    await route.handler(
      createRequest({
        params: { bucket: 'obj-iam', object: 'echo.txt' },
        query: { permissions: ['storage.objects.get', 'storage.objects.delete'] },
      }),
      createContext()
    );

    expect(mockService.testObjectIamPermissions).toHaveBeenNthCalledWith(1, 'obj-iam', 'echo.txt', [
      'storage.objects.get',
    ]);
    expect(mockService.testObjectIamPermissions).toHaveBeenNthCalledWith(2, 'obj-iam', 'echo.txt', [
      'storage.objects.get',
      'storage.objects.delete',
    ]);
  });

  test('object testIamPermissions without permissions is 400', async () => {
    const route = findRoute(handlers.getRoutes(), 'storage.objects.testIamPermissions');
    const result = await route.handler(
      createRequest({ params: { bucket: 'obj-iam', object: 'echo.txt' }, query: {} }),
      createContext()
    );

    expect(result.status).toBe(400);
    expect(mockService.testObjectIamPermissions).not.toHaveBeenCalled();
  });

  test('a stale object etag is 409 or 412', async () => {
    (mockService.setObjectIamPolicy as ReturnType<typeof mock>).mockRejectedValue(
      new GcsError('ABORTED', 'The IAM policy etag does not match')
    );

    const route = findRoute(handlers.getRoutes(), 'storage.objects.setIamPolicy');
    const result = await route.handler(
      createRequest({
        method: 'PUT',
        params: { bucket: 'obj-iam', object: 'stale.txt' },
        body: { etag: 'stale', bindings: [] },
      }),
      createContext()
    );

    // Recorded stale-etag status: 409 ABORTED. 412 is accepted and is not locked.
    expect([409, 412]).toContain(result.status);
    expect(result.body).toMatchObject({
      error: { code: result.status },
    });
  });

  test('a missing object is 404', async () => {
    (mockService.getObjectIamPolicy as ReturnType<typeof mock>).mockRejectedValue(
      new GcsError('NOT_FOUND', 'Object missing.txt not found in bucket obj-iam')
    );

    const route = findRoute(handlers.getRoutes(), 'storage.objects.getIamPolicy');
    const result = await route.handler(
      createRequest({ params: { bucket: 'obj-iam', object: 'missing.txt' } }),
      createContext()
    );

    expect(result.status).toBe(404);
  });
});
