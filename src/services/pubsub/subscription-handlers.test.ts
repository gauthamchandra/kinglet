/**
 * Unit tests for SubscriptionHandlers
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RouteContext, RouteDefinition, RouteRequest } from '@/core/gateway/request-router.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { SubscriptionHandlers } from './subscription-handlers.ts';
import type { SubscriptionService } from './subscription-service.ts';
import { PubSubError } from './types.ts';

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/v1/projects/p/subscriptions',
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

describe('SubscriptionHandlers', () => {
  let mockService: SubscriptionService;
  let handlers: SubscriptionHandlers;

  beforeEach(() => {
    mockService = {
      createSubscription: mock(() =>
        Promise.resolve({
          name: 'projects/p/subscriptions/s',
          topic: 'projects/p/topics/t',
          ackDeadlineSeconds: 10,
          messageRetentionDuration: '604800s',
          state: 'ACTIVE',
        })
      ),
      getSubscription: mock(() =>
        Promise.resolve({
          name: 'projects/p/subscriptions/s',
          topic: 'projects/p/topics/t',
          ackDeadlineSeconds: 10,
          messageRetentionDuration: '604800s',
          state: 'ACTIVE',
        })
      ),
      listSubscriptions: mock(() =>
        Promise.resolve({
          subscriptions: [
            {
              name: 'projects/p/subscriptions/s',
              topic: 'projects/p/topics/t',
              ackDeadlineSeconds: 10,
              messageRetentionDuration: '604800s',
              state: 'ACTIVE',
            },
          ],
        })
      ),
      updateSubscription: mock(() =>
        Promise.resolve({
          name: 'projects/p/subscriptions/s',
          topic: 'projects/p/topics/t',
          ackDeadlineSeconds: 30,
          messageRetentionDuration: '604800s',
          state: 'ACTIVE',
        })
      ),
      deleteSubscription: mock(() => Promise.resolve()),
      publish: mock(() => Promise.resolve({ messageIds: ['msg-1'] })),
      pull: mock(() =>
        Promise.resolve({
          receivedMessages: [
            {
              ackId: 'ack-1',
              message: {
                messageId: 'msg-1',
                data: btoa('hello'),
                publishTime: new Date().toISOString(),
              },
            },
          ],
        })
      ),
      acknowledge: mock(() => Promise.resolve()),
      modifyAckDeadline: mock(() => Promise.resolve()),
      modifyPushConfig: mock(() => Promise.resolve()),
      detachSubscription: mock(() => Promise.resolve()),
      seek: mock(() => Promise.resolve()),
      listTopicSubscriptions: mock(() =>
        Promise.resolve({ subscriptions: ['projects/p/subscriptions/s'] })
      ),
    } as unknown as SubscriptionService;

    handlers = new SubscriptionHandlers(mockService, new Logger('test', 'error'));
  });

  test('getRoutes returns route definitions', () => {
    const routes = handlers.getRoutes();

    expect(routes.length).toBeGreaterThanOrEqual(11);

    const ids = routes.map(r => r.id);

    expect(ids).toContain('pubsub.subscriptions.create');
    expect(ids).toContain('pubsub.subscriptions.get');
    expect(ids).toContain('pubsub.subscriptions.list');
    expect(ids).toContain('pubsub.subscriptions.delete');
    expect(ids).toContain('pubsub.subscriptions.patch');
    expect(ids).toContain('pubsub.subscriptions.pull');
    expect(ids).toContain('pubsub.subscriptions.acknowledge');
    expect(ids).toContain('pubsub.subscriptions.modifyAckDeadline');
    expect(ids).toContain('pubsub.subscriptions.modifyPushConfig');
    expect(ids).toContain('pubsub.subscriptions.seek');
    expect(ids).toContain('pubsub.subscriptions.detach');
  });

  // ── Subscription CRUD ──

  test('handleCreateSubscription returns 200 with subscription', async () => {
    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.subscriptions.create');

    const response = await route.handler(
      makeRequest({
        method: 'PUT',
        params: { project: 'p', subscription: 's' },
        body: { topic: 'projects/p/topics/t' },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.createSubscription).toHaveBeenCalled();
  });

  test('handleGetSubscription returns 200 with subscription', async () => {
    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.subscriptions.get');

    const response = await route.handler(
      makeRequest({
        params: { project: 'p', subscription: 's' },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.getSubscription).toHaveBeenCalled();
  });

  test('handleGetSubscription returns 404 when NOT_FOUND', async () => {
    (mockService.getSubscription as ReturnType<typeof mock>).mockImplementation(() => {
      throw new PubSubError('NOT_FOUND', 'Subscription not found');
    });

    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.subscriptions.get');

    const response = await route.handler(
      makeRequest({
        params: { project: 'p', subscription: 'missing' },
      }),
      makeContext()
    );

    expect(response.status).toBe(404);
  });

  test('handleListSubscriptions returns 200 with subscriptions', async () => {
    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.subscriptions.list');

    const response = await route.handler(
      makeRequest({
        params: { project: 'p' },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.listSubscriptions).toHaveBeenCalled();
  });

  test('handleDeleteSubscription returns 200', async () => {
    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.subscriptions.delete');

    const response = await route.handler(
      makeRequest({
        method: 'DELETE',
        params: { project: 'p', subscription: 's' },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.deleteSubscription).toHaveBeenCalled();
  });

  test('handleUpdateSubscription returns 200', async () => {
    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.subscriptions.patch');

    const response = await route.handler(
      makeRequest({
        method: 'PATCH',
        params: { project: 'p', subscription: 's' },
        body: { subscription: { ackDeadlineSeconds: 30 }, updateMask: 'ackDeadlineSeconds' },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.updateSubscription).toHaveBeenCalled();
  });

  // ── Publish ──

  test('handlePublish returns 200 with messageIds', async () => {
    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.topics.publish');

    const response = await route.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', topic: 't' },
        body: { messages: [{ data: btoa('hello') }] },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.publish).toHaveBeenCalled();
  });

  test('handlePublish returns 404 when topic NOT_FOUND', async () => {
    (mockService.publish as ReturnType<typeof mock>).mockImplementation(() => {
      throw new PubSubError('NOT_FOUND', 'Topic not found');
    });

    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.topics.publish');

    const response = await route.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', topic: 'missing' },
        body: { messages: [{ data: btoa('x') }] },
      }),
      makeContext()
    );

    expect(response.status).toBe(404);
  });

  // ── Pull ──

  test('handlePull returns 200 with receivedMessages', async () => {
    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.subscriptions.pull');

    const response = await route.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', subscription: 's' },
        body: { maxMessages: 10 },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.pull).toHaveBeenCalled();
  });

  test('handlePull returns 400 on FAILED_PRECONDITION', async () => {
    (mockService.pull as ReturnType<typeof mock>).mockImplementation(() => {
      throw new PubSubError('FAILED_PRECONDITION', 'Subscription is detached');
    });

    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.subscriptions.pull');

    const response = await route.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', subscription: 's' },
        body: { maxMessages: 10 },
      }),
      makeContext()
    );

    expect(response.status).toBe(400);
  });

  // ── Acknowledge ──

  test('handleAcknowledge returns 200', async () => {
    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.subscriptions.acknowledge');

    const response = await route.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', subscription: 's' },
        body: { ackIds: ['ack-1'] },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.acknowledge).toHaveBeenCalled();
  });

  // ── ModifyAckDeadline ──

  test('handleModifyAckDeadline returns 200', async () => {
    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.subscriptions.modifyAckDeadline');

    const response = await route.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', subscription: 's' },
        body: { ackIds: ['ack-1'], ackDeadlineSeconds: 120 },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.modifyAckDeadline).toHaveBeenCalled();
  });

  // ── ModifyPushConfig ──

  test('handleModifyPushConfig returns 200', async () => {
    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.subscriptions.modifyPushConfig');

    const response = await route.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', subscription: 's' },
        body: { pushConfig: { pushEndpoint: 'https://example.com/push' } },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.modifyPushConfig).toHaveBeenCalled();
  });

  // ── Seek ──

  test('handleSeek returns 200', async () => {
    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.subscriptions.seek');

    const response = await route.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', subscription: 's' },
        body: { time: new Date().toISOString() },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.seek).toHaveBeenCalled();
  });

  // ── Detach ──

  test('handleDetach returns 200', async () => {
    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.subscriptions.detach');

    const response = await route.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', subscription: 's' },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.detachSubscription).toHaveBeenCalled();
  });

  // ── Topic subscriptions listing ──

  test('handleListTopicSubscriptions returns 200 with subscription names', async () => {
    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.topics.subscriptions.list');

    const response = await route.handler(
      makeRequest({
        params: { project: 'p', topic: 't' },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.listTopicSubscriptions).toHaveBeenCalled();
  });

  // ── Error mappings ──

  test('ALREADY_EXISTS maps to 409', async () => {
    (mockService.createSubscription as ReturnType<typeof mock>).mockImplementation(() => {
      throw new PubSubError('ALREADY_EXISTS', 'Subscription already exists');
    });

    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.subscriptions.create');

    const response = await route.handler(
      makeRequest({
        method: 'PUT',
        params: { project: 'p', subscription: 's' },
        body: { topic: 'projects/p/topics/t' },
      }),
      makeContext()
    );

    expect(response.status).toBe(409);
  });

  test('INVALID_ARGUMENT maps to 400', async () => {
    (mockService.createSubscription as ReturnType<typeof mock>).mockImplementation(() => {
      throw new PubSubError('INVALID_ARGUMENT', 'Bad request');
    });

    const routes = handlers.getRoutes();
    const route = findRoute(routes, 'pubsub.subscriptions.create');

    const response = await route.handler(
      makeRequest({
        method: 'PUT',
        params: { project: 'p', subscription: 's' },
        body: {},
      }),
      makeContext()
    );

    expect(response.status).toBe(400);
  });
});
