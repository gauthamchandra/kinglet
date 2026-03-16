/**
 * Request Router Tests
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Logger } from '@/shared/utils/logger.ts';
import {
  createRoute,
  RequestRouter,
  type RouteContext,
  type RouteDefinition,
  type RouteRequest,
  type RouteResponse,
} from './request-router.ts';

// Create a mock logger instance
const mockLogger = {
  debug: mock(),
  info: mock(),
  warn: mock(),
  error: mock(),
  child: mock(() => mockLogger),
} as unknown as Logger;

// Test helpers
const createMockRequest = (
  method: string,
  path: string,
  options: {
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: unknown;
  } = {}
): Request => {
  const url = new URL(`http://localhost${path}`);

  if (options.query) {
    Object.entries(options.query).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  const requestInit: RequestInit = {
    method: method.toUpperCase(),
    headers: options.headers || {},
  };

  if (options.body && method !== 'GET' && method !== 'HEAD') {
    requestInit.body =
      typeof options.body === 'string' ? options.body : JSON.stringify(options.body);

    if (!requestInit.headers) {
      requestInit.headers = {};
    }

    (requestInit.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }

  return new Request(url.toString(), requestInit);
};

const simpleHandler = async (): Promise<RouteResponse> => ({
  status: 200,
  body: { success: true },
});

const paramHandler = async (request: RouteRequest): Promise<RouteResponse> => ({
  status: 200,
  body: { params: request.params },
});

const errorHandler = async (): Promise<RouteResponse> => {
  throw new Error('Handler error');
};

describe('RequestRouter', () => {
  let router: RequestRouter;

  beforeEach(() => {
    (mockLogger.debug as ReturnType<typeof mock>).mockReset();
    (mockLogger.info as ReturnType<typeof mock>).mockReset();
    (mockLogger.warn as ReturnType<typeof mock>).mockReset();
    (mockLogger.error as ReturnType<typeof mock>).mockReset();
    (mockLogger.child as ReturnType<typeof mock>).mockReset();
    router = new RequestRouter(mockLogger, {
      enableMetrics: true,
    });
  });

  describe('Route Registration', () => {
    test('should register a simple GET route', () => {
      const route = createRoute.get('/test', simpleHandler, {
        id: 'test-route',
      });

      router.addRoute(route);

      const retrievedRoute = router.getRoute('test-route');

      expect(retrievedRoute).toEqual(route);
    });

    test('should register routes with different HTTP methods', () => {
      const routes = [
        createRoute.get('/test', simpleHandler, { id: 'get-route' }),
        createRoute.post('/test', simpleHandler, { id: 'post-route' }),
        createRoute.put('/test', simpleHandler, { id: 'put-route' }),
        createRoute.delete('/test', simpleHandler, { id: 'delete-route' }),
        createRoute.patch('/test', simpleHandler, { id: 'patch-route' }),
      ];

      for (const route of routes) {
        router.addRoute(route);
      }

      for (const route of routes) {
        expect(router.getRoute(route.id)).toEqual(route);
      }
    });

    test('should reject route with duplicate ID', () => {
      const route1 = createRoute.get('/test1', simpleHandler, { id: 'duplicate' });
      const route2 = createRoute.get('/test2', simpleHandler, { id: 'duplicate' });

      router.addRoute(route1);

      expect(() => router.addRoute(route2)).toThrow("Route with ID 'duplicate' already exists");
    });

    test('should validate required route fields', () => {
      const invalidRoutes = [
        { method: 'GET', path: '/test', handler: simpleHandler }, // Missing id
        { id: 'test', path: '/test', handler: simpleHandler }, // Missing method
        { id: 'test', method: 'GET', handler: simpleHandler }, // Missing path
        { id: 'test', method: 'GET', path: '/test' }, // Missing handler
      ];

      invalidRoutes.forEach(route => {
        expect(() => router.addRoute(route as RouteDefinition)).toThrow();
      });
    });

    test('should validate path syntax', () => {
      const invalidPaths = ['no-leading-slash', '/invalid/{}/param', '/invalid/{=}/param'];

      invalidPaths.forEach(path => {
        const route = createRoute.get(path, simpleHandler, { id: `test-${Date.now()}` });

        expect(() => router.addRoute(route)).toThrow();
      });
    });

    test('should normalize paths when enabled', () => {
      const routerWithNormalization = new RequestRouter(mockLogger, {
        enablePathNormalization: true,
        caseSensitive: false,
      });

      const route = createRoute.get('/Test//Path/', simpleHandler, { id: 'normalized' });

      routerWithNormalization.addRoute(route);

      const retrievedRoute = routerWithNormalization.getRoute('normalized');

      expect(retrievedRoute?.path).toBe('/test/path');
    });

    test('should preserve colon-style camelCase parameter names during normalization', () => {
      const routerWithNormalization = new RequestRouter(mockLogger, {
        enablePathNormalization: true,
        caseSensitive: false,
      });

      const route = createRoute.get(
        '/v2/projects/:project/locations/:location/queues/:queueId/tasks',
        paramHandler,
        { id: 'camel-params' }
      );

      routerWithNormalization.addRoute(route);

      const retrievedRoute = routerWithNormalization.getRoute('camel-params');

      expect(retrievedRoute?.path).toBe(
        '/v2/projects/:project/locations/:location/queues/:queueId/tasks'
      );
    });
  });

  describe('Route Removal', () => {
    test('should remove existing route', () => {
      const route = createRoute.get('/test', simpleHandler, { id: 'removable' });

      router.addRoute(route);

      const removed = router.removeRoute('removable');

      expect(removed).toBe(true);
      expect(router.getRoute('removable')).toBeNull();
    });

    test('should return false for non-existent route', () => {
      const removed = router.removeRoute('non-existent');

      expect(removed).toBe(false);
    });

    test('should clear all routes', () => {
      const routes = [
        createRoute.get('/test1', simpleHandler, { id: 'route1' }),
        createRoute.get('/test2', simpleHandler, { id: 'route2' }),
      ];

      for (const route of routes) {
        router.addRoute(route);
      }

      router.clear();

      expect(router.getAllRoutes()).toHaveLength(0);
    });
  });

  describe('Path Matching', () => {
    beforeEach(() => {
      // Register test routes
      router.addRoute(createRoute.get('/static', simpleHandler, { id: 'static' }));
      router.addRoute(createRoute.get('/users/{userId}', paramHandler, { id: 'user' }));
      router.addRoute(
        createRoute.get('/users/{userId}/posts/{postId}', paramHandler, { id: 'user-post' })
      );
      router.addRoute(
        createRoute.get('/projects/{projectId=projects/*}', paramHandler, { id: 'project' })
      );
    });

    test('should match static paths', async () => {
      const request = createMockRequest('GET', '/static');

      const response = await router.route(request);

      expect(response.status).toBe(200);

      const body = await response.json();

      expect(body.success).toBe(true);
    });

    test('should match parameterized paths', async () => {
      const request = createMockRequest('GET', '/users/123');

      const response = await router.route(request);

      expect(response.status).toBe(200);

      const body = await response.json();

      expect(body.params.userId).toBe('123');
    });

    test('should match nested parameters', async () => {
      const request = createMockRequest('GET', '/users/123/posts/456');

      const response = await router.route(request);

      expect(response.status).toBe(200);

      const body = await response.json();

      expect(body.params.userId).toBe('123');
      expect(body.params.postId).toBe('456');
    });

    test('should match parameters with patterns', async () => {
      const request = createMockRequest('GET', '/projects/projects/my-project');

      const response = await router.route(request);

      expect(response.status).toBe(200);

      const body = await response.json();

      expect(body.params.projectId).toBe('projects/my-project');
    });

    test('should extract camelCase colon-style params with query string containing semicolons', async () => {
      router.addRoute(
        createRoute.post(
          '/v2/projects/:project/locations/:location/queues/:queueId/tasks',
          paramHandler,
          { id: 'create-task' }
        )
      );

      const request = createMockRequest(
        'POST',
        '/v2/projects/mortgage-test/locations/us-central1/queues/test-loan-payment-events-queue/tasks',
        {
          query: { $alt: 'json;enum-encoding=int' },
          body: { httpRequest: { url: 'https://example.com' } },
        }
      );

      const response = await router.route(request);

      expect(response.status).toBe(200);

      const body = await response.json();

      expect(body.params.project).toBe('mortgage-test');
      expect(body.params.location).toBe('us-central1');
      expect(body.params.queueId).toBe('test-loan-payment-events-queue');
    });

    test('should return 404 for unmatched paths', async () => {
      const request = createMockRequest('GET', '/nonexistent');

      const response = await router.route(request);

      expect(response.status).toBe(404);

      const body = await response.json();

      expect(body.error.message).toBe('Not Found');
    });

    test('should match method-specific routes', async () => {
      router.addRoute(createRoute.post('/users', simpleHandler, { id: 'create-user' }));

      const getRequest = createMockRequest('GET', '/users');
      const postRequest = createMockRequest('POST', '/users');

      const getResponse = await router.route(getRequest);
      const postResponse = await router.route(postRequest);

      expect(getResponse.status).toBe(404); // No GET handler for /users
      expect(postResponse.status).toBe(200); // POST handler exists
    });
  });

  describe('Wildcard Support', () => {
    test('should support single wildcard matching', async () => {
      const routerWithWildcards = new RequestRouter(mockLogger, {
        enableWildcards: true,
      });

      routerWithWildcards.addRoute({
        id: 'wildcard-single',
        method: 'GET',
        path: '/files/*',
        handler: paramHandler,
      });

      const request = createMockRequest('GET', '/files/readme.txt');
      const response = await routerWithWildcards.route(request);

      expect(response.status).toBe(200);
    });

    test('should disable wildcards when configured', async () => {
      const routerNoWildcards = new RequestRouter(mockLogger, {
        enableWildcards: false,
      });

      routerNoWildcards.addRoute({
        id: 'literal-star',
        method: 'GET',
        path: '/files/*',
        handler: simpleHandler,
      });

      const request = createMockRequest('GET', '/files/readme.txt');
      const response = await routerNoWildcards.route(request);

      expect(response.status).toBe(404);
    });
  });

  describe('Request Parsing', () => {
    test('should parse query parameters', async () => {
      const queryHandler = async (request: RouteRequest): Promise<RouteResponse> => ({
        status: 200,
        body: { query: request.query },
      });

      router.addRoute(createRoute.get('/search', queryHandler, { id: 'search' }));

      const request = createMockRequest('GET', '/search', {
        query: { q: 'test', limit: '10' },
      });

      const response = await router.route(request);
      const body = await response.json();

      expect(body.query.q).toBe('test');
      expect(body.query.limit).toBe('10');
    });

    test('should parse headers', async () => {
      const headerHandler = async (request: RouteRequest): Promise<RouteResponse> => ({
        status: 200,
        body: { userAgent: request.headers['user-agent'] },
      });

      router.addRoute(createRoute.get('/headers', headerHandler, { id: 'headers' }));

      const request = createMockRequest('GET', '/headers', {
        headers: { 'User-Agent': 'TestAgent/1.0' },
      });

      const response = await router.route(request);
      const body = await response.json();

      expect(body.userAgent).toBe('TestAgent/1.0');
    });

    test('should parse JSON body', async () => {
      const bodyHandler = async (request: RouteRequest): Promise<RouteResponse> => ({
        status: 200,
        body: { receivedBody: request.body },
      });

      router.addRoute(createRoute.post('/data', bodyHandler, { id: 'data' }));

      const testData = { name: 'test', value: 42 };
      const request = createMockRequest('POST', '/data', {
        body: testData,
      });

      const response = await router.route(request);
      const body = await response.json();

      expect(body.receivedBody).toEqual(testData);
    });

    test('should handle multiple query parameter values', async () => {
      const multiQueryHandler = async (request: RouteRequest): Promise<RouteResponse> => ({
        status: 200,
        body: { tags: request.query.tag },
      });

      router.addRoute(createRoute.get('/multi', multiQueryHandler, { id: 'multi' }));

      // Simulate multiple values for same parameter
      const url = new URL('http://localhost/multi');

      url.searchParams.append('tag', 'tag1');
      url.searchParams.append('tag', 'tag2');

      const request = new Request(url.toString());

      const response = await router.route(request);
      const body = await response.json();

      expect(Array.isArray(body.tags)).toBe(true);
      expect(body.tags).toContain('tag1');
      expect(body.tags).toContain('tag2');
    });
  });

  describe('Middleware Support', () => {
    test('should execute middleware before handler', async () => {
      const executionOrder: string[] = [];

      const middleware1 = async (
        request: RouteRequest,
        context: RouteContext,
        next: () => Promise<RouteResponse> | RouteResponse
      ) => {
        executionOrder.push('middleware1');

        return await next();
      };

      const middleware2 = async (
        request: RouteRequest,
        context: RouteContext,
        next: () => Promise<RouteResponse> | RouteResponse
      ) => {
        executionOrder.push('middleware2');

        return await next();
      };

      const handler = async (): Promise<RouteResponse> => {
        executionOrder.push('handler');

        return { status: 200, body: { order: executionOrder } };
      };

      const route: RouteDefinition = {
        id: 'middleware-test',
        method: 'GET',
        path: '/middleware',
        handler,
        middleware: [middleware1, middleware2],
      };

      router.addRoute(route);

      const request = createMockRequest('GET', '/middleware');
      const response = await router.route(request);
      const body = await response.json();

      expect(body.order).toEqual(['middleware1', 'middleware2', 'handler']);
    });

    test('should allow middleware to modify request', async () => {
      const authMiddleware = async (
        request: RouteRequest,
        context: RouteContext,
        next: () => Promise<RouteResponse> | RouteResponse
      ) => {
        // Add auth info to request metadata
        (request as RouteRequest & { auth?: { userId: string } }).auth = { userId: '123' };

        return await next();
      };

      const handler = async (request: RouteRequest): Promise<RouteResponse> => ({
        status: 200,
        body: { auth: (request as RouteRequest & { auth?: { userId: string } }).auth },
      });

      const route: RouteDefinition = {
        id: 'auth-test',
        method: 'GET',
        path: '/protected',
        handler,
        middleware: [authMiddleware],
      };

      router.addRoute(route);

      const request = createMockRequest('GET', '/protected');
      const response = await router.route(request);
      const body = await response.json();

      expect(body.auth.userId).toBe('123');
    });

    test('should allow middleware to short-circuit request', async () => {
      const authMiddleware = async (): Promise<RouteResponse> => ({
        status: 401,
        body: { error: 'Unauthorized' },
      });

      const handler = async (): Promise<RouteResponse> => ({
        status: 200,
        body: { success: true },
      });

      const route: RouteDefinition = {
        id: 'short-circuit',
        method: 'GET',
        path: '/auth-required',
        handler,
        middleware: [authMiddleware],
      };

      router.addRoute(route);

      const request = createMockRequest('GET', '/auth-required');
      const response = await router.route(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('Error Handling', () => {
    test('should handle handler errors gracefully', async () => {
      router.addRoute(createRoute.get('/error', errorHandler, { id: 'error' }));

      const request = createMockRequest('GET', '/error');

      const response = await router.route(request);

      expect(response.status).toBe(500);

      const body = await response.json();

      expect(body.error.message).toBe('Internal Server Error');
    });

    test('should handle middleware errors', async () => {
      const faultyMiddleware = async (): Promise<RouteResponse> => {
        throw new Error('Middleware error');
      };

      const route: RouteDefinition = {
        id: 'middleware-error',
        method: 'GET',
        path: '/middleware-error',
        handler: simpleHandler,
        middleware: [faultyMiddleware],
      };

      router.addRoute(route);

      const request = createMockRequest('GET', '/middleware-error');
      const response = await router.route(request);

      expect(response.status).toBe(500);
    });
  });

  describe('Router Metrics', () => {
    test('should track routing metrics', async () => {
      const route = createRoute.get('/metrics', simpleHandler, { id: 'metrics' });

      router.addRoute(route);

      const request = createMockRequest('GET', '/metrics');

      await router.route(request);

      const metrics = router.getMetrics();

      expect(metrics.totalRoutes).toBe(1);
      expect(metrics.totalRequests).toBe(1);
      expect(metrics.successfulRequests).toBe(1);
      expect(metrics.errorRequests).toBe(0);
      expect(metrics.notFoundRequests).toBe(0);
      expect(metrics.averageResponseTime).toBeGreaterThan(0);
    });

    test('should track error metrics', async () => {
      router.addRoute(createRoute.get('/error', errorHandler, { id: 'error' }));

      const request = createMockRequest('GET', '/error');

      await router.route(request);

      const metrics = router.getMetrics();

      expect(metrics.errorRequests).toBe(1);
    });

    test('should track not found metrics', async () => {
      const request = createMockRequest('GET', '/nonexistent');

      await router.route(request);

      const metrics = router.getMetrics();

      expect(metrics.notFoundRequests).toBe(1);
    });
  });

  describe('Route Utilities', () => {
    test('should get routes by method', () => {
      const getRoute = createRoute.get('/get', simpleHandler, { id: 'get' });
      const postRoute = createRoute.post('/post', simpleHandler, { id: 'post' });

      router.addRoute(getRoute);
      router.addRoute(postRoute);

      const getRoutes = router.getRoutesByMethod('GET');
      const postRoutes = router.getRoutesByMethod('POST');

      expect(getRoutes).toHaveLength(1);
      expect(postRoutes).toHaveLength(1);

      const foundGetRoute = getRoutes[0];
      const foundPostRoute = postRoutes[0];

      expect(foundGetRoute).toBeDefined();
      expect(foundPostRoute).toBeDefined();

      if (foundGetRoute) {
        expect(foundGetRoute.id).toBe('get');
      }

      if (foundPostRoute) {
        expect(foundPostRoute.id).toBe('post');
      }
    });

    test('should get all routes', () => {
      const routes = [
        createRoute.get('/route1', simpleHandler, { id: 'route1' }),
        createRoute.post('/route2', simpleHandler, { id: 'route2' }),
      ];

      for (const route of routes) {
        router.addRoute(route);
      }

      const allRoutes = router.getAllRoutes();

      expect(allRoutes).toHaveLength(2);
    });
  });

  describe('Configuration Options', () => {
    test('should respect case sensitivity setting', () => {
      const caseSensitiveRouter = new RequestRouter(mockLogger, {
        caseSensitive: true,
        enablePathNormalization: false,
      });

      const route = createRoute.get('/Test', simpleHandler, { id: 'case-test' });

      caseSensitiveRouter.addRoute(route);

      expect(caseSensitiveRouter.getRoute('case-test')?.path).toBe('/Test');
    });

    test('should handle trailing slash configuration', () => {
      const strictSlashRouter = new RequestRouter(mockLogger, {
        strictTrailingSlash: true,
        enablePathNormalization: true,
      });

      const route = createRoute.get('/test/', simpleHandler, { id: 'slash-test' });

      strictSlashRouter.addRoute(route);

      expect(strictSlashRouter.getRoute('slash-test')?.path).toBe('/test/');
    });

    test('should use default configuration when none provided', () => {
      const defaultRouter = new RequestRouter(mockLogger);

      expect(defaultRouter).toBeInstanceOf(RequestRouter);
    });
  });

  describe('Response Formatting', () => {
    test('should format JSON responses correctly', async () => {
      const jsonHandler = async (): Promise<RouteResponse> => ({
        status: 200,
        body: { data: 'test', number: 42 },
        headers: { 'X-Custom': 'value' },
      });

      router.addRoute(createRoute.get('/json', jsonHandler, { id: 'json' }));

      const request = createMockRequest('GET', '/json');
      const response = await router.route(request);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');
      expect(response.headers.get('X-Custom')).toBe('value');

      const body = await response.json();

      expect(body.data).toBe('test');
      expect(body.number).toBe(42);
    });

    test('should format text responses correctly', async () => {
      const textHandler = async (): Promise<RouteResponse> => ({
        status: 200,
        body: 'Plain text response',
      });

      router.addRoute(createRoute.get('/text', textHandler, { id: 'text' }));

      const request = createMockRequest('GET', '/text');
      const response = await router.route(request);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/plain');

      const text = await response.text();

      expect(text).toBe('Plain text response');
    });

    test('should handle empty responses', async () => {
      const emptyHandler = async (): Promise<RouteResponse> => ({
        status: 204,
      });

      router.addRoute(createRoute.delete('/delete', emptyHandler, { id: 'delete' }));

      const request = createMockRequest('DELETE', '/delete');
      const response = await router.route(request);

      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
    });
  });

  describe('GCP action-suffix route specificity', () => {
    let router: RequestRouter;

    const actionHandler = async (
      req: RouteRequest,
      _ctx: RouteContext
    ): Promise<RouteResponse> => ({
      status: 200,
      body: { matched: 'action', params: req.params },
    });

    const crudHandler = async (req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> => ({
      status: 200,
      body: { matched: 'crud', params: req.params },
    });

    beforeEach(() => {
      router = new RequestRouter(mockLogger);

      // Register CRUD route first (same order as schema-handlers.ts)
      router.addRoute(
        createRoute.get('/v1/projects/:project/schemas/:schema', crudHandler, {
          id: 'schemas.get',
        })
      );

      router.addRoute(
        createRoute.get('/v1/projects/:project/schemas/:schema:listRevisions', actionHandler, {
          id: 'schemas.listRevisions',
        })
      );

      router.addRoute(
        createRoute.delete('/v1/projects/:project/schemas/:schema', crudHandler, {
          id: 'schemas.delete',
        })
      );

      router.addRoute(
        createRoute.delete('/v1/projects/:project/schemas/:schema:deleteRevision', actionHandler, {
          id: 'schemas.deleteRevision',
        })
      );
    });

    test('GET :listRevisions action route is not shadowed by :schema CRUD route', async () => {
      const response = await router.route(
        createMockRequest('GET', '/v1/projects/p1/schemas/s1:listRevisions')
      );

      expect(response.status).toBe(200);

      const body = await response.json();

      expect(body.matched).toBe('action');
      expect(body.params.schema).toBe('s1');
    });

    test('DELETE :deleteRevision action route is not shadowed by :schema CRUD route', async () => {
      const response = await router.route(
        createMockRequest('DELETE', '/v1/projects/p1/schemas/s1:deleteRevision')
      );

      expect(response.status).toBe(200);

      const body = await response.json();

      expect(body.matched).toBe('action');
      expect(body.params.schema).toBe('s1');
    });

    test('plain :schema CRUD routes still work correctly', async () => {
      const getResponse = await router.route(
        createMockRequest('GET', '/v1/projects/p1/schemas/s1')
      );

      expect(getResponse.status).toBe(200);

      const getBody = await getResponse.json();

      expect(getBody.matched).toBe('crud');
      expect(getBody.params.schema).toBe('s1');

      const deleteResponse = await router.route(
        createMockRequest('DELETE', '/v1/projects/p1/schemas/s1')
      );

      expect(deleteResponse.status).toBe(200);

      const deleteBody = await deleteResponse.json();

      expect(deleteBody.matched).toBe('crud');
      expect(deleteBody.params.schema).toBe('s1');
    });
  });
});
