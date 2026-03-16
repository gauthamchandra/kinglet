/**
 * Unit tests for SnapshotService
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { MessageRepository } from './message-repository.ts';
import { SnapshotRepository } from './snapshot-repository.ts';
import { SnapshotService } from './snapshot-service.ts';
import { SubscriptionRepository } from './subscription-repository.ts';
import { TopicRepository } from './topic-repository.ts';
import { PubSubError } from './types.ts';

describe('SnapshotService', () => {
  let storage: StorageManager;
  let topicRepo: TopicRepository;
  let subRepo: SubscriptionRepository;
  let messageRepo: MessageRepository;
  let snapshotRepo: SnapshotRepository;
  let service: SnapshotService;

  const baseSub = {
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

    subRepo = new SubscriptionRepository(storage);
    await subRepo.initialize();

    messageRepo = new MessageRepository(storage);
    await messageRepo.initialize();

    snapshotRepo = new SnapshotRepository(storage);
    await snapshotRepo.initialize();

    service = new SnapshotService(snapshotRepo, subRepo, topicRepo);

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
      ...baseSub,
    });
  });

  // ── createSnapshot ──

  test('createSnapshot creates snapshot with topic from subscription', async () => {
    const result = await service.createSnapshot('p', 'snap1', {
      subscription: 'projects/p/subscriptions/s1',
    });

    expect(result.name).toBe('projects/p/snapshots/snap1');
    expect(result.topic).toBe('projects/p/topics/t');
    expect(result.expireTime).toBeTypeOf('string');
  });

  test('createSnapshot with labels stores labels', async () => {
    const result = await service.createSnapshot('p', 'snap-labels', {
      subscription: 'projects/p/subscriptions/s1',
      labels: { env: 'test' },
    });

    expect(result.labels).toEqual({ env: 'test' });
  });

  test('createSnapshot throws ALREADY_EXISTS for duplicate', async () => {
    await service.createSnapshot('p', 'snap-dup', {
      subscription: 'projects/p/subscriptions/s1',
    });

    const promise = service.createSnapshot('p', 'snap-dup', {
      subscription: 'projects/p/subscriptions/s1',
    });

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
  });

  test('createSnapshot throws NOT_FOUND for missing subscription', async () => {
    const promise = service.createSnapshot('p', 'snap-missing', {
      subscription: 'projects/p/subscriptions/missing',
    });

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── getSnapshot ──

  test('getSnapshot returns snapshot', async () => {
    await service.createSnapshot('p', 'snap-get', {
      subscription: 'projects/p/subscriptions/s1',
    });

    const result = await service.getSnapshot('projects/p/snapshots/snap-get');

    expect(result.name).toBe('projects/p/snapshots/snap-get');
    expect(result.topic).toBe('projects/p/topics/t');
  });

  test('getSnapshot throws NOT_FOUND for missing snapshot', async () => {
    const promise = service.getSnapshot('projects/p/snapshots/missing');

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── listSnapshots ──

  test('listSnapshots returns paginated results', async () => {
    await service.createSnapshot('p', 'snap-a', {
      subscription: 'projects/p/subscriptions/s1',
    });

    await service.createSnapshot('p', 'snap-b', {
      subscription: 'projects/p/subscriptions/s1',
    });

    const result = await service.listSnapshots('p');

    expect(result.snapshots).toHaveLength(2);
  });

  // ── updateSnapshot ──

  test('updateSnapshot updates expireTime and labels', async () => {
    await service.createSnapshot('p', 'snap-upd', {
      subscription: 'projects/p/subscriptions/s1',
    });

    const newExpire = new Date(Date.now() + 86400_000).toISOString();

    const result = await service.updateSnapshot('projects/p/snapshots/snap-upd', {
      snapshot: { expireTime: newExpire, labels: { updated: 'true' } },
      updateMask: 'expireTime,labels',
    });

    expect(result.expireTime).toBe(newExpire);
    expect(result.labels).toEqual({ updated: 'true' });
  });

  test('updateSnapshot throws NOT_FOUND for missing snapshot', async () => {
    const promise = service.updateSnapshot('projects/p/snapshots/missing', {
      snapshot: {},
      updateMask: 'labels',
    });

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── deleteSnapshot ──

  test('deleteSnapshot removes snapshot', async () => {
    await service.createSnapshot('p', 'snap-del', {
      subscription: 'projects/p/subscriptions/s1',
    });

    await service.deleteSnapshot('projects/p/snapshots/snap-del');

    const promise = service.getSnapshot('projects/p/snapshots/snap-del');

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('deleteSnapshot throws NOT_FOUND for missing snapshot', async () => {
    const promise = service.deleteSnapshot('projects/p/snapshots/missing');

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── listTopicSnapshots ──

  test('listTopicSnapshots returns snapshot names for a topic', async () => {
    await service.createSnapshot('p', 'snap-ts1', {
      subscription: 'projects/p/subscriptions/s1',
    });

    await service.createSnapshot('p', 'snap-ts2', {
      subscription: 'projects/p/subscriptions/s1',
    });

    const result = await service.listTopicSnapshots('projects/p/topics/t');

    expect(result.snapshots).toHaveLength(2);
    expect(result.snapshots.sort()).toEqual([
      'projects/p/snapshots/snap-ts1',
      'projects/p/snapshots/snap-ts2',
    ]);
  });

  test('listTopicSnapshots throws NOT_FOUND for missing topic', async () => {
    const promise = service.listTopicSnapshots('projects/p/topics/missing');

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });
});
