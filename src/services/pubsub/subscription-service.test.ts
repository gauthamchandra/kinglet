/**
 * Unit tests for SubscriptionService
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { MessageRepository } from './message-repository.ts';
import { SubscriptionRepository } from './subscription-repository.ts';
import { SubscriptionService } from './subscription-service.ts';
import { TopicRepository } from './topic-repository.ts';
import { TopicService } from './topic-service.ts';
import { PubSubError } from './types.ts';

describe('SubscriptionService', () => {
  let storage: StorageManager;
  let topicRepo: TopicRepository;
  let topicService: TopicService;
  let subRepo: SubscriptionRepository;
  let messageRepo: MessageRepository;
  let service: SubscriptionService;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    topicRepo = new TopicRepository(storage);
    await topicRepo.initialize();

    subRepo = new SubscriptionRepository(storage);
    await subRepo.initialize();

    messageRepo = new MessageRepository(storage);
    await messageRepo.initialize();

    topicService = new TopicService(topicRepo, messageRepo);
    service = new SubscriptionService(subRepo, topicRepo, messageRepo);

    // Create a topic for subscriptions to attach to
    await topicService.createTopic('p', 't', {});
  });

  // ── createSubscription ──

  test('createSubscription creates and returns a SubscriptionResponse', async () => {
    const sub = await service.createSubscription('p', 'my-sub', {
      topic: 'projects/p/topics/t',
      ackDeadlineSeconds: 30,
    });

    expect(sub.name).toBe('projects/p/subscriptions/my-sub');
    expect(sub.topic).toBe('projects/p/topics/t');
    expect(sub.ackDeadlineSeconds).toBe(30);
    expect(sub.state).toBe('ACTIVE');
  });

  test('createSubscription with defaults', async () => {
    const sub = await service.createSubscription('p', 's', {
      topic: 'projects/p/topics/t',
    });

    expect(sub.ackDeadlineSeconds).toBe(10);
    expect(sub.messageRetentionDuration).toBe('604800s');
  });

  test('createSubscription throws NOT_FOUND when topic does not exist', async () => {
    const promise = service.createSubscription('p', 's', {
      topic: 'projects/p/topics/nonexistent',
    });

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('createSubscription throws ALREADY_EXISTS for duplicate', async () => {
    await service.createSubscription('p', 's', { topic: 'projects/p/topics/t' });

    const promise = service.createSubscription('p', 's', { topic: 'projects/p/topics/t' });

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
  });

  test('createSubscription throws INVALID_ARGUMENT for missing topic field', async () => {
    const promise = service.createSubscription('p', 's', {});

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  // ── getSubscription ──

  test('getSubscription returns a SubscriptionResponse', async () => {
    await service.createSubscription('p', 's', { topic: 'projects/p/topics/t' });

    const sub = await service.getSubscription('projects/p/subscriptions/s');

    expect(sub.name).toBe('projects/p/subscriptions/s');
    expect(sub.topic).toBe('projects/p/topics/t');
  });

  test('getSubscription throws NOT_FOUND for missing subscription', async () => {
    const promise = service.getSubscription('projects/p/subscriptions/missing');

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── listSubscriptions ──

  test('listSubscriptions returns paginated results', async () => {
    await service.createSubscription('p', 'a', { topic: 'projects/p/topics/t' });
    await service.createSubscription('p', 'b', { topic: 'projects/p/topics/t' });

    const result = await service.listSubscriptions('p', 1);

    expect(result.subscriptions.length).toBe(1);
    expect(result.nextPageToken).toBeDefined();

    const result2 = await service.listSubscriptions('p', 1, result.nextPageToken);

    expect(result2.subscriptions.length).toBe(1);
  });

  test('listSubscriptions returns empty for project with no subscriptions', async () => {
    const result = await service.listSubscriptions('empty-project');

    expect(result.subscriptions).toEqual([]);
  });

  // ── updateSubscription ──

  test('updateSubscription updates and returns the subscription', async () => {
    await service.createSubscription('p', 's', {
      topic: 'projects/p/topics/t',
      ackDeadlineSeconds: 10,
    });

    const updated = await service.updateSubscription('projects/p/subscriptions/s', {
      subscription: { ackDeadlineSeconds: 60 },
      updateMask: 'ackDeadlineSeconds',
    });

    expect(updated.ackDeadlineSeconds).toBe(60);
  });

  test('updateSubscription with labels', async () => {
    await service.createSubscription('p', 's', { topic: 'projects/p/topics/t' });

    const updated = await service.updateSubscription('projects/p/subscriptions/s', {
      subscription: { labels: { env: 'prod' } },
      updateMask: 'labels',
    });

    expect(updated.labels).toEqual({ env: 'prod' });
  });

  test('updateSubscription throws NOT_FOUND for missing subscription', async () => {
    const promise = service.updateSubscription('projects/p/subscriptions/missing', {
      subscription: { ackDeadlineSeconds: 30 },
      updateMask: 'ackDeadlineSeconds',
    });

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── deleteSubscription ──

  test('deleteSubscription deletes the subscription', async () => {
    await service.createSubscription('p', 's', { topic: 'projects/p/topics/t' });
    await service.deleteSubscription('projects/p/subscriptions/s');

    const promise = service.getSubscription('projects/p/subscriptions/s');

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('deleteSubscription throws NOT_FOUND for missing subscription', async () => {
    const promise = service.deleteSubscription('projects/p/subscriptions/missing');

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── publish ──

  test('publish returns messageIds', async () => {
    await service.createSubscription('p', 's', { topic: 'projects/p/topics/t' });

    const result = await service.publish('projects/p/topics/t', {
      messages: [{ data: btoa('hello') }],
    });

    expect(result.messageIds).toHaveLength(1);
    expect(result.messageIds[0]).toBeTypeOf('string');
  });

  test('publish fans out to multiple subscriptions', async () => {
    await service.createSubscription('p', 's1', { topic: 'projects/p/topics/t' });
    await service.createSubscription('p', 's2', { topic: 'projects/p/topics/t' });

    await service.publish('projects/p/topics/t', {
      messages: [{ data: btoa('fanout') }],
    });

    const pulled1 = await service.pull('projects/p/subscriptions/s1', { maxMessages: 10 });
    const pulled2 = await service.pull('projects/p/subscriptions/s2', { maxMessages: 10 });

    expect(pulled1.receivedMessages).toHaveLength(1);
    expect(pulled2.receivedMessages).toHaveLength(1);
  });

  test('publish throws NOT_FOUND for missing topic', async () => {
    const promise = service.publish('projects/p/topics/nonexistent', {
      messages: [{ data: btoa('x') }],
    });

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('publish throws INVALID_ARGUMENT for empty messages array', async () => {
    const promise = service.publish('projects/p/topics/t', { messages: [] });

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  // ── pull ──

  test('pull returns receivedMessages with ackIds', async () => {
    await service.createSubscription('p', 's', { topic: 'projects/p/topics/t' });
    await service.publish('projects/p/topics/t', {
      messages: [{ data: btoa('pull-me') }],
    });

    const result = await service.pull('projects/p/subscriptions/s', { maxMessages: 10 });

    expect(result.receivedMessages).toHaveLength(1);
    expect(result.receivedMessages[0]?.ackId).toBeTypeOf('string');
    expect(result.receivedMessages[0]?.message.data).toBe(btoa('pull-me'));
  });

  test('pull throws NOT_FOUND for missing subscription', async () => {
    const promise = service.pull('projects/p/subscriptions/missing', { maxMessages: 10 });

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('pull on detached subscription throws FAILED_PRECONDITION', async () => {
    await service.createSubscription('p', 's', { topic: 'projects/p/topics/t' });
    await service.detachSubscription('projects/p/subscriptions/s');

    const promise = service.pull('projects/p/subscriptions/s', { maxMessages: 10 });

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
  });

  // ── acknowledge ──

  test('acknowledge marks messages as acknowledged', async () => {
    await service.createSubscription('p', 's', { topic: 'projects/p/topics/t' });
    await service.publish('projects/p/topics/t', {
      messages: [{ data: btoa('ack-me') }],
    });

    const pulled = await service.pull('projects/p/subscriptions/s', { maxMessages: 10 });
    const ackIds = pulled.receivedMessages.map(m => m.ackId);

    await service.acknowledge('projects/p/subscriptions/s', { ackIds });

    // Pull again - should be empty
    const pulled2 = await service.pull('projects/p/subscriptions/s', { maxMessages: 10 });

    expect(pulled2.receivedMessages).toHaveLength(0);
  });

  test('acknowledge throws NOT_FOUND for missing subscription', async () => {
    const promise = service.acknowledge('projects/p/subscriptions/missing', {
      ackIds: ['fake-ack-id'],
    });

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── modifyAckDeadline ──

  test('modifyAckDeadline updates deadline', async () => {
    await service.createSubscription('p', 's', { topic: 'projects/p/topics/t' });
    await service.publish('projects/p/topics/t', {
      messages: [{ data: btoa('extend') }],
    });

    const pulled = await service.pull('projects/p/subscriptions/s', { maxMessages: 10 });
    const ackIds = pulled.receivedMessages.map(m => m.ackId);

    // Should not throw
    await service.modifyAckDeadline('projects/p/subscriptions/s', {
      ackIds,
      ackDeadlineSeconds: 120,
    });
  });

  test('modifyAckDeadline throws NOT_FOUND for missing subscription', async () => {
    const promise = service.modifyAckDeadline('projects/p/subscriptions/missing', {
      ackIds: ['fake'],
      ackDeadlineSeconds: 10,
    });

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── modifyPushConfig ──

  test('modifyPushConfig updates push configuration', async () => {
    await service.createSubscription('p', 's', { topic: 'projects/p/topics/t' });

    await service.modifyPushConfig('projects/p/subscriptions/s', {
      pushConfig: { pushEndpoint: 'https://example.com/push' },
    });

    const sub = await service.getSubscription('projects/p/subscriptions/s');

    expect(sub.pushConfig?.pushEndpoint).toBe('https://example.com/push');
  });

  test('modifyPushConfig throws NOT_FOUND for missing subscription', async () => {
    const promise = service.modifyPushConfig('projects/p/subscriptions/missing', {
      pushConfig: { pushEndpoint: 'https://example.com/push' },
    });

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── detachSubscription ──

  test('detachSubscription sets detached to true', async () => {
    await service.createSubscription('p', 's', { topic: 'projects/p/topics/t' });

    await service.detachSubscription('projects/p/subscriptions/s');

    const sub = await service.getSubscription('projects/p/subscriptions/s');

    expect(sub.detached).toBe(true);
  });

  test('detachSubscription throws NOT_FOUND for missing subscription', async () => {
    const promise = service.detachSubscription('projects/p/subscriptions/missing');

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── seek ──

  test('seek to past timestamp makes pulled messages re-deliverable', async () => {
    await service.createSubscription('p', 'seek-sub', { topic: 'projects/p/topics/t' });

    // Publish and pull
    await service.publish('projects/p/topics/t', {
      messages: [{ data: btoa('seek-test') }],
    });

    const pullResult = await service.pull('projects/p/subscriptions/seek-sub', {
      maxMessages: 10,
    });

    expect(pullResult.receivedMessages).toHaveLength(1);

    // Pulling again should return nothing (deadline not expired)
    const pullResult2 = await service.pull('projects/p/subscriptions/seek-sub', {
      maxMessages: 10,
    });

    expect(pullResult2.receivedMessages).toHaveLength(0);

    // Seek to a future time (after publish) to reset
    const seekTime = new Date(Date.now() + 5000).toISOString();

    await service.seek('projects/p/subscriptions/seek-sub', { time: seekTime });

    // Now pulling should return the message again
    const pullResult3 = await service.pull('projects/p/subscriptions/seek-sub', {
      maxMessages: 10,
    });

    expect(pullResult3.receivedMessages).toHaveLength(1);
    expect(pullResult3.receivedMessages[0]?.message.data).toBe(btoa('seek-test'));
  });

  test('seek throws NOT_FOUND for missing subscription', async () => {
    const promise = service.seek('projects/p/subscriptions/missing', {
      time: new Date().toISOString(),
    });

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── listTopicSubscriptions ──

  test('listTopicSubscriptions returns subscription names for a topic', async () => {
    await service.createSubscription('p', 's1', { topic: 'projects/p/topics/t' });
    await service.createSubscription('p', 's2', { topic: 'projects/p/topics/t' });

    const result = await service.listTopicSubscriptions('projects/p/topics/t');

    expect(result.subscriptions).toHaveLength(2);
    expect(result.subscriptions.sort()).toEqual([
      'projects/p/subscriptions/s1',
      'projects/p/subscriptions/s2',
    ]);
  });

  test('listTopicSubscriptions throws NOT_FOUND for missing topic', async () => {
    const promise = service.listTopicSubscriptions('projects/p/topics/nonexistent');

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });
});
