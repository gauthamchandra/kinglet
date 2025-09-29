/**
 * Unit tests for Subscription Repository
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { ValidationError } from '@/core/storage/types.js';
import type { QueryResult } from '@/core/storage/types.js';
import { SubscriptionRepository, type CreateSubscriptionData } from './subscription-repository.js';
import type { SubscriptionRecord } from '../models.js';
import { createMockStorage, mockResolvedValueOnce } from '@/test-utils/mock-storage.js';

// Mock storage manager
const mockStorage = createMockStorage();

let repository: SubscriptionRepository;

beforeEach(() => {
  mockStorage.resetAllMocks();
  repository = new SubscriptionRepository(mockStorage);
});

afterEach(() => {
  mockStorage.resetAllMocks();
});

test('SubscriptionRepository - initialize should create table', async () => {
  await repository.initialize();

  expect(mockStorage.createTable).toHaveBeenCalledWith('pubsub_subscriptions', expect.any(Object));
});

test('SubscriptionRepository - create should create valid subscription', async () => {
  const subscriptionData: CreateSubscriptionData = {
    name: 'projects/test-project/subscriptions/test-subscription',
    topic: 'projects/test-project/topics/test-topic',
    labels: { env: 'test' },
    ackDeadlineSeconds: 30,
  };

  mockResolvedValueOnce(mockStorage.findFirst, null); // No existing subscription

  const subscription = await repository.create(subscriptionData);

  expect(subscription).toMatchObject({
    name: 'projects/test-project/subscriptions/test-subscription',
    topic: 'projects/test-project/topics/test-topic',
    labels: { env: 'test' },
    ackDeadlineSeconds: 30,
    projectId: 'test-project',
    subscriptionId: 'test-subscription',
    topicId: 'test-topic',
  });
  expect(subscription.id).toBeDefined();
  expect(subscription.createdAt).toBeInstanceOf(Date);
  expect(subscription.updatedAt).toBeInstanceOf(Date);
  expect(mockStorage.create).toHaveBeenCalledWith('pubsub_subscriptions', expect.any(Object));
});

test('SubscriptionRepository - create should throw error for invalid subscription name', async () => {
  const subscriptionData: CreateSubscriptionData = {
    name: 'invalid-subscription-name',
    topic: 'projects/test-project/topics/test-topic',
  };

  await expect(repository.create(subscriptionData)).rejects.toThrow(ValidationError);
  await expect(repository.create(subscriptionData)).rejects.toThrow('Invalid subscription name');
});

test('SubscriptionRepository - create should throw error for invalid topic name', async () => {
  const subscriptionData: CreateSubscriptionData = {
    name: 'projects/test-project/subscriptions/test-subscription',
    topic: 'invalid-topic-name',
  };

  await expect(repository.create(subscriptionData)).rejects.toThrow(ValidationError);
  await expect(repository.create(subscriptionData)).rejects.toThrow('Invalid topic name');
});

test('SubscriptionRepository - create should throw error for existing subscription', async () => {
  const subscriptionData: CreateSubscriptionData = {
    name: 'projects/test-project/subscriptions/existing-subscription',
    topic: 'projects/test-project/topics/test-topic',
  };

  const existingSubscription = {
    id: 'sub-123',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    name: 'projects/test-project/subscriptions/existing-subscription',
    topic: 'projects/test-project/topics/test-topic',
    labels: JSON.stringify({}),
    ackDeadlineSeconds: 10,
    projectId: 'test-project',
    subscriptionId: 'existing-subscription',
    topicId: 'test-topic',
  };

  // Mock findFirst to return existing subscription (called by findByName in create method)
  mockResolvedValueOnce(mockStorage.findFirst, existingSubscription);

  // Verify that the error is thrown
  try {
    await repository.create(subscriptionData);
    expect(false).toBe(true); // Should not reach here
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toContain('Subscription already exists');
  }
});

test('SubscriptionRepository - create should handle optional fields correctly', async () => {
  const subscriptionData: CreateSubscriptionData = {
    name: 'projects/test-project/subscriptions/test-subscription',
    topic: 'projects/test-project/topics/test-topic',
    pushConfig: {
      pushEndpoint: 'https://example.com/webhook',
    },
    deadLetterPolicy: {
      deadLetterTopic: 'projects/test-project/topics/dead-letter',
      maxDeliveryAttempts: 10,
    },
    retryPolicy: {
      minimumBackoff: '1s',
      maximumBackoff: '60s',
    },
    enableMessageOrdering: true,
    enableExactlyOnceDelivery: true,
  };

  mockResolvedValueOnce(mockStorage.findFirst, null); // No existing subscription

  const subscription = await repository.create(subscriptionData);

  expect(subscription.pushConfig).toEqual({ pushEndpoint: 'https://example.com/webhook' });
  expect(subscription.deadLetterPolicy).toEqual({
    deadLetterTopic: 'projects/test-project/topics/dead-letter',
    maxDeliveryAttempts: 10,
  });
  expect(subscription.retryPolicy).toEqual({
    minimumBackoff: '1s',
    maximumBackoff: '60s',
  });
  expect(subscription.enableMessageOrdering).toBe(true);
  expect(subscription.enableExactlyOnceDelivery).toBe(true);
});

test('SubscriptionRepository - findById should return subscription if exists', async () => {
  const mockStorageRecord = {
    id: 'sub-123',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    name: 'projects/test-project/subscriptions/test-subscription',
    topic: 'projects/test-project/topics/test-topic',
    labels: JSON.stringify({ env: 'test' }),
    ackDeadlineSeconds: 30,
    retainAckedMessages: 0,
    enableMessageOrdering: 1,
    detached: 0,
    enableExactlyOnceDelivery: 0,
    state: 'ACTIVE',
    projectId: 'test-project',
    subscriptionId: 'test-subscription',
    topicId: 'test-topic',
  };

  mockResolvedValueOnce(mockStorage.findById, mockStorageRecord);

  const subscription = await repository.findById('sub-123');

  expect(subscription).toBeDefined();
  expect(subscription?.id).toBe('sub-123');
  expect(subscription?.name).toBe('projects/test-project/subscriptions/test-subscription');
  expect(subscription?.topic).toBe('projects/test-project/topics/test-topic');
  expect(subscription?.labels).toEqual({ env: 'test' });
  expect(subscription?.ackDeadlineSeconds).toBe(30);
  expect(subscription?.retainAckedMessages).toBe(false);
  expect(subscription?.enableMessageOrdering).toBe(true);
  expect(subscription?.detached).toBe(false);
  expect(subscription?.enableExactlyOnceDelivery).toBe(false);
  expect(subscription?.state).toBe('ACTIVE');
});

test('SubscriptionRepository - findById should return null if not exists', async () => {
  mockResolvedValueOnce(mockStorage.findById, null);

  const subscription = await repository.findById('non-existent');

  expect(subscription).toBeNull();
});

test('SubscriptionRepository - findByName should return subscription if exists', async () => {
  const mockStorageRecord = {
    id: 'sub-123',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    name: 'projects/test-project/subscriptions/test-subscription',
    topic: 'projects/test-project/topics/test-topic',
    labels: JSON.stringify({}),
    ackDeadlineSeconds: 10,
    retainAckedMessages: 0,
    enableMessageOrdering: 0,
    detached: 0,
    enableExactlyOnceDelivery: 0,
    state: 'ACTIVE',
    projectId: 'test-project',
    subscriptionId: 'test-subscription',
    topicId: 'test-topic',
  };

  mockResolvedValueOnce(mockStorage.findFirst, mockStorageRecord);

  const subscription = await repository.findByName(
    'projects/test-project/subscriptions/test-subscription'
  );

  expect(subscription).toBeDefined();
  expect(subscription?.name).toBe('projects/test-project/subscriptions/test-subscription');
  expect(mockStorage.findFirst).toHaveBeenCalledWith('pubsub_subscriptions', {
    filter: {
      conditions: [
        {
          field: 'name',
          operator: 'eq',
          value: 'projects/test-project/subscriptions/test-subscription',
        },
      ],
      operator: 'and',
    },
  });
});

test('SubscriptionRepository - find should return subscriptions matching criteria', async () => {
  const mockStorageResult: QueryResult<Record<string, unknown>> = {
    data: [
      {
        id: 'sub-1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        name: 'projects/test-project/subscriptions/sub-1',
        topic: 'projects/test-project/topics/test-topic',
        labels: JSON.stringify({ env: 'test' }),
        ackDeadlineSeconds: 30,
        retainAckedMessages: 0,
        enableMessageOrdering: 0,
        detached: 0,
        enableExactlyOnceDelivery: 0,
        state: 'ACTIVE',
        projectId: 'test-project',
        subscriptionId: 'sub-1',
        topicId: 'test-topic',
      },
      {
        id: 'sub-2',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        name: 'projects/test-project/subscriptions/sub-2',
        topic: 'projects/test-project/topics/test-topic',
        labels: JSON.stringify({ env: 'prod' }),
        ackDeadlineSeconds: 60,
        retainAckedMessages: 1,
        enableMessageOrdering: 1,
        detached: 0,
        enableExactlyOnceDelivery: 1,
        state: 'ACTIVE',
        projectId: 'test-project',
        subscriptionId: 'sub-2',
        topicId: 'test-topic',
      },
    ],
    total: 2,
    hasMore: false,
  };

  mockResolvedValueOnce(mockStorage.find, mockStorageResult);

  const result = await repository.find({ projectId: 'test-project' });

  expect(result.data).toHaveLength(2);
  expect(result.data[0]?.name).toBe('projects/test-project/subscriptions/sub-1');
  expect(result.data[0]?.labels).toEqual({ env: 'test' });
  expect(result.data[1]?.name).toBe('projects/test-project/subscriptions/sub-2');
  expect(result.data[1]?.labels).toEqual({ env: 'prod' });
  expect(result.data[1]?.retainAckedMessages).toBe(true);
  expect(result.data[1]?.enableMessageOrdering).toBe(true);
  expect(result.data[1]?.enableExactlyOnceDelivery).toBe(true);
  expect(result.total).toBe(2);
  expect(result.hasMore).toBe(false);
});

test('SubscriptionRepository - findByProject should filter by project ID', async () => {
  const mockStorageResult: QueryResult<Record<string, unknown>> = {
    data: [],
    total: 0,
    hasMore: false,
  };

  mockResolvedValueOnce(mockStorage.find, mockStorageResult);

  await repository.findByProject('test-project', {
    pagination: { limit: 10 },
  });

  expect(mockStorage.find).toHaveBeenCalledWith('pubsub_subscriptions', {
    pagination: { limit: 10 },
    projectId: 'test-project',
    filter: {
      conditions: [{ field: 'projectId', operator: 'eq', value: 'test-project' }],
      operator: 'and',
    },
  });
});

test('SubscriptionRepository - findByTopic should filter by topic', async () => {
  const mockStorageResult: QueryResult<Record<string, unknown>> = {
    data: [],
    total: 0,
    hasMore: false,
  };

  mockResolvedValueOnce(mockStorage.find, mockStorageResult);

  await repository.findByTopic('projects/test-project/topics/test-topic', {
    pagination: { limit: 10 },
  });

  expect(mockStorage.find).toHaveBeenCalledWith('pubsub_subscriptions', {
    pagination: { limit: 10 },
    topic: 'projects/test-project/topics/test-topic',
    filter: {
      conditions: [
        { field: 'topic', operator: 'eq', value: 'projects/test-project/topics/test-topic' },
      ],
      operator: 'and',
    },
  });
});

test('SubscriptionRepository - findByTopicId should filter by project and topic ID', async () => {
  const mockStorageResult: QueryResult<Record<string, unknown>> = {
    data: [],
    total: 0,
    hasMore: false,
  };

  mockResolvedValueOnce(mockStorage.find, mockStorageResult);

  await repository.findByTopicId('test-project', 'test-topic', {
    pagination: { limit: 10 },
  });

  expect(mockStorage.find).toHaveBeenCalledWith('pubsub_subscriptions', {
    pagination: { limit: 10 },
    projectId: 'test-project',
    topicId: 'test-topic',
    filter: {
      conditions: [
        { field: 'projectId', operator: 'eq', value: 'test-project' },
        { field: 'topicId', operator: 'eq', value: 'test-topic' },
      ],
      operator: 'and',
    },
  });
});

test('SubscriptionRepository - updateById should update existing subscription', async () => {
  const existingSubscription: SubscriptionRecord = {
    id: 'sub-123',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    name: 'projects/test-project/subscriptions/test-subscription',
    topic: 'projects/test-project/topics/test-topic',
    labels: { env: 'test' },
    ackDeadlineSeconds: 10,
    retainAckedMessages: false,
    enableMessageOrdering: false,
    detached: false,
    enableExactlyOnceDelivery: false,
    state: 'ACTIVE',
    projectId: 'test-project',
    subscriptionId: 'test-subscription',
    topicId: 'test-topic',
  };

  mockResolvedValueOnce(mockStorage.findById, {
    id: existingSubscription.id,
    createdAt: existingSubscription.createdAt.toISOString(),
    updatedAt: existingSubscription.updatedAt.toISOString(),
    name: existingSubscription.name,
    topic: existingSubscription.topic,
    labels: JSON.stringify(existingSubscription.labels),
    ackDeadlineSeconds: existingSubscription.ackDeadlineSeconds,
    retainAckedMessages: existingSubscription.retainAckedMessages ? 1 : 0,
    enableMessageOrdering: existingSubscription.enableMessageOrdering ? 1 : 0,
    detached: existingSubscription.detached ? 1 : 0,
    enableExactlyOnceDelivery: existingSubscription.enableExactlyOnceDelivery ? 1 : 0,
    state: existingSubscription.state,
    projectId: existingSubscription.projectId,
    subscriptionId: existingSubscription.subscriptionId,
    topicId: existingSubscription.topicId,
  });

  const updateData = {
    labels: { env: 'prod', version: '1.0' },
    ackDeadlineSeconds: 60,
    retainAckedMessages: true,
  };

  const updatedSubscription = await repository.updateById('sub-123', updateData);

  expect(updatedSubscription).toBeDefined();
  expect(updatedSubscription?.labels).toEqual({ env: 'prod', version: '1.0' });
  expect(updatedSubscription?.ackDeadlineSeconds).toBe(60);
  expect(updatedSubscription?.retainAckedMessages).toBe(true);
  expect(updatedSubscription?.updatedAt.getTime()).toBeGreaterThan(
    existingSubscription.updatedAt.getTime()
  );
  expect(mockStorage.updateById).toHaveBeenCalledWith(
    'pubsub_subscriptions',
    'sub-123',
    expect.any(Object)
  );
});

test('SubscriptionRepository - updateById should return null for non-existent subscription', async () => {
  // Reset the mock to clear any previous call history
  mockStorage.resetAllMocks();
  mockResolvedValueOnce(mockStorage.findById, null);

  const result = await repository.updateById('non-existent', { labels: {} });

  expect(result).toBeNull();
  expect(mockStorage.findById).toHaveBeenCalledWith('pubsub_subscriptions', 'non-existent');
  // Verify updateById was not called since findById returned null
  const updateCalls =
    (mockStorage.updateById as unknown as { mock?: { calls?: unknown[] } }).mock?.calls || [];
  const updateCallsForThisTest = updateCalls.filter(
    (call: unknown) => Array.isArray(call) && call[1] === 'non-existent' // Only count calls with our test ID
  );

  expect(updateCallsForThisTest).toHaveLength(0);
});

test('SubscriptionRepository - deleteById should delete subscription', async () => {
  mockResolvedValueOnce(mockStorage.deleteById, true);

  const result = await repository.deleteById('sub-123');

  expect(result).toBe(true);
  expect(mockStorage.deleteById).toHaveBeenCalledWith('pubsub_subscriptions', 'sub-123');
});

test('SubscriptionRepository - deleteByName should delete subscription by name', async () => {
  const mockSubscription = {
    id: 'sub-123',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    name: 'projects/test-project/subscriptions/test-subscription',
    topic: 'projects/test-project/topics/test-topic',
    labels: JSON.stringify({}),
    ackDeadlineSeconds: 10,
    projectId: 'test-project',
    subscriptionId: 'test-subscription',
    topicId: 'test-topic',
  };

  mockResolvedValueOnce(mockStorage.findFirst, mockSubscription);
  mockResolvedValueOnce(mockStorage.deleteById, true);

  const result = await repository.deleteByName(
    'projects/test-project/subscriptions/test-subscription'
  );

  expect(result).toBe(true);
  expect(mockStorage.deleteById).toHaveBeenCalledWith('pubsub_subscriptions', 'sub-123');
});

test('SubscriptionRepository - deleteByName should return false for non-existent subscription', async () => {
  // Reset the mock to clear any previous call history
  mockStorage.resetAllMocks();
  mockResolvedValueOnce(mockStorage.findFirst, null);

  const result = await repository.deleteByName('projects/test-project/subscriptions/non-existent');

  expect(result).toBe(false);
  expect(mockStorage.findFirst).toHaveBeenCalledWith('pubsub_subscriptions', expect.any(Object));

  // Verify deleteById was not called since findFirst returned null
  expect(mockStorage.deleteById).not.toHaveBeenCalled();
});

test('SubscriptionRepository - exists should check subscription existence', async () => {
  mockResolvedValueOnce(mockStorage.exists, true);

  const exists = await repository.exists('sub-123');

  expect(exists).toBe(true);
  expect(mockStorage.exists).toHaveBeenCalledWith('pubsub_subscriptions', 'sub-123');
});

test('SubscriptionRepository - existsByName should check subscription existence by name', async () => {
  const mockSubscription = {
    id: 'sub-123',
    name: 'projects/test-project/subscriptions/test-subscription',
  };

  mockResolvedValueOnce(mockStorage.findFirst, mockSubscription);

  const exists = await repository.existsByName(
    'projects/test-project/subscriptions/test-subscription'
  );

  expect(exists).toBe(true);
});

test('SubscriptionRepository - existsByName should return false for non-existent subscription', async () => {
  mockResolvedValueOnce(mockStorage.findFirst, null);

  const exists = await repository.existsByName('projects/test-project/subscriptions/non-existent');

  expect(exists).toBe(false);
});

test('SubscriptionRepository - count should return subscription count', async () => {
  mockResolvedValueOnce(mockStorage.count, 5);

  const count = await repository.count({ projectId: 'test-project' });

  expect(count).toBe(5);
  expect(mockStorage.count).toHaveBeenCalledWith('pubsub_subscriptions', {
    conditions: [{ field: 'projectId', operator: 'eq', value: 'test-project' }],
    operator: 'and',
  });
});

test('SubscriptionRepository - countByProject should return project subscription count', async () => {
  mockResolvedValueOnce(mockStorage.count, 3);

  const count = await repository.countByProject('test-project');

  expect(count).toBe(3);
  expect(mockStorage.count).toHaveBeenCalledWith('pubsub_subscriptions', {
    conditions: [{ field: 'projectId', operator: 'eq', value: 'test-project' }],
    operator: 'and',
  });
});

test('SubscriptionRepository - countByTopic should return topic subscription count', async () => {
  mockResolvedValueOnce(mockStorage.count, 2);

  const count = await repository.countByTopic('projects/test-project/topics/test-topic');

  expect(count).toBe(2);
  expect(mockStorage.count).toHaveBeenCalledWith('pubsub_subscriptions', {
    conditions: [
      { field: 'topic', operator: 'eq', value: 'projects/test-project/topics/test-topic' },
    ],
    operator: 'and',
  });
});

test('SubscriptionRepository - listSubscriptionNames should return subscription names', async () => {
  const mockStorageResult: QueryResult<Record<string, unknown>> = {
    data: [
      {
        id: 'sub-1',
        name: 'projects/test-project/subscriptions/sub-1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        topic: 'projects/test-project/topics/test-topic',
        labels: JSON.stringify({}),
        ackDeadlineSeconds: 10,
        retainAckedMessages: 0,
        enableMessageOrdering: 0,
        detached: 0,
        enableExactlyOnceDelivery: 0,
        state: 'ACTIVE',
        projectId: 'test-project',
        subscriptionId: 'sub-1',
        topicId: 'test-topic',
      },
      {
        id: 'sub-2',
        name: 'projects/test-project/subscriptions/sub-2',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        topic: 'projects/test-project/topics/test-topic',
        labels: JSON.stringify({}),
        ackDeadlineSeconds: 10,
        retainAckedMessages: 0,
        enableMessageOrdering: 0,
        detached: 0,
        enableExactlyOnceDelivery: 0,
        state: 'ACTIVE',
        projectId: 'test-project',
        subscriptionId: 'sub-2',
        topicId: 'test-topic',
      },
    ],
    total: 2,
    hasMore: false,
  };

  mockResolvedValueOnce(mockStorage.find, mockStorageResult);

  const names = await repository.listSubscriptionNames('test-project');

  expect(names).toEqual([
    'projects/test-project/subscriptions/sub-1',
    'projects/test-project/subscriptions/sub-2',
  ]);
});

test('SubscriptionRepository - findPushSubscriptions should return only push subscriptions', async () => {
  const mockStorageResult: QueryResult<Record<string, unknown>> = {
    data: [
      {
        id: 'sub-1',
        name: 'projects/test-project/subscriptions/push-sub',
        topic: 'projects/test-project/topics/test-topic',
        pushConfig: JSON.stringify({ pushEndpoint: 'https://example.com/webhook' }),
        labels: JSON.stringify({}),
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        ackDeadlineSeconds: 10,
        retainAckedMessages: 0,
        enableMessageOrdering: 0,
        detached: 0,
        enableExactlyOnceDelivery: 0,
        state: 'ACTIVE',
        projectId: 'test-project',
        subscriptionId: 'push-sub',
        topicId: 'test-topic',
      },
      {
        id: 'sub-2',
        name: 'projects/test-project/subscriptions/pull-sub',
        topic: 'projects/test-project/topics/test-topic',
        pushConfig: null,
        labels: JSON.stringify({}),
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        ackDeadlineSeconds: 10,
        retainAckedMessages: 0,
        enableMessageOrdering: 0,
        detached: 0,
        enableExactlyOnceDelivery: 0,
        state: 'ACTIVE',
        projectId: 'test-project',
        subscriptionId: 'pull-sub',
        topicId: 'test-topic',
      },
    ],
    total: 2,
    hasMore: false,
  };

  mockResolvedValueOnce(mockStorage.find, mockStorageResult);

  const result = await repository.findPushSubscriptions({ projectId: 'test-project' });

  expect(result.data).toHaveLength(1);
  expect(result.data[0]?.name).toBe('projects/test-project/subscriptions/push-sub');
  expect(result.data[0]?.pushConfig).toEqual({ pushEndpoint: 'https://example.com/webhook' });
});

test('SubscriptionRepository - findPullSubscriptions should return only pull subscriptions', async () => {
  const mockStorageResult: QueryResult<Record<string, unknown>> = {
    data: [
      {
        id: 'sub-1',
        name: 'projects/test-project/subscriptions/push-sub',
        topic: 'projects/test-project/topics/test-topic',
        pushConfig: JSON.stringify({ pushEndpoint: 'https://example.com/webhook' }),
        labels: JSON.stringify({}),
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        ackDeadlineSeconds: 10,
        retainAckedMessages: 0,
        enableMessageOrdering: 0,
        detached: 0,
        enableExactlyOnceDelivery: 0,
        state: 'ACTIVE',
        projectId: 'test-project',
        subscriptionId: 'push-sub',
        topicId: 'test-topic',
      },
      {
        id: 'sub-2',
        name: 'projects/test-project/subscriptions/pull-sub',
        topic: 'projects/test-project/topics/test-topic',
        pushConfig: null,
        labels: JSON.stringify({}),
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        ackDeadlineSeconds: 10,
        retainAckedMessages: 0,
        enableMessageOrdering: 0,
        detached: 0,
        enableExactlyOnceDelivery: 0,
        state: 'ACTIVE',
        projectId: 'test-project',
        subscriptionId: 'pull-sub',
        topicId: 'test-topic',
      },
    ],
    total: 2,
    hasMore: false,
  };

  mockResolvedValueOnce(mockStorage.find, mockStorageResult);

  const result = await repository.findPullSubscriptions({ projectId: 'test-project' });

  expect(result.data).toHaveLength(1);
  expect(result.data[0]?.name).toBe('projects/test-project/subscriptions/pull-sub');
  expect(result.data[0]?.pushConfig).toBeUndefined();
});

test('SubscriptionRepository - should handle complex objects in storage conversion', async () => {
  const subscriptionData: CreateSubscriptionData = {
    name: 'projects/test-project/subscriptions/complex-subscription',
    topic: 'projects/test-project/topics/test-topic',
    labels: { env: 'test', version: '1.0' },
    pushConfig: {
      pushEndpoint: 'https://example.com/webhook',
      attributes: { key: 'value' },
      oidcToken: {
        serviceAccountEmail: 'test@example.com',
        audience: 'https://example.com',
      },
    },
    deadLetterPolicy: {
      deadLetterTopic: 'projects/test-project/topics/dead-letter',
      maxDeliveryAttempts: 10,
    },
    retryPolicy: {
      minimumBackoff: '1s',
      maximumBackoff: '60s',
    },
    enableMessageOrdering: true,
    enableExactlyOnceDelivery: true,
  };

  mockResolvedValueOnce(mockStorage.findFirst, null);

  const subscription = await repository.create(subscriptionData);

  // Verify the create call was made with properly serialized data
  expect(mockStorage.create).toHaveBeenCalledWith(
    'pubsub_subscriptions',
    expect.objectContaining({
      name: 'projects/test-project/subscriptions/complex-subscription',
      topic: 'projects/test-project/topics/test-topic',
      labels: JSON.stringify({ env: 'test', version: '1.0' }),
      pushConfig: JSON.stringify({
        pushEndpoint: 'https://example.com/webhook',
        attributes: { key: 'value' },
        oidcToken: {
          serviceAccountEmail: 'test@example.com',
          audience: 'https://example.com',
        },
      }),
      deadLetterPolicy: JSON.stringify({
        deadLetterTopic: 'projects/test-project/topics/dead-letter',
        maxDeliveryAttempts: 10,
      }),
      retryPolicy: JSON.stringify({
        minimumBackoff: '1s',
        maximumBackoff: '60s',
      }),
      enableMessageOrdering: 1,
      enableExactlyOnceDelivery: 1,
      projectId: 'test-project',
      subscriptionId: 'complex-subscription',
      topicId: 'test-topic',
    })
  );

  // Verify the returned object has proper types
  expect(subscription.labels).toEqual({ env: 'test', version: '1.0' });
  expect(subscription.pushConfig).toEqual({
    pushEndpoint: 'https://example.com/webhook',
    attributes: { key: 'value' },
    oidcToken: {
      serviceAccountEmail: 'test@example.com',
      audience: 'https://example.com',
    },
  });
  expect(subscription.deadLetterPolicy).toEqual({
    deadLetterTopic: 'projects/test-project/topics/dead-letter',
    maxDeliveryAttempts: 10,
  });
  expect(subscription.retryPolicy).toEqual({
    minimumBackoff: '1s',
    maximumBackoff: '60s',
  });
  expect(subscription.enableMessageOrdering).toBe(true);
  expect(subscription.enableExactlyOnceDelivery).toBe(true);
});
