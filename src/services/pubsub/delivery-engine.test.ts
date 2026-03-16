/**
 * Unit tests for DeliveryEngine - push delivery of Pub/Sub messages
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { DeliveryEngine } from './delivery-engine.ts';
import { MessageRepository } from './message-repository.ts';
import { SubscriptionRepository } from './subscription-repository.ts';
import { TopicRepository } from './topic-repository.ts';
import type { PushConfig } from './types.ts';

describe('DeliveryEngine', () => {
  let storage: StorageManager;
  let topicRepo: TopicRepository;
  let subRepo: SubscriptionRepository;
  let messageRepo: MessageRepository;
  let logger: Logger;

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

  const baseSub = {
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

    logger = new Logger('test', 'error');

    await topicRepo.createTopic({
      name: 'projects/p/topics/t',
      ...baseTopic,
    });
  });

  function createEngine(httpClient?: (url: string, init: RequestInit) => Promise<Response>) {
    const options = httpClient ? { httpClient } : undefined;

    return new DeliveryEngine(subRepo, messageRepo, logger, options);
  }

  describe('tick', () => {
    test('pushes pending messages to push endpoint', async () => {
      const mockFetch = mock(() => Promise.resolve(new Response('OK', { status: 200 })));

      await subRepo.createSubscription({
        name: 'projects/p/subscriptions/push-sub',
        topic: 'projects/p/topics/t',
        pushConfig: JSON.stringify({
          pushEndpoint: 'https://example.com/push',
        } satisfies PushConfig),
        ...baseSub,
      });

      await messageRepo.publishMessages(
        'projects/p/topics/t',
        [{ data: btoa('hello') }],
        ['projects/p/subscriptions/push-sub']
      );

      const engine = createEngine(mockFetch);

      await engine.tick();

      expect(mockFetch).toHaveBeenCalledTimes(1);

      const callArgs = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
      const [url, init] = callArgs;

      expect(url).toBe('https://example.com/push');
      expect(init.method).toBe('POST');

      const body = JSON.parse(init.body as string) as {
        message: { data: string; messageId: string; publishTime: string };
        subscription: string;
      };

      expect(body.message.data).toBe(btoa('hello'));
      expect(body.message.messageId).toBeTypeOf('string');
      expect(body.message.publishTime).toBeTypeOf('string');
      expect(body.subscription).toBe('projects/p/subscriptions/push-sub');
    });

    test('auto-acks messages on successful push (2xx)', async () => {
      const mockFetch = mock(() => Promise.resolve(new Response('OK', { status: 200 })));

      await subRepo.createSubscription({
        name: 'projects/p/subscriptions/push-sub',
        topic: 'projects/p/topics/t',
        pushConfig: JSON.stringify({
          pushEndpoint: 'https://example.com/push',
        } satisfies PushConfig),
        ...baseSub,
      });

      await messageRepo.publishMessages(
        'projects/p/topics/t',
        [{ data: btoa('auto-ack') }],
        ['projects/p/subscriptions/push-sub']
      );

      const engine = createEngine(mockFetch);

      await engine.tick();

      // Trying to pull should return empty since message was auto-acked
      const pulled = await messageRepo.pullMessages('projects/p/subscriptions/push-sub', 10, 10);

      expect(pulled).toHaveLength(0);
    });

    test('does not push to pull-only subscriptions', async () => {
      const mockFetch = mock(() => Promise.resolve(new Response('OK', { status: 200 })));

      await subRepo.createSubscription({
        name: 'projects/p/subscriptions/pull-sub',
        topic: 'projects/p/topics/t',
        pushConfig: null,
        ...baseSub,
      });

      await messageRepo.publishMessages(
        'projects/p/topics/t',
        [{ data: btoa('pull-only') }],
        ['projects/p/subscriptions/pull-sub']
      );

      const engine = createEngine(mockFetch);

      await engine.tick();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('does not push to detached subscriptions', async () => {
      const mockFetch = mock(() => Promise.resolve(new Response('OK', { status: 200 })));

      await subRepo.createSubscription({
        name: 'projects/p/subscriptions/detached-push',
        topic: 'projects/p/topics/t',
        pushConfig: JSON.stringify({
          pushEndpoint: 'https://example.com/push',
        } satisfies PushConfig),
        ...baseSub,
        detached: 1,
      });

      await messageRepo.publishMessages(
        'projects/p/topics/t',
        [{ data: btoa('detached') }],
        ['projects/p/subscriptions/detached-push']
      );

      const engine = createEngine(mockFetch);

      await engine.tick();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('increments deliveryAttempt on push failure (5xx)', async () => {
      const mockFetch = mock(() => Promise.resolve(new Response('Error', { status: 500 })));

      await subRepo.createSubscription({
        name: 'projects/p/subscriptions/push-fail',
        topic: 'projects/p/topics/t',
        pushConfig: JSON.stringify({
          pushEndpoint: 'https://example.com/push',
        } satisfies PushConfig),
        ...baseSub,
      });

      await messageRepo.publishMessages(
        'projects/p/topics/t',
        [{ data: btoa('fail-me') }],
        ['projects/p/subscriptions/push-fail']
      );

      const engine = createEngine(mockFetch);

      await engine.tick();

      // Message should still be pullable (not acked) and have incremented attempt
      await messageRepo.findPushDeliverableMessages('projects/p/subscriptions/push-fail', 10);

      // Won't be deliverable immediately because ackDeadline was set to future
      // Instead check via the delivered messages directly
      const { data } = await storage.find('pubsub_delivered_messages', {
        filter: {
          conditions: [
            {
              field: 'subscriptionName',
              operator: 'eq',
              value: 'projects/p/subscriptions/push-fail',
            },
          ],
        },
      });

      expect((data[0] as unknown as { deliveryAttempt: number }).deliveryAttempt).toBe(1);
    });

    test('routes to dead-letter topic when maxDeliveryAttempts exceeded', async () => {
      const mockFetch = mock(() => Promise.resolve(new Response('Error', { status: 500 })));

      // Create a dead-letter topic
      await topicRepo.createTopic({
        name: 'projects/p/topics/dead-letter',
        ...baseTopic,
      });

      // Create a subscription on the dead-letter topic to receive messages
      await subRepo.createSubscription({
        name: 'projects/p/subscriptions/dl-sub',
        topic: 'projects/p/topics/dead-letter',
        pushConfig: null,
        ...baseSub,
      });

      await subRepo.createSubscription({
        name: 'projects/p/subscriptions/push-dl',
        topic: 'projects/p/topics/t',
        pushConfig: JSON.stringify({
          pushEndpoint: 'https://example.com/push',
        } satisfies PushConfig),
        ...baseSub,
        deadLetterPolicy: JSON.stringify({
          deadLetterTopic: 'projects/p/topics/dead-letter',
          maxDeliveryAttempts: 1,
        }),
      });

      await messageRepo.publishMessages(
        'projects/p/topics/t',
        [{ data: btoa('dead-letter-me') }],
        ['projects/p/subscriptions/push-dl']
      );

      // Manually set deliveryAttempt to 1 (already at max)
      const delivered = await storage.find('pubsub_delivered_messages', {
        filter: {
          conditions: [
            {
              field: 'subscriptionName',
              operator: 'eq',
              value: 'projects/p/subscriptions/push-dl',
            },
          ],
        },
      });

      const record = delivered.data[0] as { id: string };

      await storage.updateById('pubsub_delivered_messages', record.id, {
        deliveryAttempt: 1,
      });

      const publishFn = mock(
        async (
          topicName: string,
          messages: Array<{
            data?: string | undefined;
            attributes?: Record<string, string> | undefined;
            orderingKey?: string | undefined;
          }>
        ) => {
          const subNames = ['projects/p/subscriptions/dl-sub'];

          await messageRepo.publishMessages(topicName, messages, subNames);
        }
      );

      const engine = new DeliveryEngine(subRepo, messageRepo, logger, {
        httpClient: mockFetch,
        publishFn,
      });

      await engine.tick();

      expect(publishFn).toHaveBeenCalledTimes(1);

      const dlCallArgs = publishFn.mock.calls[0] as unknown as [string, unknown];
      const [dlTopic] = dlCallArgs;

      expect(dlTopic).toBe('projects/p/topics/dead-letter');
    });

    test('handles network errors gracefully', async () => {
      const mockFetch = mock(() => Promise.reject(new Error('Connection refused')));

      await subRepo.createSubscription({
        name: 'projects/p/subscriptions/push-err',
        topic: 'projects/p/topics/t',
        pushConfig: JSON.stringify({
          pushEndpoint: 'https://example.com/push',
        } satisfies PushConfig),
        ...baseSub,
      });

      await messageRepo.publishMessages(
        'projects/p/topics/t',
        [{ data: btoa('err') }],
        ['projects/p/subscriptions/push-err']
      );

      const engine = createEngine(mockFetch);

      // Should not throw
      await engine.tick();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('start/stop', () => {
    test('starts and stops without errors', async () => {
      const engine = createEngine();

      engine.start(10_000);
      await engine.stop();
    });

    test('does not start twice', () => {
      const engine = createEngine();

      engine.start(10_000);
      engine.start(10_000); // Should be a no-op

      // Clean up
      void engine.stop();
    });
  });

  describe('cleanup', () => {
    test('cleans up acked messages periodically', async () => {
      const mockFetch = mock(() => Promise.resolve(new Response('OK', { status: 200 })));

      await subRepo.createSubscription({
        name: 'projects/p/subscriptions/push-cleanup',
        topic: 'projects/p/topics/t',
        pushConfig: JSON.stringify({
          pushEndpoint: 'https://example.com/push',
        } satisfies PushConfig),
        ...baseSub,
      });

      await messageRepo.publishMessages(
        'projects/p/topics/t',
        [{ data: btoa('cleanup-me') }],
        ['projects/p/subscriptions/push-cleanup']
      );

      const engine = new DeliveryEngine(subRepo, messageRepo, logger, {
        httpClient: mockFetch,
        cleanupIntervalTicks: 1, // Clean up every tick for testing
      });

      // First tick: push and ack
      await engine.tick();

      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second tick: cleanup should remove the acked message
      await engine.tick();

      const { data } = await storage.find('pubsub_delivered_messages', {});

      expect(data).toHaveLength(0);
    });

    test('acknowledges message when dead-letter publish fails to prevent infinite retry', async () => {
      const mockFetch = mock(() => Promise.resolve(new Response('Error', { status: 500 })));

      await topicRepo.createTopic({
        name: 'projects/p/topics/dead-letter-fail',
        ...baseTopic,
      });

      await subRepo.createSubscription({
        name: 'projects/p/subscriptions/push-dl-fail',
        topic: 'projects/p/topics/t',
        pushConfig: JSON.stringify({
          pushEndpoint: 'https://example.com/push',
        } satisfies PushConfig),
        ...baseSub,
        deadLetterPolicy: JSON.stringify({
          deadLetterTopic: 'projects/p/topics/dead-letter-fail',
          maxDeliveryAttempts: 1,
        }),
      });

      await messageRepo.publishMessages(
        'projects/p/topics/t',
        [{ data: btoa('stuck-message') }],
        ['projects/p/subscriptions/push-dl-fail']
      );

      // Set deliveryAttempt to max so dead-letter routing triggers
      const delivered = await storage.find('pubsub_delivered_messages', {
        filter: {
          conditions: [
            {
              field: 'subscriptionName',
              operator: 'eq',
              value: 'projects/p/subscriptions/push-dl-fail',
            },
          ],
        },
      });

      const record = delivered.data[0] as { id: string };

      await storage.updateById('pubsub_delivered_messages', record.id, {
        deliveryAttempt: 1,
      });

      // publishFn that throws to simulate dead-letter topic failure
      const failingPublishFn = mock(async () => {
        throw new Error('Dead-letter topic not found');
      });

      const engine = new DeliveryEngine(subRepo, messageRepo, logger, {
        httpClient: mockFetch,
        publishFn: failingPublishFn,
      });

      await engine.tick();

      expect(failingPublishFn).toHaveBeenCalledTimes(1);

      // Message should be acked (not stuck in infinite retry)
      const afterTick = await storage.find('pubsub_delivered_messages', {
        filter: {
          conditions: [
            {
              field: 'subscriptionName',
              operator: 'eq',
              value: 'projects/p/subscriptions/push-dl-fail',
            },
          ],
        },
      });

      const ackStatus = (afterTick.data[0] as unknown as { ackStatus: string }).ackStatus;

      expect(ackStatus).toBe('ACKED');

      // Second tick should NOT re-trigger dead-letter publish
      failingPublishFn.mockReset();
      await engine.tick();

      expect(failingPublishFn).not.toHaveBeenCalled();
    });
  });
});
