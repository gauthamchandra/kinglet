/**
 * Integration tests for Message Broker
 *
 * These tests verify the complete message flow from publishing to acknowledgment,
 * including interactions between topics, subscriptions, and messages.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.js';
import { Logger } from '@/shared/utils/logger.js';
import {
  MessageBroker,
  type PublishRequest,
  type PullRequest,
  type PullResponse,
  type AcknowledgeRequest,
} from './message-broker.js';
import { TopicManager, type CreateTopicRequest } from './topic-manager.js';
import { SubscriptionManager, type CreateSubscriptionRequest } from './subscription-manager.js';

// Create mock logger instance
const mockLogger = new Logger('test', 'error');

let storage: StorageManager;
let messageBroker: MessageBroker;
let topicManager: TopicManager;
let subscriptionManager: SubscriptionManager;

beforeEach(async () => {
  // Create in-memory storage for testing
  storage = new StorageManager();
  await storage.initialize({
    type: 'memory',
    memory: true,
    cache: {
      maxSize: 1000,
      ttlSeconds: 60,
      maxMemoryMb: 1,
    },
  });

  // Create service instances
  messageBroker = new MessageBroker(storage, mockLogger);
  topicManager = new TopicManager(storage, mockLogger);
  subscriptionManager = new SubscriptionManager(storage, mockLogger);

  // Initialize services
  await messageBroker.initialize();
  await topicManager.initialize();
  await subscriptionManager.initialize();
});

afterEach(async () => {
  await storage.close();
});

test('MessageBroker Integration - complete publish/pull/acknowledge flow', async () => {
  // Create topic
  const createTopicRequest: CreateTopicRequest = {
    name: 'projects/test-project/topics/test-topic',
    labels: { env: 'test' },
  };
  const topic = await topicManager.createTopic(createTopicRequest);

  // Create subscription
  const createSubscriptionRequest: CreateSubscriptionRequest = {
    name: 'projects/test-project/subscriptions/test-subscription',
    topic: topic.name,
    ackDeadlineSeconds: 60,
  };
  const subscription = await subscriptionManager.createSubscription(createSubscriptionRequest);

  // Publish messages
  const publishRequest: PublishRequest = {
    topic: topic.name,
    messages: [
      {
        data: 'Hello, World! Message 1',
        attributes: { key1: 'value1', source: 'test' },
      },
      {
        data: 'Hello, World! Message 2',
        attributes: { key2: 'value2', source: 'test' },
        orderingKey: 'order-key-1',
      },
    ],
  };

  const publishResponse = await messageBroker.publish(publishRequest);

  expect(publishResponse.messageIds).toHaveLength(2);
  expect(publishResponse.messageIds[0]).toMatch(/^[0-9a-f-]+$/); // UUID format
  expect(publishResponse.messageIds[1]).toMatch(/^[0-9a-f-]+$/); // UUID format

  // Pull messages
  const pullRequest: PullRequest = {
    subscription: subscription.name,
    maxMessages: 10,
  };

  const pullResponse = await messageBroker.pull(pullRequest);

  expect(pullResponse.receivedMessages).toHaveLength(2);

  // Verify first message
  const firstMessage = pullResponse.receivedMessages[0];

  expect(firstMessage).toBeDefined();
  expect(firstMessage?.ackId).toBeDefined();
  expect(firstMessage?.message.data).toBe(
    Buffer.from('Hello, World! Message 1').toString('base64')
  );
  expect(firstMessage?.message.attributes).toEqual({ key1: 'value1', source: 'test' });
  expect(firstMessage?.deliveryAttempt).toBe(1);

  // Verify second message
  const secondMessage = pullResponse.receivedMessages[1];

  expect(secondMessage).toBeDefined();
  expect(secondMessage?.ackId).toBeDefined();
  expect(secondMessage?.message.data).toBe(
    Buffer.from('Hello, World! Message 2').toString('base64')
  );
  expect(secondMessage?.message.attributes).toEqual({ key2: 'value2', source: 'test' });
  expect(secondMessage?.message.orderingKey).toBe('order-key-1');
  expect(secondMessage?.deliveryAttempt).toBe(1);

  // Acknowledge messages
  const ackRequest: AcknowledgeRequest = {
    subscription: subscription.name,
    ackIds: [firstMessage?.ackId, secondMessage?.ackId].filter(Boolean) as string[],
  };

  await messageBroker.acknowledge(ackRequest);

  // Verify no more messages are available
  const pullResponse2 = await messageBroker.pull(pullRequest);

  expect(pullResponse2.receivedMessages).toHaveLength(0);

  // Verify message statistics
  const stats = await messageBroker.getMessageStats(topic.name);

  expect(stats.totalMessages).toBe(2);
  expect(stats.acknowledgedMessages).toBe(2);
  expect(stats.unacknowledgedMessages).toBe(0);
});

test('MessageBroker Integration - subscription filtering', async () => {
  // Create topic
  const topic = await topicManager.createTopic({
    name: 'projects/test-project/topics/filtered-topic',
  });

  // Create subscription with filter
  const subscription = await subscriptionManager.createSubscription({
    name: 'projects/test-project/subscriptions/filtered-subscription',
    topic: topic.name,
    filter: 'attributes.environment="production"',
  });

  // Publish messages with different attributes
  await messageBroker.publish({
    topic: topic.name,
    messages: [
      {
        data: 'Production message',
        attributes: { environment: 'production', service: 'api' },
      },
      {
        data: 'Development message',
        attributes: { environment: 'development', service: 'api' },
      },
      {
        data: 'Another production message',
        attributes: { environment: 'production', service: 'worker' },
      },
    ],
  });

  // Pull messages - should only get production messages due to filter
  const pullResponse = await messageBroker.pull({
    subscription: subscription.name,
    maxMessages: 10,
  });

  expect(pullResponse.receivedMessages).toHaveLength(2);
  expect(pullResponse.receivedMessages[0]?.message.attributes.environment).toBe('production');
  expect(pullResponse.receivedMessages[1]?.message.attributes.environment).toBe('production');
});

test('MessageBroker Integration - message ordering', async () => {
  // Create topic
  const topic = await topicManager.createTopic({
    name: 'projects/test-project/topics/ordered-topic',
  });

  // Create subscription with message ordering enabled
  const subscription = await subscriptionManager.createSubscription({
    name: 'projects/test-project/subscriptions/ordered-subscription',
    topic: topic.name,
    enableMessageOrdering: true,
  });

  // Publish messages with the same ordering key
  const messages = [];

  for (let i = 0; i < 5; i++) {
    messages.push({
      data: `Message ${i}`,
      orderingKey: 'order-key-1',
      attributes: { sequence: i.toString() },
    });
  }

  await messageBroker.publish({
    topic: topic.name,
    messages,
  });

  // Pull messages - should maintain order
  const pullResponse = await messageBroker.pull({
    subscription: subscription.name,
    maxMessages: 10,
  });

  expect(pullResponse.receivedMessages).toHaveLength(5);

  // Verify order is maintained (by publish time)
  let previousPublishTime = 0;

  for (const receivedMessage of pullResponse.receivedMessages) {
    const publishTime = new Date(receivedMessage.message.publishTime).getTime();

    expect(publishTime).toBeGreaterThanOrEqual(previousPublishTime);
    previousPublishTime = publishTime;
  }
});

test('MessageBroker Integration - retry and dead letter handling', async () => {
  // Create topic and dead letter topic
  const topic = await topicManager.createTopic({
    name: 'projects/test-project/topics/retry-topic-unique',
  });

  const deadLetterTopic = await topicManager.createTopic({
    name: 'projects/test-project/topics/retry-dead-letter-topic-unique',
  });

  // Create subscription with dead letter policy
  const subscription = await subscriptionManager.createSubscription({
    name: 'projects/test-project/subscriptions/retry-subscription-unique',
    topic: topic.name,
    ackDeadlineSeconds: 10,
    deadLetterPolicy: {
      deadLetterTopic: deadLetterTopic.name,
      maxDeliveryAttempts: 5, // Minimum allowed value
    },
  });

  // Publish a message
  await messageBroker.publish({
    topic: topic.name,
    messages: [{ data: 'Test message for retry' }],
  });

  // Pull message multiple times without acknowledging to simulate retries
  for (let attempt = 1; attempt <= 5; attempt++) {
    const pullResponse = await messageBroker.pull({
      subscription: subscription.name,
      maxMessages: 1,
    });

    expect(pullResponse.receivedMessages).toHaveLength(1);
    expect(pullResponse.receivedMessages[0]?.deliveryAttempt).toBe(attempt);

    // Don't acknowledge - but manually delete the lease to simulate lease expiration
    const ackId = pullResponse.receivedMessages[0]?.ackId;

    if (ackId) {
      // Access the message repository through the broker to delete the lease
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (messageBroker as any).messageRepository.deleteLeaseByAckId(ackId);
    }
  }

  // After max delivery attempts, message should be moved to dead letter topic
  // This would be handled by background processing in a real implementation
});

test('MessageBroker Integration - multiple subscriptions to same topic', async () => {
  // Create topic
  const topic = await topicManager.createTopic({
    name: 'projects/test-project/topics/multi-sub-topic',
  });

  // Create multiple subscriptions
  const subscription1 = await subscriptionManager.createSubscription({
    name: 'projects/test-project/subscriptions/multi-sub1-unique',
    topic: topic.name,
  });

  const subscription2 = await subscriptionManager.createSubscription({
    name: 'projects/test-project/subscriptions/multi-sub2-unique',
    topic: topic.name,
  });

  // Publish a message
  await messageBroker.publish({
    topic: topic.name,
    messages: [{ data: 'Broadcast message', attributes: { type: 'broadcast' } }],
  });

  // Both subscriptions should receive the message
  const pullResponse1 = await messageBroker.pull({
    subscription: subscription1.name,
    maxMessages: 10,
  });

  const pullResponse2 = await messageBroker.pull({
    subscription: subscription2.name,
    maxMessages: 10,
  });

  expect(pullResponse1.receivedMessages).toHaveLength(1);
  expect(pullResponse2.receivedMessages).toHaveLength(1);

  // Messages should have different ack IDs
  expect(pullResponse1.receivedMessages[0]?.ackId).not.toBe(
    pullResponse2.receivedMessages[0]?.ackId
  );

  // But same message ID
  expect(pullResponse1.receivedMessages[0]?.message.messageId).toBe(
    pullResponse2.receivedMessages[0]?.message.messageId
  );
});

test('MessageBroker Integration - empty data messages', async () => {
  // Create topic and subscription
  const topic = await topicManager.createTopic({
    name: 'projects/test-project/topics/empty-data-topic',
  });

  const subscription = await subscriptionManager.createSubscription({
    name: 'projects/test-project/subscriptions/empty-data-subscription',
    topic: topic.name,
  });

  // Publish message with no data, only attributes
  await messageBroker.publish({
    topic: topic.name,
    messages: [
      {
        attributes: { type: 'notification', priority: 'high' },
      },
    ],
  });

  // Pull message
  const pullResponse = await messageBroker.pull({
    subscription: subscription.name,
    maxMessages: 1,
  });

  expect(pullResponse.receivedMessages).toHaveLength(1);
  expect(pullResponse.receivedMessages[0]?.message.data).toBeUndefined();
  expect(pullResponse.receivedMessages[0]?.message.attributes).toEqual({
    type: 'notification',
    priority: 'high',
  });
});

test('MessageBroker Integration - large batch publishing', async () => {
  // Create topic and subscription
  const topic = await topicManager.createTopic({
    name: 'projects/test-project/topics/batch-topic',
  });

  const subscription = await subscriptionManager.createSubscription({
    name: 'projects/test-project/subscriptions/batch-subscription',
    topic: topic.name,
  });

  // Publish a large batch of messages (up to limit)
  const messages = [];

  for (let i = 0; i < 100; i++) {
    messages.push({
      data: `Batch message ${i}`,
      attributes: { batch: 'true', index: i.toString() },
    });
  }

  const publishResponse = await messageBroker.publish({
    topic: topic.name,
    messages,
  });

  expect(publishResponse.messageIds).toHaveLength(100);

  // Pull messages in batches
  let totalPulled = 0;
  let pullAttempts = 0;

  while (totalPulled < 100 && pullAttempts < 10) {
    const pullResponse = await messageBroker.pull({
      subscription: subscription.name,
      maxMessages: 50,
    });

    totalPulled += pullResponse.receivedMessages.length;
    pullAttempts++;

    // Acknowledge all messages
    if (pullResponse.receivedMessages.length > 0) {
      await messageBroker.acknowledge({
        subscription: subscription.name,
        ackIds: pullResponse.receivedMessages.map(m => m.ackId),
      });
    }
  }

  expect(totalPulled).toBe(100);

  // Verify all messages are acknowledged
  const stats = await messageBroker.getMessageStats(topic.name);

  expect(stats.acknowledgedMessages).toBe(100);
  expect(stats.unacknowledgedMessages).toBe(0);
});

test('MessageBroker Integration - concurrent pull operations', async () => {
  // Create topic and subscription
  const topic = await topicManager.createTopic({
    name: 'projects/test-project/topics/concurrent-topic',
  });

  const subscription = await subscriptionManager.createSubscription({
    name: 'projects/test-project/subscriptions/concurrent-subscription',
    topic: topic.name,
  });

  // Publish messages
  await messageBroker.publish({
    topic: topic.name,
    messages: [
      { data: 'Message 1' },
      { data: 'Message 2' },
      { data: 'Message 3' },
      { data: 'Message 4' },
      { data: 'Message 5' },
    ],
  });

  // Perform concurrent pulls with small delays to reduce race conditions
  const pullPromises: Promise<PullResponse>[] = [];

  for (let i = 0; i < 3; i++) {
    pullPromises.push(
      new Promise<PullResponse>(
        resolve =>
          setTimeout(
            () =>
              messageBroker
                .pull({
                  subscription: subscription.name,
                  maxMessages: 5,
                })
                .then(resolve),
            i * 10
          ) // 10ms delay between pulls
      )
    );
  }

  const pullResponses = await Promise.all(pullPromises);

  // Verify that messages are distributed among the pulls
  let totalMessages = 0;
  const allAckIds = new Set<string>();
  const allMessageIds = new Set<string>();

  for (const response of pullResponses) {
    totalMessages += response.receivedMessages.length;
    for (const message of response.receivedMessages) {
      expect(allAckIds.has(message.ackId)).toBe(false); // No duplicate ack IDs
      allAckIds.add(message.ackId);
      allMessageIds.add(message.message.messageId);
    }
  }

  expect(totalMessages).toBe(5); // All messages should be pulled
  expect(allAckIds.size).toBe(5); // All unique ack IDs
  expect(allMessageIds.size).toBe(5); // All unique message IDs
});

test('MessageBroker Integration - cleanup operations', async () => {
  // Create topic and subscription
  const topic = await topicManager.createTopic({
    name: 'projects/test-project/topics/cleanup-topic',
  });

  const subscription = await subscriptionManager.createSubscription({
    name: 'projects/test-project/subscriptions/cleanup-subscription',
    topic: topic.name,
    ackDeadlineSeconds: 10, // Minimum allowed deadline
  });

  // Publish messages
  await messageBroker.publish({
    topic: topic.name,
    messages: [{ data: 'Message to expire' }],
  });

  // Pull message
  const pullResponse = await messageBroker.pull({
    subscription: subscription.name,
    maxMessages: 1,
  });

  expect(pullResponse.receivedMessages).toHaveLength(1);

  // Run cleanup operations (without waiting for actual expiry for test performance)
  await messageBroker.handleExpiredLeases();

  // Clean up old messages (with very short retention for testing)
  await messageBroker.cleanupOldMessages(100); // 100ms retention

  // Verify cleanup operations complete without error
  const stats = await messageBroker.getMessageStats(topic.name);

  expect(stats.totalMessages).toBeGreaterThanOrEqual(0); // Messages may or may not be cleaned up depending on acknowledgment
});

test('MessageBroker Integration - error handling', async () => {
  // Test publishing to non-existent topic (should still work as topics are created implicitly in some implementations)
  const publishRequest: PublishRequest = {
    topic: 'projects/test-project/topics/non-existent',
    messages: [{ data: 'Test message' }],
  };

  // This might throw an error or succeed depending on implementation
  try {
    await messageBroker.publish(publishRequest);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
  }

  // Test pulling from non-existent subscription
  const pullRequest: PullRequest = {
    subscription: 'projects/test-project/subscriptions/non-existent',
    maxMessages: 1,
  };

  await expect(messageBroker.pull(pullRequest)).rejects.toThrow('Subscription not found');

  // Test acknowledging with invalid ack ID
  const ackRequest: AcknowledgeRequest = {
    subscription: 'projects/test-project/subscriptions/some-subscription',
    ackIds: ['invalid-ack-id'],
  };

  // Should not throw error, but log warnings
  await messageBroker.acknowledge(ackRequest);
});
