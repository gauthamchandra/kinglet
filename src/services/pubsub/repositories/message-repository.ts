/**
 * Message Repository
 *
 * This module provides data access operations for Pub/Sub messages,
 * implementing the repository pattern for message management with support
 * for message publishing, acknowledgment, and delivery tracking.
 */

import { randomUUID } from 'node:crypto';
import type { IRepository, IStorageManager } from '@/core/storage/interfaces.js';
import type {
  QueryCondition,
  QueryOptions,
  QueryResult,
  QueryFilter,
} from '@/core/storage/types.js';
import { ValidationError } from '@/core/storage/types.js';
import type { MessageRecord, SubscriptionLeaseRecord } from '../models.js';
import { PubSubResourceNames, MESSAGES_SCHEMA, SUBSCRIPTION_LEASES_SCHEMA } from '../models.js';

/**
 * Message creation data (without BaseRecord fields)
 */
export interface CreateMessageData {
  /** Unique message ID */
  readonly messageId: string;
  /** Topic name where message was published */
  readonly topic: string;
  /** Message data (Base64 encoded) */
  readonly data?: string;
  /** Message attributes */
  readonly attributes?: Record<string, string>;
  /** Message publish time */
  readonly publishTime?: Date;
  /** Ordering key for message ordering */
  readonly orderingKey?: string;
  /** Message size in bytes */
  readonly size: number;
  /** Message expiration time */
  readonly expirationTime?: Date;
}

/**
 * Message update data (partial fields for updates)
 */
export interface UpdateMessageData {
  /** Number of delivery attempts */
  readonly deliveryAttempts?: number | undefined;
  /** Whether message is acknowledged */
  readonly acknowledged?: boolean | undefined;
  /** Acknowledgment ID for tracking */
  readonly ackId?: string | undefined;
  /** Time when message was acknowledged */
  readonly acknowledgedAt?: Date | undefined;
}

/**
 * Message query filters
 */
export interface MessageQueryOptions extends QueryOptions {
  /** Filter by project ID */
  readonly projectId?: string;
  /** Filter by topic */
  readonly topic?: string;
  /** Filter by topic ID */
  readonly topicId?: string;
  /** Filter by acknowledgment status */
  readonly acknowledged?: boolean;
  /** Filter by ordering key */
  readonly orderingKey?: string;
  /** Filter by messages that have not expired */
  readonly notExpired?: boolean;
  /** Filter by publish time range */
  readonly publishTimeAfter?: Date;
  readonly publishTimeBefore?: Date;
  /** Limit the number of results (convenience property) */
  readonly limit?: number | undefined;
  /** Offset for pagination (convenience property) */
  readonly offset?: number | undefined;
  /** Where conditions (convenience property for filter) */
  readonly where?: QueryCondition[] | undefined;
}

/**
 * Subscription lease creation data
 */
export interface CreateSubscriptionLeaseData {
  /** Message ID being leased */
  readonly messageId: string;
  /** Subscription name that has the lease */
  readonly subscriptionName: string;
  /** Acknowledgment ID for the lease */
  readonly ackId: string;
  /** Lease deadline timestamp */
  readonly leaseDeadline: Date;
  /** Number of delivery attempts for this lease */
  readonly deliveryAttempts?: number;
}

/**
 * Message Repository Implementation
 */
export class MessageRepository implements IRepository<MessageRecord> {
  private readonly messagesTableName = MESSAGES_SCHEMA.name;
  private readonly leasesTableName = SUBSCRIPTION_LEASES_SCHEMA.name;

  constructor(private readonly storage: IStorageManager) {}

  /**
   * Initialize the repository by creating tables if needed
   */
  async initialize(): Promise<void> {
    await this.storage.createTable(this.messagesTableName, MESSAGES_SCHEMA);
    await this.storage.createTable(this.leasesTableName, SUBSCRIPTION_LEASES_SCHEMA);
  }

  /**
   * Create a new message
   */
  async create(data: CreateMessageData): Promise<MessageRecord> {
    // Validate topic name format
    this.validateTopicName(data.topic);

    // Parse topic name to extract project and topic IDs
    const { projectId, topicId } = PubSubResourceNames.parseTopic(data.topic);

    const now = new Date();
    const message: MessageRecord = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      messageId: data.messageId,
      topic: data.topic,
      data: data.data,
      attributes: data.attributes ?? {},
      publishTime: data.publishTime ?? now,
      orderingKey: data.orderingKey,
      size: data.size,
      deliveryAttempts: 0,
      expirationTime: data.expirationTime,
      acknowledged: false,
      projectId,
      topicId,
    };

    // Prepare data for storage (convert complex objects to JSON strings)
    const storageData = this.prepareMessageForStorage(message);

    await this.storage.create(this.messagesTableName, storageData);

    return message;
  }

  /**
   * Find a message by ID
   */
  async findById(id: string): Promise<MessageRecord | null> {
    const result = await this.storage.findById(this.messagesTableName, id);

    return result ? this.convertMessageFromStorage(result) : null;
  }

  /**
   * Find a message by message ID
   */
  async findByMessageId(messageId: string): Promise<MessageRecord | null> {
    const result = await this.storage.findFirst(this.messagesTableName, {
      filter: {
        conditions: [{ field: 'messageId', operator: 'eq', value: messageId }],
        operator: 'and',
      },
    });

    return result ? this.convertMessageFromStorage(result) : null;
  }

  /**
   * Find messages matching criteria
   */
  async find(options: MessageQueryOptions = {}): Promise<QueryResult<MessageRecord>> {
    const conditions = this.buildMessageWhereClause(options);
    const queryOptions: QueryOptions = {
      ...options,
      filter:
        conditions.length > 0
          ? {
              conditions,
              operator: 'and',
            }
          : undefined,
    };

    const result = await this.storage.find(this.messagesTableName, queryOptions);

    if (!result?.data) {
      return {
        data: [],
        total: 0,
        hasMore: false,
      };
    }

    return {
      data: result.data.map(item => this.convertMessageFromStorage(item)),
      total: result.total ?? 0,
      hasMore: result.hasMore ?? false,
    };
  }

  /**
   * Find messages for a specific topic
   */
  async findByTopic(
    topicName: string,
    options: QueryOptions = {}
  ): Promise<QueryResult<MessageRecord>> {
    return this.find({ ...options, topic: topicName });
  }

  /**
   * Find unacknowledged messages for a topic
   */
  async findUnacknowledgedByTopic(
    topicName: string,
    options: QueryOptions = {}
  ): Promise<QueryResult<MessageRecord>> {
    return this.find({ ...options, topic: topicName, acknowledged: false });
  }

  /**
   * Find messages available for delivery (not expired, not acknowledged)
   */
  async findAvailableMessages(
    options: MessageQueryOptions = {}
  ): Promise<QueryResult<MessageRecord>> {
    return this.find({ ...options, acknowledged: false, notExpired: true });
  }

  /**
   * Find expired messages
   */
  async findExpiredMessages(
    options: MessageQueryOptions = {}
  ): Promise<QueryResult<MessageRecord>> {
    const now = new Date();

    return this.find({
      ...options,
      publishTimeBefore: now,
      // Custom WHERE clause for expiration check will be added by buildMessageWhereClause
    });
  }

  /**
   * Find first message matching criteria
   */
  async findFirst(options: MessageQueryOptions = {}): Promise<MessageRecord | null> {
    const result = await this.find({ ...options, limit: 1 });

    return result.data[0] || null;
  }

  /**
   * Update a message by ID
   */
  async updateById(id: string, data: UpdateMessageData): Promise<MessageRecord | null> {
    const existingMessage = await this.findById(id);

    if (!existingMessage) {
      return null;
    }

    const updatedMessage: MessageRecord = {
      ...existingMessage,
      ...(data.deliveryAttempts !== undefined && { deliveryAttempts: data.deliveryAttempts }),
      ...(data.acknowledged !== undefined && { acknowledged: data.acknowledged }),
      ...(data.ackId !== undefined && { ackId: data.ackId }),
      ...(data.acknowledgedAt !== undefined && { acknowledgedAt: data.acknowledgedAt }),
      updatedAt: new Date(),
    };

    // Prepare only the updated fields for storage, converting types as needed
    const updateData: Record<string, unknown> = {
      updatedAt: updatedMessage.updatedAt.toISOString(),
    };

    if (data.deliveryAttempts !== undefined) {
      updateData.deliveryAttempts = data.deliveryAttempts;
    }
    if (data.acknowledged !== undefined) {
      updateData.acknowledged = data.acknowledged ? 1 : 0;
    }
    if (data.ackId !== undefined) {
      updateData.ackId = data.ackId;
    }
    if (data.acknowledgedAt !== undefined) {
      updateData.acknowledgedAt = data.acknowledgedAt.toISOString();
    }

    await this.storage.updateById(this.messagesTableName, id, updateData);

    return updatedMessage;
  }

  /**
   * Update a message by message ID
   */
  async updateByMessageId(
    messageId: string,
    data: UpdateMessageData
  ): Promise<MessageRecord | null> {
    const message = await this.findByMessageId(messageId);

    if (!message) {
      return null;
    }

    return this.updateById(message.id, data);
  }

  /**
   * Acknowledge a message
   */
  async acknowledgeMessage(messageId: string, ackId?: string): Promise<MessageRecord | null> {
    const updateData: UpdateMessageData = {
      acknowledged: true,
      ackId,
      acknowledgedAt: new Date(),
    };

    return this.updateByMessageId(messageId, updateData);
  }

  /**
   * Increment delivery attempts for a message
   */
  async incrementDeliveryAttempts(messageId: string): Promise<MessageRecord | null> {
    const message = await this.findByMessageId(messageId);

    if (!message) {
      return null;
    }

    const updateData: UpdateMessageData = {
      deliveryAttempts: message.deliveryAttempts + 1,
    };

    return this.updateById(message.id, updateData);
  }

  /**
   * Delete a message by ID
   */
  async deleteById(id: string): Promise<boolean> {
    return this.storage.deleteById(this.messagesTableName, id);
  }

  /**
   * Delete a message by message ID
   */
  async deleteByMessageId(messageId: string): Promise<boolean> {
    const message = await this.findByMessageId(messageId);

    if (!message) {
      return false;
    }

    return this.deleteById(message.id);
  }

  /**
   * Delete expired messages
   */
  async deleteExpiredMessages(): Promise<number> {
    const expiredMessages = await this.findExpiredMessages();
    let deletedCount = 0;

    for (const message of expiredMessages.data) {
      const deleted = await this.deleteById(message.id);

      if (deleted) {
        deletedCount++;
      }
    }

    return deletedCount;
  }

  /**
   * Delete acknowledged messages older than retention period
   */
  async deleteOldAcknowledgedMessages(retentionPeriodMs: number): Promise<number> {
    const cutoffTime = new Date(Date.now() - retentionPeriodMs);
    const oldMessages = await this.find({
      acknowledged: true,
      publishTimeBefore: cutoffTime,
    });

    let deletedCount = 0;

    for (const message of oldMessages.data) {
      const deleted = await this.deleteById(message.id);

      if (deleted) {
        deletedCount++;
      }
    }

    return deletedCount;
  }

  /**
   * Check if a message exists by ID
   */
  async exists(id: string): Promise<boolean> {
    return this.storage.exists(this.messagesTableName, id);
  }

  /**
   * Check if a message exists by message ID
   */
  async existsByMessageId(messageId: string): Promise<boolean> {
    const message = await this.findByMessageId(messageId);

    return message !== null;
  }

  /**
   * Count messages matching criteria
   */
  async count(options: MessageQueryOptions = {}): Promise<number> {
    const conditions = this.buildMessageWhereClause(options);
    const queryFilter: QueryFilter | undefined =
      conditions.length > 0
        ? {
            conditions,
            operator: 'and',
          }
        : undefined;

    return this.storage.count(this.messagesTableName, queryFilter);
  }

  /**
   * Create a subscription lease for a message
   */
  async createSubscriptionLease(
    data: CreateSubscriptionLeaseData
  ): Promise<SubscriptionLeaseRecord | null> {
    // Validate subscription name format
    this.validateSubscriptionName(data.subscriptionName);

    // Check if a lease already exists for this message and subscription
    const existingLease = await this.storage.findFirst(this.leasesTableName, {
      filter: {
        conditions: [
          { field: 'messageId', operator: 'eq', value: data.messageId },
          { field: 'subscriptionName', operator: 'eq', value: data.subscriptionName },
        ],
        operator: 'and',
      },
    });

    if (existingLease) {
      // Lease already exists, return null to indicate no new lease was created
      return null;
    }

    // Parse subscription name to extract project and subscription IDs
    const { projectId, subscriptionId } = PubSubResourceNames.parseSubscription(
      data.subscriptionName
    );

    const now = new Date();
    const lease: SubscriptionLeaseRecord = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      messageId: data.messageId,
      subscriptionName: data.subscriptionName,
      ackId: data.ackId,
      leaseDeadline: data.leaseDeadline,
      deliveryAttempts: data.deliveryAttempts ?? 1,
      projectId,
      subscriptionId,
    };

    // Prepare data for storage
    const storageData = this.prepareLeaseForStorage(lease);

    await this.storage.create(this.leasesTableName, storageData);

    return lease;
  }

  /**
   * Find subscription lease by ack ID
   */
  async findLeaseByAckId(ackId: string): Promise<SubscriptionLeaseRecord | null> {
    const result = await this.storage.findFirst(this.leasesTableName, {
      filter: {
        conditions: [{ field: 'ackId', operator: 'eq', value: ackId }],
        operator: 'and',
      },
    });

    return result ? this.convertLeaseFromStorage(result) : null;
  }

  /**
   * Find leases for a subscription
   */
  async findLeasesBySubscription(subscriptionName: string): Promise<SubscriptionLeaseRecord[]> {
    const result = await this.storage.find(this.leasesTableName, {
      filter: {
        conditions: [{ field: 'subscriptionName', operator: 'eq', value: subscriptionName }],
        operator: 'and',
      },
    });

    return result.data.map(item => this.convertLeaseFromStorage(item));
  }

  /**
   * Find expired leases
   */
  async findExpiredLeases(): Promise<SubscriptionLeaseRecord[]> {
    const now = new Date();
    const result = await this.storage.find(this.leasesTableName, {
      filter: {
        conditions: [{ field: 'leaseDeadline', operator: 'lt', value: now.toISOString() }],
        operator: 'and',
      },
    });

    return result.data.map(item => this.convertLeaseFromStorage(item));
  }

  /**
   * Delete a subscription lease by ack ID
   */
  async deleteLeaseByAckId(ackId: string): Promise<boolean> {
    const lease = await this.findLeaseByAckId(ackId);

    if (!lease) {
      return false;
    }

    return this.storage.deleteById(this.leasesTableName, lease.id);
  }

  /**
   * Delete expired leases
   */
  async deleteExpiredLeases(): Promise<number> {
    const expiredLeases = await this.findExpiredLeases();
    let deletedCount = 0;

    for (const lease of expiredLeases) {
      const deleted = await this.storage.deleteById(this.leasesTableName, lease.id);

      if (deleted) {
        deletedCount++;
      }
    }

    return deletedCount;
  }

  /**
   * Validate topic name format
   */
  private validateTopicName(name: string): void {
    try {
      PubSubResourceNames.parseTopic(name);
    } catch {
      throw new ValidationError(
        `Invalid topic name: ${name}. Expected format: projects/{project}/topics/{topic}`
      );
    }
  }

  /**
   * Validate subscription name format
   */
  private validateSubscriptionName(name: string): void {
    try {
      PubSubResourceNames.parseSubscription(name);
    } catch {
      throw new ValidationError(
        `Invalid subscription name: ${name}. Expected format: projects/{project}/subscriptions/{subscription}`
      );
    }
  }

  /**
   * Build WHERE clause from message query options
   */
  private buildMessageWhereClause(options: MessageQueryOptions): QueryCondition[] {
    const conditions: QueryCondition[] = [];

    if (options.projectId) {
      conditions.push({ field: 'projectId', operator: 'eq', value: options.projectId });
    }

    if (options.topic) {
      conditions.push({ field: 'topic', operator: 'eq', value: options.topic });
    }

    if (options.topicId) {
      conditions.push({ field: 'topicId', operator: 'eq', value: options.topicId });
    }

    if (options.acknowledged !== undefined) {
      conditions.push({
        field: 'acknowledged',
        operator: 'eq',
        value: options.acknowledged ? 1 : 0,
      });
    }

    if (options.orderingKey) {
      conditions.push({ field: 'orderingKey', operator: 'eq', value: options.orderingKey });
    }

    if (options.publishTimeAfter) {
      conditions.push({
        field: 'publishTime',
        operator: 'gte',
        value: options.publishTimeAfter.toISOString(),
      });
    }

    if (options.publishTimeBefore) {
      conditions.push({
        field: 'publishTime',
        operator: 'lte',
        value: options.publishTimeBefore.toISOString(),
      });
    }

    if (options.notExpired) {
      // For messages without explicit expiration times (most common case),
      // we don't add any condition since null expiration means never expires
      // Only add expiration check if we specifically need to filter expired messages
      // This approach allows messages with null expirationTime to be included
    }

    return conditions;
  }

  /**
   * Prepare message record for storage (convert objects to JSON strings)
   */
  private prepareMessageForStorage(message: MessageRecord): Record<string, unknown> {
    return {
      ...message,
      attributes: JSON.stringify(message.attributes),
      acknowledged: message.acknowledged ? 1 : 0,
      publishTime: message.publishTime.toISOString(),
      expirationTime: message.expirationTime?.toISOString() ?? null,
      acknowledgedAt: message.acknowledgedAt?.toISOString() ?? null,
      createdAt: message.createdAt.toISOString(),
      updatedAt: message.updatedAt.toISOString(),
    };
  }

  /**
   * Convert storage record back to MessageRecord (parse JSON strings)
   */
  private convertMessageFromStorage(record: Record<string, unknown>): MessageRecord {
    return {
      id: record.id as string,
      createdAt: new Date(record.createdAt as string),
      updatedAt: new Date(record.updatedAt as string),
      messageId: record.messageId as string,
      topic: record.topic as string,
      data: record.data as string | undefined,
      attributes: JSON.parse((record.attributes as string) ?? '{}'),
      publishTime: new Date(record.publishTime as string),
      orderingKey: record.orderingKey as string | undefined,
      size: record.size as number,
      deliveryAttempts: record.deliveryAttempts as number,
      expirationTime: record.expirationTime ? new Date(record.expirationTime as string) : undefined,
      acknowledged: Boolean(record.acknowledged),
      ackId: record.ackId as string | undefined,
      acknowledgedAt: record.acknowledgedAt ? new Date(record.acknowledgedAt as string) : undefined,
      projectId: record.projectId as string,
      topicId: record.topicId as string,
    };
  }

  /**
   * Prepare subscription lease record for storage
   */
  private prepareLeaseForStorage(lease: SubscriptionLeaseRecord): Record<string, unknown> {
    return {
      ...lease,
      leaseDeadline: lease.leaseDeadline.toISOString(),
      createdAt: lease.createdAt.toISOString(),
      updatedAt: lease.updatedAt.toISOString(),
    };
  }

  /**
   * Convert storage record back to SubscriptionLeaseRecord
   */
  private convertLeaseFromStorage(record: Record<string, unknown>): SubscriptionLeaseRecord {
    return {
      id: record.id as string,
      createdAt: new Date(record.createdAt as string),
      updatedAt: new Date(record.updatedAt as string),
      messageId: record.messageId as string,
      subscriptionName: record.subscriptionName as string,
      ackId: record.ackId as string,
      leaseDeadline: new Date(record.leaseDeadline as string),
      deliveryAttempts: record.deliveryAttempts as number,
      projectId: record.projectId as string,
      subscriptionId: record.subscriptionId as string,
    };
  }
}
