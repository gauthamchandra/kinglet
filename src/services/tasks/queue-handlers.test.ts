/**
 * Tests for QueueHandlers
 */

import { test, expect, describe, beforeEach } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { QueueRepository } from './queue-repository.ts';
import { QueueService } from './queue-service.ts';
import { QueueHandlers } from './queue-handlers.ts';
import { Logger } from '@/shared/utils/logger.ts';
import type { RouteRequest, RouteContext } from '@/core/gateway/request-router.ts';

function makeRouteRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/',
    query: {},
    headers: {},
    params: {},
    body: undefined,
    originalRequest: new Request('http://localhost/'),
    ...overrides,
  };
}

function makeContext(): RouteContext {
  return {
    routeId: 'test',
    startTime: Date.now(),
    metadata: {},
    logger: new Logger('Test'),
  };
}

describe('QueueHandlers', () => {
  let storage: StorageManager;
  let repo: QueueRepository;
  let service: QueueService;
  let handlers: QueueHandlers;
  let ctx: RouteContext;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new QueueRepository(storage);
    await repo.initialize();
    service = new QueueService(repo);
    handlers = new QueueHandlers(service, new Logger('Test'));
    ctx = makeContext();
  });

  describe('getRoutes', () => {
    test('should return 8 route definitions', () => {
      const routes = handlers.getRoutes();

      expect(routes.length).toBe(8);
    });

    test('should use /v2/ prefix for all routes', () => {
      const routes = handlers.getRoutes();

      for (const route of routes) {
        expect(route.path).toMatch(/^\/v2\//);
      }
    });

    test('should define correct route IDs', () => {
      const routes = handlers.getRoutes();
      const ids = routes.map(r => r.id);

      expect(ids).toContain('tasks.queues.create');
      expect(ids).toContain('tasks.queues.get');
      expect(ids).toContain('tasks.queues.list');
      expect(ids).toContain('tasks.queues.patch');
      expect(ids).toContain('tasks.queues.delete');
      expect(ids).toContain('tasks.queues.pause');
      expect(ids).toContain('tasks.queues.resume');
      expect(ids).toContain('tasks.queues.purge');
    });
  });

  describe('create queue handler', () => {
    test('should create a queue via handler', async () => {
      const routes = handlers.getRoutes();
      const createRoute = routes.find(r => r.id === 'tasks.queues.create');

      const req = makeRouteRequest({
        method: 'POST',
        params: { project: 'p', location: 'l' },
        query: { queueId: 'my-queue' },
        body: {},
      });

      const res = await createRoute?.handler(req, ctx);

      expect(res?.status).toBe(200);

      const body = res?.body as Record<string, unknown>;

      expect(body.name).toBe('projects/p/locations/l/queues/my-queue');
    });

    test('should extract queueId from body.name', async () => {
      const routes = handlers.getRoutes();
      const createRoute = routes.find(r => r.id === 'tasks.queues.create');

      const req = makeRouteRequest({
        method: 'POST',
        params: { project: 'p', location: 'l' },
        body: {
          name: 'projects/p/locations/l/queues/from-name',
        },
      });

      const res = await createRoute?.handler(req, ctx);

      expect(res?.status).toBe(200);

      const body = res?.body as Record<string, unknown>;

      expect(body.name).toBe('projects/p/locations/l/queues/from-name');
    });
  });

  describe('get queue handler', () => {
    test('should get a queue by name', async () => {
      await service.createQueue('p', 'l', 'q', {});

      const routes = handlers.getRoutes();
      const getRoute = routes.find(r => r.id === 'tasks.queues.get');

      const req = makeRouteRequest({
        params: { project: 'p', location: 'l', queueId: 'q' },
      });

      const res = await getRoute?.handler(req, ctx);

      expect(res?.status).toBe(200);

      const body = res?.body as Record<string, unknown>;

      expect(body.name).toBe('projects/p/locations/l/queues/q');
    });

    test('should return 404 for missing queue', async () => {
      const routes = handlers.getRoutes();
      const getRoute = routes.find(r => r.id === 'tasks.queues.get');

      const req = makeRouteRequest({
        params: { project: 'p', location: 'l', queueId: 'nonexistent' },
      });

      const res = await getRoute?.handler(req, ctx);

      expect(res?.status).toBe(404);
    });
  });

  describe('list queues handler', () => {
    test('should list queues', async () => {
      await service.createQueue('p', 'l', 'q1', {});
      await service.createQueue('p', 'l', 'q2', {});

      const routes = handlers.getRoutes();
      const listRoute = routes.find(r => r.id === 'tasks.queues.list');

      const req = makeRouteRequest({
        params: { project: 'p', location: 'l' },
      });

      const res = await listRoute?.handler(req, ctx);

      expect(res?.status).toBe(200);

      const body = res?.body as Record<string, unknown>;
      const queues = body.queues as unknown[];

      expect(queues.length).toBe(2);
    });
  });

  describe('delete queue handler', () => {
    test('should delete a queue', async () => {
      await service.createQueue('p', 'l', 'q', {});

      const routes = handlers.getRoutes();
      const deleteRoute = routes.find(r => r.id === 'tasks.queues.delete');

      const req = makeRouteRequest({
        params: { project: 'p', location: 'l', queueId: 'q' },
      });

      const res = await deleteRoute?.handler(req, ctx);

      expect(res?.status).toBe(200);
    });
  });

  describe('pause queue handler', () => {
    test('should pause a queue', async () => {
      await service.createQueue('p', 'l', 'q', {});

      const routes = handlers.getRoutes();
      const pauseRoute = routes.find(r => r.id === 'tasks.queues.pause');

      const req = makeRouteRequest({
        params: { project: 'p', location: 'l', queueId: 'q' },
      });

      const res = await pauseRoute?.handler(req, ctx);

      expect(res?.status).toBe(200);

      const body = res?.body as Record<string, unknown>;

      expect(body.state).toBe('PAUSED');
    });
  });

  describe('resume queue handler', () => {
    test('should resume a paused queue', async () => {
      await service.createQueue('p', 'l', 'q', {});
      await service.pauseQueue('projects/p/locations/l/queues/q');

      const routes = handlers.getRoutes();
      const resumeRoute = routes.find(r => r.id === 'tasks.queues.resume');

      const req = makeRouteRequest({
        params: { project: 'p', location: 'l', queueId: 'q' },
      });

      const res = await resumeRoute?.handler(req, ctx);

      expect(res?.status).toBe(200);

      const body = res?.body as Record<string, unknown>;

      expect(body.state).toBe('RUNNING');
    });
  });

  describe('purge queue handler', () => {
    test('should purge a queue', async () => {
      await service.createQueue('p', 'l', 'q', {});

      const routes = handlers.getRoutes();
      const purgeRoute = routes.find(r => r.id === 'tasks.queues.purge');

      const req = makeRouteRequest({
        params: { project: 'p', location: 'l', queueId: 'q' },
      });

      const res = await purgeRoute?.handler(req, ctx);

      expect(res?.status).toBe(200);

      const body = res?.body as Record<string, unknown>;

      expect(body.purgeTime).toBeTypeOf('string');
    });
  });

  describe('error mapping', () => {
    test('should map ALREADY_EXISTS to 409', async () => {
      await service.createQueue('p', 'l', 'q', {});

      const routes = handlers.getRoutes();
      const createRoute = routes.find(r => r.id === 'tasks.queues.create');

      const req = makeRouteRequest({
        method: 'POST',
        params: { project: 'p', location: 'l' },
        query: { queueId: 'q' },
        body: {},
      });

      const res = await createRoute?.handler(req, ctx);

      expect(res?.status).toBe(409);
    });

    test('should map FAILED_PRECONDITION to 400', async () => {
      await service.createQueue('p', 'l', 'q', {});

      const routes = handlers.getRoutes();
      const resumeRoute = routes.find(r => r.id === 'tasks.queues.resume');

      const req = makeRouteRequest({
        params: { project: 'p', location: 'l', queueId: 'q' },
      });

      const res = await resumeRoute?.handler(req, ctx);

      expect(res?.status).toBe(400);
    });
  });
});
