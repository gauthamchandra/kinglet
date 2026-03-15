/**
 * Message Repository - persistence layer for Pub/Sub messages and delivery tracking
 *
 * Implements the two-table fan-out model from ADR-005:
 * - pubsub_messages: immutable, topic-scoped message storage
 * - pubsub_delivered_messages: mutable, subscription-scoped delivery tracking
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { DeliveredMessageRecord, MessageRecord, ReceivedMessageResponse } from './types.ts';
import {
  AckStatus,
  PUBSUB_DELIVERED_MESSAGES_TABLE,
  PUBSUB_MESSAGES_TABLE,
  pubsubDeliveredMessagesTableSchema,
  pubsubMessagesTableSchema,
} from './types.ts';

export interface PublishMessageInput {
  data?: string | undefined;
  attributes?: Record<string, string> | undefined;
  orderingKey?: string | undefined;
}

export class MessageRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(PUBSUB_MESSAGES_TABLE, pubsubMessagesTableSchema);
    await this.storage.createTable(
      PUBSUB_DELIVERED_MESSAGES_TABLE,
      pubsubDeliveredMessagesTableSchema
    );
  }

  async publishMessages(
    topicName: string,
    messages: PublishMessageInput[],
    subscriptionNames: string[]
  ): Promise<string[]> {
    const now = new Date().toISOString();
    const messageIds: string[] = [];

    for (const msg of messages) {
      const messageId = crypto.randomUUID();
      messageIds.push(messageId);

      await this.storage.create<MessageRecord>(PUBSUB_MESSAGES_TABLE, {
        messageId,
        topicName,
        data: msg.data ?? null,
        attributes: msg.attributes ? JSON.stringify(msg.attributes) : null,
        orderingKey: msg.orderingKey ?? null,
        publishTime: now,
      });

      // Fan out to each subscription
      for (const subName of subscriptionNames) {
        const ackId = crypto.randomUUID();

        await this.storage.create<DeliveredMessageRecord>(PUBSUB_DELIVERED_MESSAGES_TABLE, {
          ackId,
          subscriptionName: subName,
          messageId,
          deliveryAttempt: 0,
          ackDeadline: new Date(0).toISOString(), // Not yet pulled
          ackStatus: AckStatus.PENDING,
        });
      }
    }

    return messageIds;
  }

  async pullMessages(
    subscriptionName: string,
    maxMessages: number,
    ackDeadlineSeconds: number
  ): Promise<ReceivedMessageResponse[]> {
    const now = new Date();

    // Find PENDING messages that either haven't been pulled yet (deadline in the past)
    // or whose ack deadline has expired
    const delivered = await this.storage.find<DeliveredMessageRecord>(
      PUBSUB_DELIVERED_MESSAGES_TABLE,
      {
        filter: {
          conditions: [
            { field: 'subscriptionName', operator: 'eq', value: subscriptionName },
            { field: 'ackStatus', operator: 'eq', value: AckStatus.PENDING },
          ],
        },
        pagination: { limit: maxMessages, offset: 0 },
      }
    );

    // Filter to only messages with expired deadlines (or never pulled)
    const eligible = delivered.data.filter(d => new Date(d.ackDeadline) <= now);

    const results: ReceivedMessageResponse[] = [];

    for (const dm of eligible) {
      // Fetch the original message
      const message = await this.storage.findFirst<MessageRecord>(PUBSUB_MESSAGES_TABLE, {
        filter: {
          conditions: [{ field: 'messageId', operator: 'eq', value: dm.messageId }],
        },
      });

      if (!message) continue;

      const newDeadline = new Date(now.getTime() + ackDeadlineSeconds * 1000).toISOString();
      const newDeliveryAttempt = dm.deliveryAttempt + 1;

      // Update delivery tracking
      await this.storage.updateById<DeliveredMessageRecord>(
        PUBSUB_DELIVERED_MESSAGES_TABLE,
        dm.id,
        {
          ackDeadline: newDeadline,
          deliveryAttempt: newDeliveryAttempt,
        }
      );

      const receivedMessage: ReceivedMessageResponse = {
        ackId: dm.ackId,
        message: {
          messageId: message.messageId,
          publishTime: message.publishTime,
        },
        deliveryAttempt: newDeliveryAttempt,
      };

      if (message.data != null) {
        receivedMessage.message.data = message.data;
      }

      if (message.attributes) {
        receivedMessage.message.attributes = JSON.parse(message.attributes) as Record<
          string,
          string
        >;
      }

      if (message.orderingKey) {
        receivedMessage.message.orderingKey = message.orderingKey;
      }

      results.push(receivedMessage);
    }

    return results;
  }

  async acknowledgeMessages(subscriptionName: string, ackIds: string[]): Promise<void> {
    for (const ackId of ackIds) {
      await this.storage.updateMany<DeliveredMessageRecord>(
        PUBSUB_DELIVERED_MESSAGES_TABLE,
        {
          conditions: [
            { field: 'ackId', operator: 'eq', value: ackId },
            { field: 'subscriptionName', operator: 'eq', value: subscriptionName },
          ],
        },
        { ackStatus: AckStatus.ACKED }
      );
    }
  }

  async modifyAckDeadline(
    subscriptionName: string,
    ackIds: string[],
    ackDeadlineSeconds: number
  ): Promise<void> {
    const newDeadline = new Date(Date.now() + ackDeadlineSeconds * 1000).toISOString();

    for (const ackId of ackIds) {
      await this.storage.updateMany<DeliveredMessageRecord>(
        PUBSUB_DELIVERED_MESSAGES_TABLE,
        {
          conditions: [
            { field: 'ackId', operator: 'eq', value: ackId },
            { field: 'subscriptionName', operator: 'eq', value: subscriptionName },
          ],
        },
        { ackDeadline: newDeadline }
      );
    }
  }

  async findPushDeliverableMessages(
    subscriptionName: string,
    limit: number
  ): Promise<Array<{ delivered: DeliveredMessageRecord; message: MessageRecord }>> {
    const now = new Date().toISOString();

    const delivered = await this.storage.find<DeliveredMessageRecord>(
      PUBSUB_DELIVERED_MESSAGES_TABLE,
      {
        filter: {
          conditions: [
            { field: 'subscriptionName', operator: 'eq', value: subscriptionName },
            { field: 'ackStatus', operator: 'eq', value: AckStatus.PENDING },
          ],
        },
        pagination: { limit, offset: 0 },
      }
    );

    // Filter to only messages with expired deadlines (or never pulled)
    const eligible = delivered.data.filter(d => d.ackDeadline <= now);

    const results: Array<{ delivered: DeliveredMessageRecord; message: MessageRecord }> = [];

    for (const dm of eligible) {
      const message = await this.storage.findFirst<MessageRecord>(PUBSUB_MESSAGES_TABLE, {
        filter: {
          conditions: [{ field: 'messageId', operator: 'eq', value: dm.messageId }],
        },
      });

      if (message) {
        results.push({ delivered: dm, message });
      }
    }

    return results;
  }

  async incrementDeliveryAttempt(
    deliveredMessageId: string,
    newAckDeadline: string
  ): Promise<void> {
    const existing = await this.storage.find<DeliveredMessageRecord>(
      PUBSUB_DELIVERED_MESSAGES_TABLE,
      {
        filter: {
          conditions: [{ field: 'id', operator: 'eq', value: deliveredMessageId }],
        },
      }
    );

    const record = existing.data[0];

    if (!record) return;

    await this.storage.updateById<DeliveredMessageRecord>(
      PUBSUB_DELIVERED_MESSAGES_TABLE,
      deliveredMessageId,
      {
        deliveryAttempt: record.deliveryAttempt + 1,
        ackDeadline: newAckDeadline,
      }
    );
  }

  async cleanupAckedMessages(): Promise<number> {
    const acked = await this.storage.find<DeliveredMessageRecord>(PUBSUB_DELIVERED_MESSAGES_TABLE, {
      filter: {
        conditions: [{ field: 'ackStatus', operator: 'eq', value: AckStatus.ACKED }],
      },
    });

    const count = acked.data.length;

    if (count > 0) {
      await this.storage.deleteMany(PUBSUB_DELIVERED_MESSAGES_TABLE, {
        conditions: [{ field: 'ackStatus', operator: 'eq', value: AckStatus.ACKED }],
      });
    }

    return count;
  }

  async resetDeliveredMessagesByTime(
    subscriptionName: string,
    beforeTime: string
  ): Promise<number> {
    // Find all PENDING delivered messages for this subscription
    const delivered = await this.storage.find<DeliveredMessageRecord>(
      PUBSUB_DELIVERED_MESSAGES_TABLE,
      {
        filter: {
          conditions: [
            { field: 'subscriptionName', operator: 'eq', value: subscriptionName },
            { field: 'ackStatus', operator: 'eq', value: AckStatus.PENDING },
          ],
        },
      }
    );

    let resetCount = 0;

    for (const dm of delivered.data) {
      // Look up the original message to check publishTime
      const message = await this.storage.findFirst<MessageRecord>(PUBSUB_MESSAGES_TABLE, {
        filter: {
          conditions: [{ field: 'messageId', operator: 'eq', value: dm.messageId }],
        },
      });

      if (message && message.publishTime <= beforeTime) {
        // Reset ackDeadline to epoch to make it re-deliverable
        await this.storage.updateById<DeliveredMessageRecord>(
          PUBSUB_DELIVERED_MESSAGES_TABLE,
          dm.id,
          { ackDeadline: new Date(0).toISOString() }
        );

        resetCount++;
      }
    }

    return resetCount;
  }

  async deleteMessagesBySubscription(subscriptionName: string): Promise<void> {
    await this.storage.deleteMany(PUBSUB_DELIVERED_MESSAGES_TABLE, {
      conditions: [{ field: 'subscriptionName', operator: 'eq', value: subscriptionName }],
    });
  }

  async deleteMessagesByTopic(topicName: string): Promise<void> {
    // Delete all message records for this topic
    await this.storage.deleteMany(PUBSUB_MESSAGES_TABLE, {
      conditions: [{ field: 'topicName', operator: 'eq', value: topicName }],
    });

    // Note: delivered_messages reference messageId, but we clean those up
    // when subscriptions are deleted or via the delivery engine
  }
}
