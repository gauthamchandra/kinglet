/**
 * Unit tests for SnapshotHandlers
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { RouteContext, RouteRequest } from '@/core/gateway/request-router.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { MessageRepository } from './message-repository.ts';
import { SnapshotHandlers } from './snapshot-handlers.ts';
import { SnapshotRepository } from './snapshot-repository.ts';
import { SnapshotService } from './snapshot-service.ts';
import { SubscriptionRepository } from './subscription-repository.ts';
import { TopicRepository } from './topic-repository.ts';

describe('SnapshotHandlers', () => {
  let handlers: SnapshotHandlers;
  let subRepo: SubscriptionRepository;
  let topicRepo: TopicRepository;
  let snapshotService: SnapshotService;

  const ctx: RouteContext = {
    routeId: 'test',
    startTime: Date.now(),
    metadata: {},
    logger: new Logger('test', 'error'),
  };

  beforeEach(async () => {
    const storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    topicRepo = new TopicRepository(storage);
    await topicRepo.initialize();

    subRepo = new SubscriptionRepository(storage);
    await subRepo.initialize();

    const messageRepo = new MessageRepository(storage);
    await messageRepo.initialize();

    const snapshotRepo = new SnapshotRepository(storage);
    await snapshotRepo.initialize();

    snapshotService = new SnapshotService(snapshotRepo, subRepo, topicRepo);
    handlers = new SnapshotHandlers(snapshotService, new Logger('test', 'error'));

    await topicRepo.createTopic({
      name: 'projects/p/topics/t',
      labels: null,
      messageRetentionDuration: null,
      kmsKeyName: null,
      schemaSettings: null,
      satisfiesPzs: null,
      messageStoragePolicy: null,
      ingestionDataSourceSettings: null,
      state: 'ACTIVE',
    });

    await subRepo.createSubscription({
      name: 'projects/p/subscriptions/s1',
      topic: 'projects/p/topics/t',
      pushConfig: null,
      bigqueryConfig: null,
      cloudStorageConfig: null,
      ackDeadlineSeconds: 10,
      retainAckedMessages: 0,
      messageRetentionDuration: '604800s',
      labels: null,
      enableMessageOrdering: 0,
      expirationPolicy: null,
      filter: null,
      deadLetterPolicy: null,
      retryPolicy: null,
      detached: 0,
      enableExactlyOnceDelivery: 0,
      topicMessageRetentionDuration: null,
      state: 'ACTIVE',
    });
  });

  function findRoute(id: string) {
    const route = handlers.getRoutes().find(r => r.id === id);

    if (!route) throw new Error(`Route ${id} not found`);

    return route;
  }

  function makeReq(overrides: Partial<RouteRequest>): RouteRequest {
    return {
      method: 'GET',
      path: '/',
      params: {},
      query: {},
      headers: {},
      body: undefined,
      ...overrides,
    } as RouteRequest;
  }

  test('getRoutes returns all snapshot routes', () => {
    const routes = handlers.getRoutes();
    const ids = routes.map(r => r.id);

    expect(ids).toContain('pubsub.snapshots.create');
    expect(ids).toContain('pubsub.snapshots.get');
    expect(ids).toContain('pubsub.snapshots.list');
    expect(ids).toContain('pubsub.snapshots.patch');
    expect(ids).toContain('pubsub.snapshots.delete');
  });

  test('create snapshot returns 200 with snapshot data', async () => {
    const route = findRoute('pubsub.snapshots.create');

    const req = makeReq({
      method: 'PUT',
      params: { project: 'p', snapshot: 'snap1' },
      body: { subscription: 'projects/p/subscriptions/s1' },
    });

    const res = await route.handler(req, ctx);

    expect(res.status).toBe(200);
    expect((res.body as { name: string }).name).toBe('projects/p/snapshots/snap1');
  });

  test('get snapshot returns 404 for missing', async () => {
    const route = findRoute('pubsub.snapshots.get');

    const req = makeReq({
      params: { project: 'p', snapshot: 'missing' },
    });

    const res = await route.handler(req, ctx);

    expect(res.status).toBe(404);
  });

  test('list snapshots returns 200', async () => {
    // Create a snapshot first
    await snapshotService.createSnapshot('p', 'snap-list', {
      subscription: 'projects/p/subscriptions/s1',
    });

    const route = findRoute('pubsub.snapshots.list');

    const req = makeReq({
      params: { project: 'p' },
      query: {},
    });

    const res = await route.handler(req, ctx);

    expect(res.status).toBe(200);
    expect((res.body as { snapshots: unknown[] }).snapshots).toHaveLength(1);
  });

  test('delete snapshot returns 200', async () => {
    await snapshotService.createSnapshot('p', 'snap-del', {
      subscription: 'projects/p/subscriptions/s1',
    });

    const route = findRoute('pubsub.snapshots.delete');

    const req = makeReq({
      method: 'DELETE',
      params: { project: 'p', snapshot: 'snap-del' },
    });

    const res = await route.handler(req, ctx);

    expect(res.status).toBe(200);
  });

  test('delete non-existent snapshot returns 404', async () => {
    const route = findRoute('pubsub.snapshots.delete');

    const req = makeReq({
      method: 'DELETE',
      params: { project: 'p', snapshot: 'missing' },
    });

    const res = await route.handler(req, ctx);

    expect(res.status).toBe(404);
  });
});
