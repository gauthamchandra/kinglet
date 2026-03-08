/**
 * Tests for TaskHandlers
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { RouteContext, RouteRequest } from '@/core/gateway/request-router.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { QueueRepository } from './queue-repository.ts';
import { QueueService } from './queue-service.ts';
import { TaskHandlers } from './task-handlers.ts';
import { TaskRepository } from './task-repository.ts';
import { TaskService } from './task-service.ts';

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

describe('TaskHandlers', () => {
  let storage: StorageManager;
  let queueRepo: QueueRepository;
  let taskRepo: TaskRepository;
  let queueService: QueueService;
  let taskService: TaskService;
  let handlers: TaskHandlers;
  let ctx: RouteContext;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    queueRepo = new QueueRepository(storage);
    await queueRepo.initialize();

    taskRepo = new TaskRepository(storage);
    await taskRepo.initialize();

    queueService = new QueueService(queueRepo);
    taskService = new TaskService(taskRepo, queueRepo);
    handlers = new TaskHandlers(taskService, new Logger('Test'));
    ctx = makeContext();

    await queueService.createQueue('p', 'l', 'q', {});
  });

  describe('getRoutes', () => {
    test('should return 5 route definitions', () => {
      const routes = handlers.getRoutes();

      expect(routes.length).toBe(5);
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

      expect(ids).toContain('tasks.tasks.create');
      expect(ids).toContain('tasks.tasks.get');
      expect(ids).toContain('tasks.tasks.list');
      expect(ids).toContain('tasks.tasks.delete');
      expect(ids).toContain('tasks.tasks.run');
    });
  });

  describe('create task handler', () => {
    test('should create a task', async () => {
      const routes = handlers.getRoutes();
      const createRoute = routes.find(r => r.id === 'tasks.tasks.create');

      const req = makeRouteRequest({
        method: 'POST',
        params: { project: 'p', location: 'l', queueId: 'q' },
        body: {
          task: {
            httpRequest: {
              url: 'https://example.com/handler',
              httpMethod: 'POST',
            },
          },
        },
      });

      const res = await createRoute?.handler(req, ctx);

      expect(res?.status).toBe(200);

      const body = res?.body as Record<string, unknown>;

      expect(body.name).toBeTypeOf('string');
    });

    test('should propagate responseView from body', async () => {
      const routes = handlers.getRoutes();
      const createRoute = routes.find(r => r.id === 'tasks.tasks.create');

      const req = makeRouteRequest({
        method: 'POST',
        params: { project: 'p', location: 'l', queueId: 'q' },
        body: {
          task: {
            httpRequest: {
              url: 'https://example.com',
              httpMethod: 'POST',
              body: Buffer.from('data').toString('base64'),
            },
          },
          responseView: 'BASIC',
        },
      });

      const res = await createRoute?.handler(req, ctx);

      expect(res?.status).toBe(200);

      const body = res?.body as Record<string, unknown>;
      const httpRequest = body.httpRequest as Record<string, unknown>;

      expect(httpRequest.body).toBeUndefined();
    });
  });

  describe('get task handler', () => {
    test('should get a task', async () => {
      await taskService.createTask('p', 'l', 'q', {
        task: {
          name: 'projects/p/locations/l/queues/q/tasks/t1',
          httpRequest: { url: 'https://example.com', httpMethod: 'GET' },
        },
      });

      const routes = handlers.getRoutes();
      const getRoute = routes.find(r => r.id === 'tasks.tasks.get');

      const req = makeRouteRequest({
        params: { project: 'p', location: 'l', queueId: 'q', taskId: 't1' },
      });

      const res = await getRoute?.handler(req, ctx);

      expect(res?.status).toBe(200);

      const body = res?.body as Record<string, unknown>;

      expect(body.name).toBe('projects/p/locations/l/queues/q/tasks/t1');
    });

    test('should propagate responseView from query param', async () => {
      await taskService.createTask('p', 'l', 'q', {
        task: {
          name: 'projects/p/locations/l/queues/q/tasks/t1',
          httpRequest: {
            url: 'https://example.com',
            httpMethod: 'POST',
            body: Buffer.from('data').toString('base64'),
          },
        },
      });

      const routes = handlers.getRoutes();
      const getRoute = routes.find(r => r.id === 'tasks.tasks.get');

      const req = makeRouteRequest({
        params: { project: 'p', location: 'l', queueId: 'q', taskId: 't1' },
        query: { responseView: 'BASIC' },
      });

      const res = await getRoute?.handler(req, ctx);

      expect(res?.status).toBe(200);

      const body = res?.body as Record<string, unknown>;
      const httpRequest = body.httpRequest as Record<string, unknown>;

      expect(httpRequest.body).toBeUndefined();
    });

    test('should return 404 for missing task', async () => {
      const routes = handlers.getRoutes();
      const getRoute = routes.find(r => r.id === 'tasks.tasks.get');

      const req = makeRouteRequest({
        params: { project: 'p', location: 'l', queueId: 'q', taskId: 'nonexistent' },
      });

      const res = await getRoute?.handler(req, ctx);

      expect(res?.status).toBe(404);
    });
  });

  describe('list tasks handler', () => {
    test('should list tasks', async () => {
      await taskService.createTask('p', 'l', 'q', {
        task: {
          name: 'projects/p/locations/l/queues/q/tasks/t1',
          httpRequest: { url: 'https://example.com', httpMethod: 'POST' },
        },
      });
      await taskService.createTask('p', 'l', 'q', {
        task: {
          name: 'projects/p/locations/l/queues/q/tasks/t2',
          httpRequest: { url: 'https://example.com', httpMethod: 'POST' },
        },
      });

      const routes = handlers.getRoutes();
      const listRoute = routes.find(r => r.id === 'tasks.tasks.list');

      const req = makeRouteRequest({
        params: { project: 'p', location: 'l', queueId: 'q' },
      });

      const res = await listRoute?.handler(req, ctx);

      expect(res?.status).toBe(200);

      const body = res?.body as Record<string, unknown>;
      const tasks = body.tasks as unknown[];

      expect(tasks.length).toBe(2);
    });
  });

  describe('delete task handler', () => {
    test('should delete a task', async () => {
      await taskService.createTask('p', 'l', 'q', {
        task: {
          name: 'projects/p/locations/l/queues/q/tasks/t1',
          httpRequest: { url: 'https://example.com', httpMethod: 'POST' },
        },
      });

      const routes = handlers.getRoutes();
      const deleteRoute = routes.find(r => r.id === 'tasks.tasks.delete');

      const req = makeRouteRequest({
        params: { project: 'p', location: 'l', queueId: 'q', taskId: 't1' },
      });

      const res = await deleteRoute?.handler(req, ctx);

      expect(res?.status).toBe(200);
    });
  });

  describe('run task handler', () => {
    test('should run a task', async () => {
      await taskService.createTask('p', 'l', 'q', {
        task: {
          name: 'projects/p/locations/l/queues/q/tasks/t1',
          httpRequest: { url: 'https://example.com', httpMethod: 'POST' },
        },
      });

      const routes = handlers.getRoutes();
      const runRoute = routes.find(r => r.id === 'tasks.tasks.run');

      const req = makeRouteRequest({
        params: { project: 'p', location: 'l', queueId: 'q', taskId: 't1' },
      });

      const res = await runRoute?.handler(req, ctx);

      expect(res?.status).toBe(200);

      const body = res?.body as Record<string, unknown>;

      expect(body.name).toBe('projects/p/locations/l/queues/q/tasks/t1');
    });
  });
});
