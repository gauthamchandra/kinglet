/**
 * Unit tests for SnapshotRepository
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { SnapshotRepository } from './snapshot-repository.ts';
import { SubscriptionRepository } from './subscription-repository.ts';
import { TopicRepository } from './topic-repository.ts';

describe('SnapshotRepository', () => {
  let storage: StorageManager;
  let topicRepo: TopicRepository;
  let subRepo: SubscriptionRepository;
  let repo: SnapshotRepository;

  const baseTopic = {
    labels: null,
    messageRetentionDuration: null,
    kmsKeyName: null,
    schemaSettings: null,
    satisfiesPzs: null,
    messageStoragePolicy: null,
    ingestionDataSourceSettings: null,
    state: 'ACTIVE',
  } as const;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    topicRepo = new TopicRepository(storage);
    await topicRepo.initialize();

    subRepo = new SubscriptionRepository(storage);
    await subRepo.initialize();

    repo = new SnapshotRepository(storage);
    await repo.initialize();

    await topicRepo.createTopic({
      name: 'projects/p/topics/t',
      ...baseTopic,
    });

    await topicRepo.createTopic({
      name: 'projects/p/topics/t2',
      ...baseTopic,
    });
  });

  test('createSnapshot persists and returns a SnapshotRecord', async () => {
    const record = await repo.createSnapshot({
      name: 'projects/p/snapshots/snap1',
      topic: 'projects/p/topics/t',
      expireTime: new Date(Date.now() + 604800_000).toISOString(),
      labels: null,
    });

    expect(record.name).toBe('projects/p/snapshots/snap1');
    expect(record.topic).toBe('projects/p/topics/t');
    expect(record.id).toBeTypeOf('string');
    expect(record.createdAt).toBeInstanceOf(Date);
  });

  test('getSnapshotByName returns snapshot when it exists', async () => {
    await repo.createSnapshot({
      name: 'projects/p/snapshots/snap1',
      topic: 'projects/p/topics/t',
      expireTime: null,
      labels: null,
    });

    const found = await repo.getSnapshotByName('projects/p/snapshots/snap1');

    expect(found).not.toBeNull();
    expect(found?.name).toBe('projects/p/snapshots/snap1');
  });

  test('getSnapshotByName returns null when snapshot does not exist', async () => {
    const found = await repo.getSnapshotByName('projects/p/snapshots/missing');

    expect(found).toBeNull();
  });

  test('listSnapshots filters by project and supports pagination', async () => {
    await repo.createSnapshot({
      name: 'projects/p1/snapshots/a',
      topic: 'projects/p/topics/t',
      expireTime: null,
      labels: null,
    });

    await repo.createSnapshot({
      name: 'projects/p1/snapshots/b',
      topic: 'projects/p/topics/t',
      expireTime: null,
      labels: null,
    });

    await repo.createSnapshot({
      name: 'projects/p2/snapshots/c',
      topic: 'projects/p/topics/t',
      expireTime: null,
      labels: null,
    });

    const result = await repo.listSnapshots('p1');

    expect(result.snapshots.length).toBe(2);

    const paged = await repo.listSnapshots('p1', 1);

    expect(paged.snapshots.length).toBe(1);
    expect(paged.nextPageToken).toBeDefined();

    const page2 = await repo.listSnapshots('p1', 1, paged.nextPageToken);

    expect(page2.snapshots.length).toBe(1);
    expect(page2.snapshots[0]?.name).not.toBe(paged.snapshots[0]?.name);
  });

  test('listSnapshotsByTopic returns snapshots for a specific topic', async () => {
    await repo.createSnapshot({
      name: 'projects/p/snapshots/snap-t1',
      topic: 'projects/p/topics/t',
      expireTime: null,
      labels: null,
    });

    await repo.createSnapshot({
      name: 'projects/p/snapshots/snap-t2',
      topic: 'projects/p/topics/t2',
      expireTime: null,
      labels: null,
    });

    const result = await repo.listSnapshotsByTopic('projects/p/topics/t');

    expect(result.length).toBe(1);
    expect(result[0]?.name).toBe('projects/p/snapshots/snap-t1');
  });

  test('updateSnapshot updates fields and returns updated record', async () => {
    await repo.createSnapshot({
      name: 'projects/p/snapshots/snap1',
      topic: 'projects/p/topics/t',
      expireTime: null,
      labels: null,
    });

    const updated = await repo.updateSnapshot('projects/p/snapshots/snap1', {
      labels: JSON.stringify({ env: 'test' }),
    });

    expect(updated).not.toBeNull();
    expect(updated?.labels).toBe(JSON.stringify({ env: 'test' }));
  });

  test('updateSnapshot returns null for non-existent snapshot', async () => {
    const result = await repo.updateSnapshot('projects/p/snapshots/missing', {
      labels: JSON.stringify({ env: 'test' }),
    });

    expect(result).toBeNull();
  });

  test('deleteSnapshot removes the snapshot', async () => {
    await repo.createSnapshot({
      name: 'projects/p/snapshots/snap1',
      topic: 'projects/p/topics/t',
      expireTime: null,
      labels: null,
    });

    const deleted = await repo.deleteSnapshot('projects/p/snapshots/snap1');

    expect(deleted).toBe(true);

    const found = await repo.getSnapshotByName('projects/p/snapshots/snap1');

    expect(found).toBeNull();
  });

  test('deleteSnapshot returns false for non-existent snapshot', async () => {
    const result = await repo.deleteSnapshot('projects/p/snapshots/missing');

    expect(result).toBe(false);
  });
});
