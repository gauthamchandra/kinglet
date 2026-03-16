/**
 * Unit tests for TopicHandlers
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RouteContext, RouteDefinition, RouteRequest } from '@/core/gateway/request-router.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { TopicHandlers } from './topic-handlers.ts';
import type { TopicService } from './topic-service.ts';
import { PubSubError } from './types.ts';

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/v1/projects/p/topics',
    query: {},
    headers: {},
    params: {},
    body: undefined,
    originalRequest: new Request('http://localhost'),
    ...overrides,
  };
}

function makeContext(): RouteContext {
  return {
    routeId: 'test',
    startTime: Date.now(),
    metadata: {},
    logger: new Logger('test', 'error'),
  };
}

function findRoute(routes: RouteDefinition[], id: string) {
  const route = routes.find(r => r.id === id);

  if (!route) throw new Error(`Route ${id} not found`);

  return route;
}

describe('TopicHandlers', () => {
  let mockService: TopicService;
  let handlers: TopicHandlers;

  beforeEach(() => {
    mockService = {
      createTopic: mock(() =>
        Promise.resolve({
          name: 'projects/p/topics/t',
          state: 'ACTIVE',
        })
      ),
      getTopic: mock(() =>
        Promise.resolve({
          name: 'projects/p/topics/t',
          state: 'ACTIVE',
        })
      ),
      listTopics: mock(() =>
        Promise.resolve({
          topics: [{ name: 'projects/p/topics/t', state: 'ACTIVE' }],
        })
      ),
      updateTopic: mock(() =>
        Promise.resolve({
          name: 'projects/p/topics/t',
          state: 'ACTIVE',
          labels: { env: 'prod' },
        })
      ),
      deleteTopic: mock(() => Promise.resolve()),
    } as unknown as TopicService;

    handlers = new TopicHandlers(mockService, new Logger('test', 'error'));
  });

  test('getRoutes returns route definitions', () => {
    const routes = handlers.getRoutes();

    expect(routes.length).toBeGreaterThanOrEqual(5);

    const ids = routes.map(r => r.id);

    expect(ids).toContain('pubsub.topics.create');
    expect(ids).toContain('pubsub.topics.get');
    expect(ids).toContain('pubsub.topics.list');
    expect(ids).toContain('pubsub.topics.delete');
    expect(ids).toContain('pubsub.topics.patch');
  });

  test('handleCreateTopic returns 200 with topic', async () => {
    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.topics.create');

    const response = await route.handler(
      makeRequest({
        method: 'PUT',
        params: { project: 'p', topic: 't' },
        body: { labels: { env: 'test' } },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.createTopic).toHaveBeenCalled();
  });

  test('handleGetTopic returns 200 with topic', async () => {
    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.topics.get');

    const response = await route.handler(
      makeRequest({
        params: { project: 'p', topic: 't' },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.getTopic).toHaveBeenCalled();
  });

  test('handleGetTopic returns 404 when NOT_FOUND', async () => {
    (mockService.getTopic as ReturnType<typeof mock>).mockImplementation(() => {
      throw new PubSubError('NOT_FOUND', 'Topic not found');
    });

    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.topics.get');

    const response = await route.handler(
      makeRequest({
        params: { project: 'p', topic: 'missing' },
      }),
      makeContext()
    );

    expect(response.status).toBe(404);
  });

  test('handleListTopics returns 200 with topics array', async () => {
    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.topics.list');

    const response = await route.handler(
      makeRequest({
        params: { project: 'p' },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.listTopics).toHaveBeenCalled();
  });

  test('handleDeleteTopic returns 200', async () => {
    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.topics.delete');

    const response = await route.handler(
      makeRequest({
        method: 'DELETE',
        params: { project: 'p', topic: 't' },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.deleteTopic).toHaveBeenCalled();
  });

  test('handleDeleteTopic returns 404 when NOT_FOUND', async () => {
    (mockService.deleteTopic as ReturnType<typeof mock>).mockImplementation(() => {
      throw new PubSubError('NOT_FOUND', 'Topic not found');
    });

    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.topics.delete');

    const response = await route.handler(
      makeRequest({
        method: 'DELETE',
        params: { project: 'p', topic: 'missing' },
      }),
      makeContext()
    );

    expect(response.status).toBe(404);
  });

  test('handleUpdateTopic returns 200 with updated topic', async () => {
    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.topics.patch');

    const response = await route.handler(
      makeRequest({
        method: 'PATCH',
        params: { project: 'p', topic: 't' },
        body: { topic: { labels: { env: 'prod' } }, updateMask: 'labels' },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.updateTopic).toHaveBeenCalled();
  });

  test('ALREADY_EXISTS maps to 409', async () => {
    (mockService.createTopic as ReturnType<typeof mock>).mockImplementation(() => {
      throw new PubSubError('ALREADY_EXISTS', 'Topic already exists');
    });

    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.topics.create');

    const response = await route.handler(
      makeRequest({
        method: 'PUT',
        params: { project: 'p', topic: 't' },
        body: {},
      }),
      makeContext()
    );

    expect(response.status).toBe(409);
  });

  test('INVALID_ARGUMENT maps to 400', async () => {
    (mockService.createTopic as ReturnType<typeof mock>).mockImplementation(() => {
      throw new PubSubError('INVALID_ARGUMENT', 'Bad request');
    });

    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.topics.create');

    const response = await route.handler(
      makeRequest({
        method: 'PUT',
        params: { project: 'p', topic: 't' },
        body: {},
      }),
      makeContext()
    );

    expect(response.status).toBe(400);
  });
});
