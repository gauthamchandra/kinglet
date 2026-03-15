/**
 * Unit tests for TopicRepository
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { TopicRepository } from './topic-repository.ts';

describe('TopicRepository', () => {
  let storage: StorageManager;
  let repo: TopicRepository;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new TopicRepository(storage);
    await repo.initialize();
  });

  test('createTopic persists and returns a TopicRecord', async () => {
    const record = await repo.createTopic({
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

    expect(record.name).toBe('projects/p/topics/t');
    expect(record.state).toBe('ACTIVE');
    expect(record.id).toBeTypeOf('string');
    expect(record.createdAt).toBeInstanceOf(Date);
  });

  test('getTopicByName returns the topic when it exists', async () => {
    await repo.createTopic({
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

    const found = await repo.getTopicByName('projects/p/topics/t');

    expect(found).not.toBeNull();
    expect(found?.name).toBe('projects/p/topics/t');
  });

  test('getTopicByName returns null when topic does not exist', async () => {
    const found = await repo.getTopicByName('projects/p/topics/missing');

    expect(found).toBeNull();
  });

  test('listTopics filters by project and respects pageSize', async () => {
    await repo.createTopic({
      name: 'projects/p1/topics/a',
      labels: null,
      messageRetentionDuration: null,
      kmsKeyName: null,
      schemaSettings: null,
      satisfiesPzs: null,
      messageStoragePolicy: null,
      ingestionDataSourceSettings: null,
      state: 'ACTIVE',
    });

    await repo.createTopic({
      name: 'projects/p1/topics/b',
      labels: null,
      messageRetentionDuration: null,
      kmsKeyName: null,
      schemaSettings: null,
      satisfiesPzs: null,
      messageStoragePolicy: null,
      ingestionDataSourceSettings: null,
      state: 'ACTIVE',
    });

    await repo.createTopic({
      name: 'projects/p2/topics/c',
      labels: null,
      messageRetentionDuration: null,
      kmsKeyName: null,
      schemaSettings: null,
      satisfiesPzs: null,
      messageStoragePolicy: null,
      ingestionDataSourceSettings: null,
      state: 'ACTIVE',
    });

    // List only project p1
    const result = await repo.listTopics('p1');

    expect(result.topics.length).toBe(2);

    // List with pageSize
    const paged = await repo.listTopics('p1', 1);

    expect(paged.topics.length).toBe(1);
    expect(paged.nextPageToken).toBeDefined();

    // Fetch next page
    const page2 = await repo.listTopics('p1', 1, paged.nextPageToken);

    expect(page2.topics.length).toBe(1);
    expect(page2.topics[0]?.name).not.toBe(paged.topics[0]?.name);
  });

  test('updateTopic updates fields and returns updated record', async () => {
    await repo.createTopic({
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

    const updated = await repo.updateTopic('projects/p/topics/t', {
      labels: JSON.stringify({ env: 'prod' }),
    });

    expect(updated).not.toBeNull();
    expect(updated?.labels).toBe(JSON.stringify({ env: 'prod' }));
  });

  test('updateTopic returns null for non-existent topic', async () => {
    const result = await repo.updateTopic('projects/p/topics/missing', {
      labels: JSON.stringify({ x: 'y' }),
    });

    expect(result).toBeNull();
  });

  test('deleteTopic removes the topic', async () => {
    await repo.createTopic({
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

    const deleted = await repo.deleteTopic('projects/p/topics/t');

    expect(deleted).toBe(true);

    const found = await repo.getTopicByName('projects/p/topics/t');

    expect(found).toBeNull();
  });

  test('deleteTopic returns false for non-existent topic', async () => {
    const result = await repo.deleteTopic('projects/p/topics/missing');

    expect(result).toBe(false);
  });
});
