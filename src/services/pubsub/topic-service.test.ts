/**
 * Unit tests for TopicService
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { MessageRepository } from './message-repository.ts';
import { TopicRepository } from './topic-repository.ts';
import { TopicService } from './topic-service.ts';
import { PubSubError } from './types.ts';

describe('TopicService', () => {
  let storage: StorageManager;
  let repo: TopicRepository;
  let messageRepo: MessageRepository;
  let service: TopicService;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new TopicRepository(storage);
    await repo.initialize();
    messageRepo = new MessageRepository(storage);
    await messageRepo.initialize();
    service = new TopicService(repo, messageRepo);
  });

  // ── createTopic ──

  test('createTopic creates and returns a TopicResponse', async () => {
    const topic = await service.createTopic('my-project', 'my-topic', {
      labels: { env: 'test' },
    });

    expect(topic.name).toBe('projects/my-project/topics/my-topic');
    expect(topic.labels).toEqual({ env: 'test' });
    expect(topic.state).toBe('ACTIVE');
  });

  test('createTopic with empty body uses defaults', async () => {
    const topic = await service.createTopic('p', 't', {});

    expect(topic.name).toBe('projects/p/topics/t');
    expect(topic.state).toBe('ACTIVE');
  });

  test('createTopic throws ALREADY_EXISTS for duplicate', async () => {
    await service.createTopic('p', 't', {});

    const promise = service.createTopic('p', 't', {});

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
  });

  // ── getTopic ──

  test('getTopic returns a TopicResponse', async () => {
    await service.createTopic('p', 't', {});

    const topic = await service.getTopic('projects/p/topics/t');

    expect(topic.name).toBe('projects/p/topics/t');
  });

  test('getTopic throws NOT_FOUND for missing topic', async () => {
    const promise = service.getTopic('projects/p/topics/missing');

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── listTopics ──

  test('listTopics returns paginated results', async () => {
    await service.createTopic('p', 'a', {});
    await service.createTopic('p', 'b', {});

    const result = await service.listTopics('p', 1);

    expect(result.topics.length).toBe(1);
    expect(result.nextPageToken).toBeDefined();

    const result2 = await service.listTopics('p', 1, result.nextPageToken);

    expect(result2.topics.length).toBe(1);
  });

  test('listTopics returns empty for project with no topics', async () => {
    const result = await service.listTopics('empty-project');

    expect(result.topics).toEqual([]);
  });

  // ── updateTopic ──

  test('updateTopic updates and returns the topic', async () => {
    await service.createTopic('p', 't', { labels: { env: 'dev' } });

    const updated = await service.updateTopic('projects/p/topics/t', {
      topic: { labels: { env: 'prod' } },
      updateMask: 'labels',
    });

    expect(updated.labels).toEqual({ env: 'prod' });
  });

  test('updateTopic throws NOT_FOUND for missing topic', async () => {
    const promise = service.updateTopic('projects/p/topics/missing', {
      topic: { labels: { x: 'y' } },
      updateMask: 'labels',
    });

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── deleteTopic ──

  test('deleteTopic deletes the topic', async () => {
    await service.createTopic('p', 't', {});
    await service.deleteTopic('projects/p/topics/t');

    const promise = service.getTopic('projects/p/topics/t');

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('deleteTopic throws NOT_FOUND for missing topic', async () => {
    const promise = service.deleteTopic('projects/p/topics/missing');

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });
});
