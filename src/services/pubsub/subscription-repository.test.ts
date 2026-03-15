/**
 * Unit tests for SubscriptionRepository
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { SubscriptionRepository } from './subscription-repository.ts';
import { TopicRepository } from './topic-repository.ts';

describe('SubscriptionRepository', () => {
  let storage: StorageManager;
  let topicRepo: TopicRepository;
  let repo: SubscriptionRepository;

  const baseSub = {
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
  } as const;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    topicRepo = new TopicRepository(storage);
    await topicRepo.initialize();
    repo = new SubscriptionRepository(storage);
    await repo.initialize();

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

    await topicRepo.createTopic({
      name: 'projects/p/topics/t2',
      labels: null,
      messageRetentionDuration: null,
      kmsKeyName: null,
      schemaSettings: null,
      satisfiesPzs: null,
      messageStoragePolicy: null,
      ingestionDataSourceSettings: null,
      state: 'ACTIVE',
    });
  });

  test('createSubscription persists and returns a SubscriptionRecord', async () => {
    const record = await repo.createSubscription({
      name: 'projects/p/subscriptions/s1',
      ...baseSub,
    });

    expect(record.name).toBe('projects/p/subscriptions/s1');
    expect(record.topic).toBe('projects/p/topics/t');
    expect(record.ackDeadlineSeconds).toBe(10);
    expect(record.state).toBe('ACTIVE');
    expect(record.id).toBeTypeOf('string');
    expect(record.createdAt).toBeInstanceOf(Date);
  });

  test('getSubscriptionByName returns the subscription when it exists', async () => {
    await repo.createSubscription({
      name: 'projects/p/subscriptions/s1',
      ...baseSub,
    });

    const found = await repo.getSubscriptionByName('projects/p/subscriptions/s1');

    expect(found).not.toBeNull();
    expect(found?.name).toBe('projects/p/subscriptions/s1');
  });

  test('getSubscriptionByName returns null when subscription does not exist', async () => {
    const found = await repo.getSubscriptionByName('projects/p/subscriptions/missing');

    expect(found).toBeNull();
  });

  test('listSubscriptions filters by project and respects pageSize', async () => {
    await repo.createSubscription({
      name: 'projects/p1/subscriptions/a',
      ...baseSub,
    });

    await repo.createSubscription({
      name: 'projects/p1/subscriptions/b',
      ...baseSub,
    });

    await repo.createSubscription({
      name: 'projects/p2/subscriptions/c',
      ...baseSub,
    });

    const result = await repo.listSubscriptions('p1');

    expect(result.subscriptions.length).toBe(2);

    const paged = await repo.listSubscriptions('p1', 1);

    expect(paged.subscriptions.length).toBe(1);
    expect(paged.nextPageToken).toBeDefined();

    const page2 = await repo.listSubscriptions('p1', 1, paged.nextPageToken);

    expect(page2.subscriptions.length).toBe(1);
    expect(page2.subscriptions[0]?.name).not.toBe(paged.subscriptions[0]?.name);
  });

  test('listSubscriptionsByTopic returns only subscriptions for the given topic', async () => {
    await repo.createSubscription({
      name: 'projects/p/subscriptions/s1',
      ...baseSub,
      topic: 'projects/p/topics/t',
    });

    await repo.createSubscription({
      name: 'projects/p/subscriptions/s2',
      ...baseSub,
      topic: 'projects/p/topics/t',
    });

    await repo.createSubscription({
      name: 'projects/p/subscriptions/s3',
      ...baseSub,
      topic: 'projects/p/topics/t2',
    });

    const result = await repo.listSubscriptionsByTopic('projects/p/topics/t');

    expect(result.length).toBe(2);

    const names = result.map(s => s.name).sort();

    expect(names).toEqual(['projects/p/subscriptions/s1', 'projects/p/subscriptions/s2']);
  });

  test('findActiveSubscriptionsForTopic excludes detached subscriptions', async () => {
    await repo.createSubscription({
      name: 'projects/p/subscriptions/active',
      ...baseSub,
    });

    await repo.createSubscription({
      name: 'projects/p/subscriptions/detached',
      ...baseSub,
      detached: 1,
    });

    const active = await repo.findActiveSubscriptionsForTopic('projects/p/topics/t');

    expect(active.length).toBe(1);
    expect(active[0]?.name).toBe('projects/p/subscriptions/active');
  });

  test('updateSubscription updates fields and returns updated record', async () => {
    await repo.createSubscription({
      name: 'projects/p/subscriptions/s1',
      ...baseSub,
    });

    const updated = await repo.updateSubscription('projects/p/subscriptions/s1', {
      ackDeadlineSeconds: 30,
      labels: JSON.stringify({ env: 'prod' }),
    });

    expect(updated).not.toBeNull();
    expect(updated?.ackDeadlineSeconds).toBe(30);
    expect(updated?.labels).toBe(JSON.stringify({ env: 'prod' }));
  });

  test('updateSubscription returns null for non-existent subscription', async () => {
    const result = await repo.updateSubscription('projects/p/subscriptions/missing', {
      ackDeadlineSeconds: 30,
    });

    expect(result).toBeNull();
  });

  test('deleteSubscription removes the subscription', async () => {
    await repo.createSubscription({
      name: 'projects/p/subscriptions/s1',
      ...baseSub,
    });

    const deleted = await repo.deleteSubscription('projects/p/subscriptions/s1');

    expect(deleted).toBe(true);

    const found = await repo.getSubscriptionByName('projects/p/subscriptions/s1');

    expect(found).toBeNull();
  });

  test('deleteSubscription returns false for non-existent subscription', async () => {
    const result = await repo.deleteSubscription('projects/p/subscriptions/missing');

    expect(result).toBe(false);
  });

  // ── findPushSubscriptions ──

  describe('findPushSubscriptions', () => {
    test('returns non-detached subscriptions with a pushEndpoint configured', async () => {
      await repo.createSubscription({
        name: 'projects/p/subscriptions/push-sub',
        ...baseSub,
        pushConfig: JSON.stringify({ pushEndpoint: 'https://example.com/push' }),
      });

      await repo.createSubscription({
        name: 'projects/p/subscriptions/pull-sub',
        ...baseSub,
        pushConfig: null,
      });

      const pushSubs = await repo.findPushSubscriptions();

      expect(pushSubs).toHaveLength(1);
      expect(pushSubs[0]?.name).toBe('projects/p/subscriptions/push-sub');
    });

    test('excludes detached subscriptions', async () => {
      await repo.createSubscription({
        name: 'projects/p/subscriptions/detached-push',
        ...baseSub,
        pushConfig: JSON.stringify({ pushEndpoint: 'https://example.com/push' }),
        detached: 1,
      });

      const pushSubs = await repo.findPushSubscriptions();

      expect(pushSubs).toHaveLength(0);
    });

    test('excludes subscriptions with empty pushConfig (no pushEndpoint)', async () => {
      await repo.createSubscription({
        name: 'projects/p/subscriptions/empty-push',
        ...baseSub,
        pushConfig: JSON.stringify({}),
      });

      const pushSubs = await repo.findPushSubscriptions();

      expect(pushSubs).toHaveLength(0);
    });
  });
});
