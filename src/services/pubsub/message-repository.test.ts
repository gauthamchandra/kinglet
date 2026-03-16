/**
 * Unit tests for MessageRepository
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { MessageRepository } from './message-repository.ts';
import { SubscriptionRepository } from './subscription-repository.ts';
import { TopicRepository } from './topic-repository.ts';
import type { DeliveredMessageRecord, MessageRecord } from './types.ts';
import { AckStatus } from './types.ts';

describe('MessageRepository', () => {
  let storage: StorageManager;
  let topicRepo: TopicRepository;
  let subRepo: SubscriptionRepository;
  let messageRepo: MessageRepository;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    topicRepo = new TopicRepository(storage);
    await topicRepo.initialize();
    subRepo = new SubscriptionRepository(storage);
    await subRepo.initialize();
    messageRepo = new MessageRepository(storage);
    await messageRepo.initialize();

    // Seed a topic and two subscriptions
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
    });

    await subRepo.createSubscription({
      name: 'projects/p/subscriptions/s2',
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
    });
  });

  // ── publishMessages ──

  test('publishMessages inserts messages and fans out to delivered_messages', async () => {
    const subscriptions = ['projects/p/subscriptions/s1', 'projects/p/subscriptions/s2'];

    const messageIds = await messageRepo.publishMessages(
      'projects/p/topics/t',
      [{ data: btoa('hello'), attributes: { key: 'val' } }],
      subscriptions
    );

    expect(messageIds).toHaveLength(1);
    expect(messageIds[0]).toBeTypeOf('string');

    // Verify message record was created
    const messages = await storage.find<MessageRecord>('pubsub_messages', {
      filter: {
        conditions: [{ field: 'topicName', operator: 'eq', value: 'projects/p/topics/t' }],
      },
    });

    expect(messages.data).toHaveLength(1);
    expect(messages.data[0]?.data).toBe(btoa('hello'));

    // Verify delivered_messages for both subscriptions
    const delivered = await storage.find<DeliveredMessageRecord>('pubsub_delivered_messages', {});

    expect(delivered.data).toHaveLength(2);

    const subNames = delivered.data.map(d => d.subscriptionName).sort();

    expect(subNames).toEqual(['projects/p/subscriptions/s1', 'projects/p/subscriptions/s2']);
  });

  test('publishMessages generates unique messageIds', async () => {
    const ids1 = await messageRepo.publishMessages(
      'projects/p/topics/t',
      [{ data: btoa('a') }],
      ['projects/p/subscriptions/s1']
    );

    const ids2 = await messageRepo.publishMessages(
      'projects/p/topics/t',
      [{ data: btoa('b') }],
      ['projects/p/subscriptions/s1']
    );

    expect(ids1[0]).not.toBe(ids2[0]);
  });

  test('publishMessages handles multiple messages in one call', async () => {
    const messageIds = await messageRepo.publishMessages(
      'projects/p/topics/t',
      [{ data: btoa('one') }, { data: btoa('two') }, { data: btoa('three') }],
      ['projects/p/subscriptions/s1']
    );

    expect(messageIds).toHaveLength(3);

    const messages = await storage.find<MessageRecord>('pubsub_messages', {
      filter: {
        conditions: [{ field: 'topicName', operator: 'eq', value: 'projects/p/topics/t' }],
      },
    });

    expect(messages.data).toHaveLength(3);

    // Each message fans out to 1 subscription
    const delivered = await storage.find<DeliveredMessageRecord>('pubsub_delivered_messages', {});

    expect(delivered.data).toHaveLength(3);
  });

  test('publishMessages stores attributes as JSON', async () => {
    await messageRepo.publishMessages(
      'projects/p/topics/t',
      [{ data: btoa('x'), attributes: { env: 'test', version: '1' } }],
      ['projects/p/subscriptions/s1']
    );

    const messages = await storage.find<MessageRecord>('pubsub_messages', {});

    expect(messages.data[0]?.attributes).toBe(JSON.stringify({ env: 'test', version: '1' }));
  });

  test('publishMessages stores orderingKey', async () => {
    await messageRepo.publishMessages(
      'projects/p/topics/t',
      [{ data: btoa('x'), orderingKey: 'order-1' }],
      ['projects/p/subscriptions/s1']
    );

    const messages = await storage.find<MessageRecord>('pubsub_messages', {});

    expect(messages.data[0]?.orderingKey).toBe('order-1');
  });

  test('publishMessages with no subscriptions still creates message records', async () => {
    const messageIds = await messageRepo.publishMessages(
      'projects/p/topics/t',
      [{ data: btoa('orphan') }],
      []
    );

    expect(messageIds).toHaveLength(1);

    const messages = await storage.find<MessageRecord>('pubsub_messages', {});

    expect(messages.data).toHaveLength(1);

    const delivered = await storage.find<DeliveredMessageRecord>('pubsub_delivered_messages', {});

    expect(delivered.data).toHaveLength(0);
  });

  // ── pullMessages ──

  test('pullMessages returns PENDING messages up to maxMessages', async () => {
    await messageRepo.publishMessages(
      'projects/p/topics/t',
      [{ data: btoa('a') }, { data: btoa('b') }, { data: btoa('c') }],
      ['projects/p/subscriptions/s1']
    );

    const pulled = await messageRepo.pullMessages('projects/p/subscriptions/s1', 2, 10);

    expect(pulled).toHaveLength(2);
    expect(pulled[0]?.ackId).toBeTypeOf('string');
    expect(pulled[0]?.message.data).toBeTypeOf('string');
    expect(pulled[0]?.message.messageId).toBeTypeOf('string');
    expect(pulled[0]?.message.publishTime).toBeTypeOf('string');
  });

  test('pullMessages extends ackDeadline on pulled messages', async () => {
    await messageRepo.publishMessages(
      'projects/p/topics/t',
      [{ data: btoa('x') }],
      ['projects/p/subscriptions/s1']
    );

    const pulled = await messageRepo.pullMessages('projects/p/subscriptions/s1', 10, 30);

    expect(pulled).toHaveLength(1);

    // The ackDeadline should be roughly 30 seconds from now
    const delivered = await storage.find<DeliveredMessageRecord>('pubsub_delivered_messages', {
      filter: {
        conditions: [
          { field: 'subscriptionName', operator: 'eq', value: 'projects/p/subscriptions/s1' },
        ],
      },
    });

    const deadline = new Date(delivered.data[0]?.ackDeadline ?? '');
    const expectedMin = new Date(Date.now() + 25_000); // allow 5s tolerance

    expect(deadline.getTime()).toBeGreaterThan(expectedMin.getTime());
  });

  test('pullMessages returns empty when no messages available', async () => {
    const pulled = await messageRepo.pullMessages('projects/p/subscriptions/s1', 10, 10);

    expect(pulled).toHaveLength(0);
  });

  test('pullMessages does not return already-acked messages', async () => {
    await messageRepo.publishMessages(
      'projects/p/topics/t',
      [{ data: btoa('a') }],
      ['projects/p/subscriptions/s1']
    );

    const pulled = await messageRepo.pullMessages('projects/p/subscriptions/s1', 10, 10);

    expect(pulled).toHaveLength(1);

    await messageRepo.acknowledgeMessages('projects/p/subscriptions/s1', [pulled[0]?.ackId ?? '']);

    const pulled2 = await messageRepo.pullMessages('projects/p/subscriptions/s1', 10, 10);

    expect(pulled2).toHaveLength(0);
  });

  test('pullMessages re-delivers messages with expired ackDeadline', async () => {
    await messageRepo.publishMessages(
      'projects/p/topics/t',
      [{ data: btoa('retry-me') }],
      ['projects/p/subscriptions/s1']
    );

    // Pull with a very short deadline
    const pulled1 = await messageRepo.pullMessages('projects/p/subscriptions/s1', 10, 1);

    expect(pulled1).toHaveLength(1);

    // Manually expire the deadline
    const deliveredRecords = await storage.find<DeliveredMessageRecord>(
      'pubsub_delivered_messages',
      {
        filter: {
          conditions: [
            { field: 'subscriptionName', operator: 'eq', value: 'projects/p/subscriptions/s1' },
          ],
        },
      }
    );

    const record = deliveredRecords.data[0];

    if (record) {
      await storage.updateById<DeliveredMessageRecord>('pubsub_delivered_messages', record.id, {
        ackDeadline: new Date(Date.now() - 1000).toISOString(),
      });
    }

    // Pull again - should re-deliver the expired message
    const pulled2 = await messageRepo.pullMessages('projects/p/subscriptions/s1', 10, 10);

    expect(pulled2).toHaveLength(1);
  });

  test('pullMessages increments deliveryAttempt on re-delivery', async () => {
    await messageRepo.publishMessages(
      'projects/p/topics/t',
      [{ data: btoa('retry') }],
      ['projects/p/subscriptions/s1']
    );

    const pulled1 = await messageRepo.pullMessages('projects/p/subscriptions/s1', 10, 1);

    expect(pulled1[0]?.deliveryAttempt).toBe(1);

    // Expire the deadline
    const records = await storage.find<DeliveredMessageRecord>('pubsub_delivered_messages', {
      filter: {
        conditions: [
          { field: 'subscriptionName', operator: 'eq', value: 'projects/p/subscriptions/s1' },
        ],
      },
    });

    if (records.data[0]) {
      await storage.updateById<DeliveredMessageRecord>(
        'pubsub_delivered_messages',
        records.data[0].id,
        { ackDeadline: new Date(Date.now() - 1000).toISOString() }
      );
    }

    const pulled2 = await messageRepo.pullMessages('projects/p/subscriptions/s1', 10, 10);

    expect(pulled2[0]?.deliveryAttempt).toBe(2);
  });

  // ── acknowledgeMessages ──

  test('acknowledgeMessages marks messages as ACKED', async () => {
    await messageRepo.publishMessages(
      'projects/p/topics/t',
      [{ data: btoa('ack-me') }],
      ['projects/p/subscriptions/s1']
    );

    const pulled = await messageRepo.pullMessages('projects/p/subscriptions/s1', 10, 10);
    const ackId = pulled[0]?.ackId ?? '';

    await messageRepo.acknowledgeMessages('projects/p/subscriptions/s1', [ackId]);

    const delivered = await storage.find<DeliveredMessageRecord>('pubsub_delivered_messages', {
      filter: {
        conditions: [{ field: 'ackId', operator: 'eq', value: ackId }],
      },
    });

    expect(delivered.data[0]?.ackStatus).toBe(AckStatus.ACKED);
  });

  test('acknowledgeMessages handles multiple ackIds', async () => {
    await messageRepo.publishMessages(
      'projects/p/topics/t',
      [{ data: btoa('a') }, { data: btoa('b') }],
      ['projects/p/subscriptions/s1']
    );

    const pulled = await messageRepo.pullMessages('projects/p/subscriptions/s1', 10, 10);
    const ackIds = pulled.map(p => p.ackId);

    await messageRepo.acknowledgeMessages('projects/p/subscriptions/s1', ackIds);

    const pending = await storage.find<DeliveredMessageRecord>('pubsub_delivered_messages', {
      filter: {
        conditions: [
          { field: 'subscriptionName', operator: 'eq', value: 'projects/p/subscriptions/s1' },
          { field: 'ackStatus', operator: 'eq', value: AckStatus.PENDING },
        ],
      },
    });

    expect(pending.data).toHaveLength(0);
  });

  // ── modifyAckDeadline ──

  test('modifyAckDeadline updates deadline for specified ackIds', async () => {
    await messageRepo.publishMessages(
      'projects/p/topics/t',
      [{ data: btoa('deadline') }],
      ['projects/p/subscriptions/s1']
    );

    const pulled = await messageRepo.pullMessages('projects/p/subscriptions/s1', 10, 10);
    const ackId = pulled[0]?.ackId ?? '';

    await messageRepo.modifyAckDeadline('projects/p/subscriptions/s1', [ackId], 120);

    const delivered = await storage.find<DeliveredMessageRecord>('pubsub_delivered_messages', {
      filter: { conditions: [{ field: 'ackId', operator: 'eq', value: ackId }] },
    });

    const deadline = new Date(delivered.data[0]?.ackDeadline ?? '');
    const expectedMin = new Date(Date.now() + 115_000); // 120s minus 5s tolerance

    expect(deadline.getTime()).toBeGreaterThan(expectedMin.getTime());
  });

  test('modifyAckDeadline with 0 seconds nacks the message', async () => {
    await messageRepo.publishMessages(
      'projects/p/topics/t',
      [{ data: btoa('nack') }],
      ['projects/p/subscriptions/s1']
    );

    const pulled = await messageRepo.pullMessages('projects/p/subscriptions/s1', 10, 30);
    const ackId = pulled[0]?.ackId ?? '';

    // Setting deadline to 0 should make the message immediately re-deliverable
    await messageRepo.modifyAckDeadline('projects/p/subscriptions/s1', [ackId], 0);

    const delivered = await storage.find<DeliveredMessageRecord>('pubsub_delivered_messages', {
      filter: { conditions: [{ field: 'ackId', operator: 'eq', value: ackId }] },
    });

    const deadline = new Date(delivered.data[0]?.ackDeadline ?? '');

    expect(deadline.getTime()).toBeLessThanOrEqual(Date.now());
  });

  // ── deleteMessagesBySubscription ──

  test('deleteMessagesBySubscription removes all delivered messages for a subscription', async () => {
    await messageRepo.publishMessages(
      'projects/p/topics/t',
      [{ data: btoa('a') }, { data: btoa('b') }],
      ['projects/p/subscriptions/s1', 'projects/p/subscriptions/s2']
    );

    await messageRepo.deleteMessagesBySubscription('projects/p/subscriptions/s1');

    const s1 = await storage.find<DeliveredMessageRecord>('pubsub_delivered_messages', {
      filter: {
        conditions: [
          { field: 'subscriptionName', operator: 'eq', value: 'projects/p/subscriptions/s1' },
        ],
      },
    });

    expect(s1.data).toHaveLength(0);

    // s2 should still have its messages
    const s2 = await storage.find<DeliveredMessageRecord>('pubsub_delivered_messages', {
      filter: {
        conditions: [
          { field: 'subscriptionName', operator: 'eq', value: 'projects/p/subscriptions/s2' },
        ],
      },
    });

    expect(s2.data).toHaveLength(2);
  });

  // ── push delivery queries ──

  describe('findPushDeliverableMessages', () => {
    test('returns PENDING messages with expired ackDeadline for a subscription', async () => {
      await messageRepo.publishMessages(
        'projects/p/topics/t',
        [{ data: btoa('push-me') }],
        ['projects/p/subscriptions/s1']
      );

      const results = await messageRepo.findPushDeliverableMessages(
        'projects/p/subscriptions/s1',
        10
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.delivered.ackStatus).toBe(AckStatus.PENDING);
      expect(results[0]?.message.data).toBe(btoa('push-me'));
    });

    test('excludes ACKED messages', async () => {
      await messageRepo.publishMessages(
        'projects/p/topics/t',
        [{ data: btoa('acked') }],
        ['projects/p/subscriptions/s1']
      );

      // Pull and ack the message
      const pulled = await messageRepo.pullMessages('projects/p/subscriptions/s1', 10, 10);

      await messageRepo.acknowledgeMessages('projects/p/subscriptions/s1', [
        pulled[0]?.ackId ?? '',
      ]);

      const results = await messageRepo.findPushDeliverableMessages(
        'projects/p/subscriptions/s1',
        10
      );

      expect(results).toHaveLength(0);
    });

    test('excludes messages with future ackDeadline', async () => {
      await messageRepo.publishMessages(
        'projects/p/topics/t',
        [{ data: btoa('not-yet') }],
        ['projects/p/subscriptions/s1']
      );

      // Pull to set a future deadline
      await messageRepo.pullMessages('projects/p/subscriptions/s1', 10, 60);

      const results = await messageRepo.findPushDeliverableMessages(
        'projects/p/subscriptions/s1',
        10
      );

      expect(results).toHaveLength(0);
    });

    test('returns messages for the correct subscription only', async () => {
      await messageRepo.publishMessages(
        'projects/p/topics/t',
        [{ data: btoa('fan-out') }],
        ['projects/p/subscriptions/s1', 'projects/p/subscriptions/s2']
      );

      const results = await messageRepo.findPushDeliverableMessages(
        'projects/p/subscriptions/s1',
        10
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.delivered.subscriptionName).toBe('projects/p/subscriptions/s1');
    });

    test('respects limit parameter', async () => {
      await messageRepo.publishMessages(
        'projects/p/topics/t',
        [{ data: btoa('a') }, { data: btoa('b') }, { data: btoa('c') }],
        ['projects/p/subscriptions/s1']
      );

      const results = await messageRepo.findPushDeliverableMessages(
        'projects/p/subscriptions/s1',
        2
      );

      expect(results).toHaveLength(2);
    });
  });

  describe('incrementDeliveryAttempt', () => {
    test('bumps attempt count and sets new ackDeadline', async () => {
      await messageRepo.publishMessages(
        'projects/p/topics/t',
        [{ data: btoa('retry') }],
        ['projects/p/subscriptions/s1']
      );

      const deliverable = await messageRepo.findPushDeliverableMessages(
        'projects/p/subscriptions/s1',
        10
      );

      const dm = deliverable[0]?.delivered;

      expect(dm).toBeDefined();
      expect(dm?.deliveryAttempt).toBe(0);

      const futureDeadline = new Date(Date.now() + 30_000).toISOString();

      expect(dm).toBeDefined();
      const dmRecord = dm as DeliveredMessageRecord;

      await messageRepo.incrementDeliveryAttempt(dmRecord.id, futureDeadline);

      const updated = await storage.find<DeliveredMessageRecord>('pubsub_delivered_messages', {
        filter: {
          conditions: [{ field: 'ackId', operator: 'eq', value: dmRecord.ackId }],
        },
      });

      expect(updated.data[0]?.deliveryAttempt).toBe(1);
      expect(new Date(updated.data[0]?.ackDeadline ?? '').getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('cleanupAckedMessages', () => {
    test('removes ACKED delivered_message rows', async () => {
      await messageRepo.publishMessages(
        'projects/p/topics/t',
        [{ data: btoa('clean-me') }, { data: btoa('keep-me') }],
        ['projects/p/subscriptions/s1']
      );

      // Pull and ack only the first message
      const pulled = await messageRepo.pullMessages('projects/p/subscriptions/s1', 10, 10);

      await messageRepo.acknowledgeMessages('projects/p/subscriptions/s1', [
        pulled[0]?.ackId ?? '',
      ]);

      const cleaned = await messageRepo.cleanupAckedMessages();

      expect(cleaned).toBe(1);

      // Only one PENDING message should remain
      const remaining = await storage.find<DeliveredMessageRecord>('pubsub_delivered_messages', {
        filter: {
          conditions: [
            { field: 'subscriptionName', operator: 'eq', value: 'projects/p/subscriptions/s1' },
          ],
        },
      });

      expect(remaining.data).toHaveLength(1);
      expect(remaining.data[0]?.ackStatus).toBe(AckStatus.PENDING);
    });

    test('returns 0 when nothing to clean', async () => {
      const cleaned = await messageRepo.cleanupAckedMessages();

      expect(cleaned).toBe(0);
    });
  });

  // ── resetDeliveredMessagesByTime (seek support) ──

  describe('resetDeliveredMessagesByTime', () => {
    test('resets PENDING messages with publishTime <= seekTime to re-deliverable', async () => {
      await messageRepo.publishMessages(
        'projects/p/topics/t',
        [{ data: btoa('old-msg') }],
        ['projects/p/subscriptions/s1']
      );

      // Pull to set a future deadline
      const pulled = await messageRepo.pullMessages('projects/p/subscriptions/s1', 10, 60);

      expect(pulled).toHaveLength(1);

      // Seek to a time after the message was published
      const seekTime = new Date(Date.now() + 1000).toISOString();
      const count = await messageRepo.resetDeliveredMessagesByTime(
        'projects/p/subscriptions/s1',
        seekTime
      );

      expect(count).toBeGreaterThan(0);

      // Should be re-deliverable now
      const rePulled = await messageRepo.pullMessages('projects/p/subscriptions/s1', 10, 10);

      expect(rePulled).toHaveLength(1);
    });

    test('does not affect ACKED messages', async () => {
      await messageRepo.publishMessages(
        'projects/p/topics/t',
        [{ data: btoa('acked-msg') }],
        ['projects/p/subscriptions/s1']
      );

      const pulled = await messageRepo.pullMessages('projects/p/subscriptions/s1', 10, 10);

      await messageRepo.acknowledgeMessages('projects/p/subscriptions/s1', [
        pulled[0]?.ackId ?? '',
      ]);

      const seekTime = new Date(Date.now() + 1000).toISOString();
      const count = await messageRepo.resetDeliveredMessagesByTime(
        'projects/p/subscriptions/s1',
        seekTime
      );

      expect(count).toBe(0);
    });

    test('does not affect messages published after seekTime', async () => {
      // Publish message
      await messageRepo.publishMessages(
        'projects/p/topics/t',
        [{ data: btoa('future-msg') }],
        ['projects/p/subscriptions/s1']
      );

      // Pull to set a future deadline
      await messageRepo.pullMessages('projects/p/subscriptions/s1', 10, 60);

      // Seek to a time before the message was published
      const seekTime = new Date(Date.now() - 60_000).toISOString();
      const count = await messageRepo.resetDeliveredMessagesByTime(
        'projects/p/subscriptions/s1',
        seekTime
      );

      expect(count).toBe(0);
    });
  });

  // ── deleteMessagesByTopic ──

  test('deleteMessagesByTopic removes all messages and deliveries for a topic', async () => {
    await messageRepo.publishMessages(
      'projects/p/topics/t',
      [{ data: btoa('a') }],
      ['projects/p/subscriptions/s1', 'projects/p/subscriptions/s2']
    );

    await messageRepo.deleteMessagesByTopic('projects/p/topics/t');

    const messages = await storage.find<MessageRecord>('pubsub_messages', {
      filter: {
        conditions: [{ field: 'topicName', operator: 'eq', value: 'projects/p/topics/t' }],
      },
    });

    expect(messages.data).toHaveLength(0);
  });
});
