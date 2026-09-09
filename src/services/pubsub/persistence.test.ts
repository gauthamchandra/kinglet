/**
 * SQLite reopen coverage for topics, subscriptions, and the message backlog.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageManager } from '@/core/storage/manager.ts';
import { MessageRepository } from './message-repository.ts';
import { SubscriptionRepository } from './subscription-repository.ts';
import { SubscriptionService } from './subscription-service.ts';
import { TopicRepository } from './topic-repository.ts';
import { TopicService } from './topic-service.ts';

describe('Pub/Sub SQLite persistence', () => {
  let dbDir: string | undefined;

  afterEach(async () => {
    if (dbDir) {
      await rm(dbDir, { recursive: true, force: true });
    }
  });

  test('topics, subscriptions, and unacked messages survive reopen', async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'kinglet-pubsub-'));
    const sqlitePath = join(dbDir, 'emulator.db');

    const writer = new StorageManager();

    await writer.initialize({ type: 'sqlite', database: { path: sqlitePath } });

    const topicRepo = new TopicRepository(writer);
    const subRepo = new SubscriptionRepository(writer);
    const messageRepo = new MessageRepository(writer);

    await topicRepo.initialize();
    await subRepo.initialize();
    await messageRepo.initialize();

    const topicService = new TopicService(topicRepo, messageRepo, subRepo);
    const subService = new SubscriptionService(subRepo, topicRepo, messageRepo);

    await topicService.createTopic('p', 'durable', { labels: { env: 'test' } });
    await subService.createSubscription('p', 'durable-sub', {
      topic: 'projects/p/topics/durable',
      ackDeadlineSeconds: 20,
    });
    await subService.publish('projects/p/topics/durable', {
      messages: [{ data: btoa('persisted-body') }],
    });

    await writer.close();

    const reader = new StorageManager();

    await reader.initialize({ type: 'sqlite', database: { path: sqlitePath } });

    const topicRepo2 = new TopicRepository(reader);
    const subRepo2 = new SubscriptionRepository(reader);
    const messageRepo2 = new MessageRepository(reader);

    await topicRepo2.initialize();
    await subRepo2.initialize();
    await messageRepo2.initialize();

    const topicService2 = new TopicService(topicRepo2, messageRepo2, subRepo2);
    const subService2 = new SubscriptionService(subRepo2, topicRepo2, messageRepo2);

    const topic = await topicService2.getTopic('projects/p/topics/durable');

    expect(topic.labels).toEqual({ env: 'test' });

    const sub = await subService2.getSubscription('projects/p/subscriptions/durable-sub');

    expect(sub.ackDeadlineSeconds).toBe(20);

    const pulled = await subService2.pull('projects/p/subscriptions/durable-sub', {
      maxMessages: 10,
    });

    expect(pulled.receivedMessages).toHaveLength(1);
    expect(pulled.receivedMessages[0]?.message.data).toBe(btoa('persisted-body'));

    await reader.close();
  });
});
