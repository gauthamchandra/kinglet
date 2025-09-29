/**
 * Subscription Repository
 *
 * This module provides data access operations for Pub/Sub subscriptions,
 * implementing the repository pattern for subscription management with support
 * for pull and push subscriptions, filtering, and dead letter policies.
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
import type { SubscriptionRecord } from '../models.js';
import { PubSubResourceNames, SUBSCRIPTIONS_SCHEMA } from '../models.js';

/**
 * Subscription creation data (without BaseRecord fields)
 */
export interface CreateSubscriptionData {
  /** Subscription name in the format: projects/{project}/subscriptions/{subscription} */
  readonly name: string;
  /** Topic name this subscription is attached to */
  readonly topic: string;
  /** Push configuration for push subscriptions */
  readonly pushConfig?: SubscriptionRecord['pushConfig'] | undefined;
  /** BigQuery configuration for BigQuery subscriptions */
  readonly bigqueryConfig?: SubscriptionRecord['bigqueryConfig'] | undefined;
  /** Cloud Storage configuration */
  readonly cloudStorageConfig?: SubscriptionRecord['cloudStorageConfig'] | undefined;
  /** Acknowledgment deadline in seconds */
  readonly ackDeadlineSeconds?: number | undefined;
  /** Whether to retain acknowledged messages */
  readonly retainAckedMessages?: boolean | undefined;
  /** Message retention duration */
  readonly messageRetentionDuration?: string | undefined;
  /** Labels for the subscription */
  readonly labels?: Record<string, string> | undefined;
  /** Whether to enable message ordering */
  readonly enableMessageOrdering?: boolean | undefined;
  /** Expiration policy for the subscription */
  readonly expirationPolicy?: SubscriptionRecord['expirationPolicy'] | undefined;
  /** Filter expression for messages */
  readonly filter?: string | undefined;
  /** Dead letter policy */
  readonly deadLetterPolicy?: SubscriptionRecord['deadLetterPolicy'] | undefined;
  /** Retry policy */
  readonly retryPolicy?: SubscriptionRecord['retryPolicy'] | undefined;
  /** Whether the subscription is detached */
  readonly detached?: boolean | undefined;
  /** Whether to enable exactly-once delivery */
  readonly enableExactlyOnceDelivery?: boolean | undefined;
  /** Topic message retention duration */
  readonly topicMessageRetentionDuration?: string | undefined;
  /** Subscription state */
  readonly state?: 'ACTIVE' | 'RESOURCE_ERROR' | undefined;
}

/**
 * Subscription update data (partial fields for updates)
 */
export interface UpdateSubscriptionData {
  /** Push configuration for push subscriptions */
  readonly pushConfig?: SubscriptionRecord['pushConfig'] | undefined;
  /** BigQuery configuration for BigQuery subscriptions */
  readonly bigqueryConfig?: SubscriptionRecord['bigqueryConfig'] | undefined;
  /** Cloud Storage configuration */
  readonly cloudStorageConfig?: SubscriptionRecord['cloudStorageConfig'] | undefined;
  /** Acknowledgment deadline in seconds */
  readonly ackDeadlineSeconds?: number | undefined;
  /** Whether to retain acknowledged messages */
  readonly retainAckedMessages?: boolean | undefined;
  /** Message retention duration */
  readonly messageRetentionDuration?: string | undefined;
  /** Labels for the subscription */
  readonly labels?: Record<string, string> | undefined;
  /** Whether to enable message ordering */
  readonly enableMessageOrdering?: boolean | undefined;
  /** Expiration policy for the subscription */
  readonly expirationPolicy?: SubscriptionRecord['expirationPolicy'] | undefined;
  /** Filter expression for messages */
  readonly filter?: string | undefined;
  /** Dead letter policy */
  readonly deadLetterPolicy?: SubscriptionRecord['deadLetterPolicy'] | undefined;
  /** Retry policy */
  readonly retryPolicy?: SubscriptionRecord['retryPolicy'] | undefined;
  /** Whether to enable exactly-once delivery */
  readonly enableExactlyOnceDelivery?: boolean | undefined;
  /** Topic message retention duration */
  readonly topicMessageRetentionDuration?: string | undefined;
  /** Subscription state */
  readonly state?: 'ACTIVE' | 'RESOURCE_ERROR' | undefined;
}

/**
 * Subscription query filters
 */
export interface SubscriptionQueryOptions extends QueryOptions {
  /** Filter by project ID */
  readonly projectId?: string | undefined;
  /** Filter by subscription ID */
  readonly subscriptionId?: string | undefined;
  /** Filter by topic name */
  readonly topic?: string | undefined;
  /** Filter by topic ID */
  readonly topicId?: string | undefined;
  /** Filter by subscription state */
  readonly state?: 'ACTIVE' | 'RESOURCE_ERROR' | undefined;
  /** Filter by labels */
  readonly labels?: Record<string, string> | undefined;
  /** Limit the number of results (convenience property) */
  readonly limit?: number | undefined;
  /** Offset for pagination (convenience property) */
  readonly offset?: number | undefined;
  /** Where conditions (convenience property for filter) */
  readonly where?: QueryCondition[] | undefined;
  /** Order by field and direction */
  readonly orderBy?: Array<{ field: string; direction: 'asc' | 'desc' }> | undefined;
}

/**
 * Subscription Repository Implementation
 */
export class SubscriptionRepository implements IRepository<SubscriptionRecord> {
  private readonly tableName = SUBSCRIPTIONS_SCHEMA.name;

  constructor(private readonly storage: IStorageManager) {}

  /**
   * Initialize the repository by creating tables if needed
   */
  async initialize(): Promise<void> {
    await this.storage.createTable(this.tableName, SUBSCRIPTIONS_SCHEMA);
  }

  /**
   * Create a new subscription
   */
  async create(data: CreateSubscriptionData): Promise<SubscriptionRecord> {
    // Validate subscription name format
    this.validateSubscriptionName(data.name);

    // Validate topic name format
    this.validateTopicName(data.topic);

    // Parse subscription name to extract project and subscription IDs
    const { projectId, subscriptionId } = PubSubResourceNames.parseSubscription(data.name);
    const { topicId } = PubSubResourceNames.parseTopic(data.topic);

    // Check if subscription already exists
    const existingSubscription = await this.findByName(data.name);

    if (existingSubscription) {
      throw new ValidationError(`Subscription already exists: ${data.name}`);
    }

    const now = new Date();
    const subscription: SubscriptionRecord = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      name: data.name,
      topic: data.topic,
      pushConfig: data.pushConfig,
      bigqueryConfig: data.bigqueryConfig,
      cloudStorageConfig: data.cloudStorageConfig,
      ackDeadlineSeconds: data.ackDeadlineSeconds ?? 10,
      retainAckedMessages: data.retainAckedMessages ?? false,
      messageRetentionDuration: data.messageRetentionDuration,
      labels: data.labels ?? {},
      enableMessageOrdering: data.enableMessageOrdering ?? false,
      expirationPolicy: data.expirationPolicy,
      filter: data.filter,
      deadLetterPolicy: data.deadLetterPolicy,
      retryPolicy: data.retryPolicy,
      detached: data.detached ?? false,
      enableExactlyOnceDelivery: data.enableExactlyOnceDelivery ?? false,
      topicMessageRetentionDuration: data.topicMessageRetentionDuration,
      state: data.state ?? 'ACTIVE',
      projectId,
      subscriptionId,
      topicId,
    };

    // Prepare data for storage (convert complex objects to JSON strings)
    const storageData = this.prepareForStorage(subscription);

    await this.storage.create(this.tableName, storageData);

    return subscription;
  }

  /**
   * Find a subscription by ID
   */
  async findById(id: string): Promise<SubscriptionRecord | null> {
    const result = await this.storage.findById(this.tableName, id);

    return result ? this.convertFromStorage(result) : null;
  }

  /**
   * Find a subscription by name
   */
  async findByName(name: string): Promise<SubscriptionRecord | null> {
    const result = await this.storage.findFirst(this.tableName, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
        operator: 'and',
      },
    });

    return result ? this.convertFromStorage(result) : null;
  }

  /**
   * Find subscriptions matching criteria
   */
  async find(options: SubscriptionQueryOptions = {}): Promise<QueryResult<SubscriptionRecord>> {
    const conditions = this.buildWhereClause(options);
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

    const result = await this.storage.find(this.tableName, queryOptions);

    return {
      data: result.data.map(item => this.convertFromStorage(item)),
      total: result.total,
      hasMore: result.hasMore,
    };
  }

  /**
   * Find subscriptions in a specific project
   */
  async findByProject(
    projectId: string,
    options: QueryOptions = {}
  ): Promise<QueryResult<SubscriptionRecord>> {
    return this.find({ ...options, projectId });
  }

  /**
   * Find subscriptions for a specific topic
   */
  async findByTopic(
    topicName: string,
    options: QueryOptions = {}
  ): Promise<QueryResult<SubscriptionRecord>> {
    return this.find({ ...options, topic: topicName });
  }

  /**
   * Find subscriptions for a specific topic ID in a project
   */
  async findByTopicId(
    projectId: string,
    topicId: string,
    options: QueryOptions = {}
  ): Promise<QueryResult<SubscriptionRecord>> {
    return this.find({ ...options, projectId, topicId });
  }

  /**
   * Find first subscription matching criteria
   */
  async findFirst(options: SubscriptionQueryOptions = {}): Promise<SubscriptionRecord | null> {
    const result = await this.find({ ...options, limit: 1 });

    return result.data[0] || null;
  }

  /**
   * Update a subscription by ID
   */
  async updateById(id: string, data: UpdateSubscriptionData): Promise<SubscriptionRecord | null> {
    const existingSubscription = await this.findById(id);

    if (!existingSubscription) {
      return null;
    }

    const updatedSubscription: SubscriptionRecord = {
      ...existingSubscription,
      ...(data.pushConfig !== undefined && { pushConfig: data.pushConfig }),
      ...(data.bigqueryConfig !== undefined && { bigqueryConfig: data.bigqueryConfig }),
      ...(data.cloudStorageConfig !== undefined && { cloudStorageConfig: data.cloudStorageConfig }),
      ...(data.ackDeadlineSeconds !== undefined && { ackDeadlineSeconds: data.ackDeadlineSeconds }),
      ...(data.retainAckedMessages !== undefined && {
        retainAckedMessages: data.retainAckedMessages,
      }),
      ...(data.messageRetentionDuration !== undefined && {
        messageRetentionDuration: data.messageRetentionDuration,
      }),
      ...(data.labels !== undefined && { labels: data.labels }),
      ...(data.enableMessageOrdering !== undefined && {
        enableMessageOrdering: data.enableMessageOrdering,
      }),
      ...(data.expirationPolicy !== undefined && { expirationPolicy: data.expirationPolicy }),
      ...(data.filter !== undefined && { filter: data.filter }),
      updatedAt: new Date(),
    };

    // Prepare data for storage
    const storageData = this.prepareForStorage(updatedSubscription);

    await this.storage.updateById(this.tableName, id, storageData);

    return updatedSubscription;
  }

  /**
   * Update a subscription by name
   */
  async updateByName(
    name: string,
    data: UpdateSubscriptionData
  ): Promise<SubscriptionRecord | null> {
    const subscription = await this.findByName(name);

    if (!subscription) {
      return null;
    }

    return this.updateById(subscription.id, data);
  }

  /**
   * Delete a subscription by ID
   */
  async deleteById(id: string): Promise<boolean> {
    return this.storage.deleteById(this.tableName, id);
  }

  /**
   * Delete a subscription by name
   */
  async deleteByName(name: string): Promise<boolean> {
    const subscription = await this.findByName(name);

    if (!subscription) {
      return false;
    }

    return this.deleteById(subscription.id);
  }

  /**
   * Check if a subscription exists by ID
   */
  async exists(id: string): Promise<boolean> {
    return this.storage.exists(this.tableName, id);
  }

  /**
   * Check if a subscription exists by name
   */
  async existsByName(name: string): Promise<boolean> {
    const subscription = await this.findByName(name);

    return subscription !== null;
  }

  /**
   * Count subscriptions matching criteria
   */
  async count(options: SubscriptionQueryOptions = {}): Promise<number> {
    const conditions = this.buildWhereClause(options);
    const queryFilter: QueryFilter | undefined =
      conditions.length > 0
        ? {
            conditions,
            operator: 'and',
          }
        : undefined;

    return this.storage.count(this.tableName, queryFilter);
  }

  /**
   * Count subscriptions in a specific project
   */
  async countByProject(projectId: string): Promise<number> {
    return this.count({ projectId });
  }

  /**
   * Count subscriptions for a specific topic
   */
  async countByTopic(topicName: string): Promise<number> {
    return this.count({ topic: topicName });
  }

  /**
   * List all subscription names in a project
   */
  async listSubscriptionNames(projectId: string, options: QueryOptions = {}): Promise<string[]> {
    const result = await this.find({ ...options, projectId });

    return result.data.map(subscription => subscription.name);
  }

  /**
   * Get push subscriptions (subscriptions with push config)
   */
  async findPushSubscriptions(
    options: SubscriptionQueryOptions = {}
  ): Promise<QueryResult<SubscriptionRecord>> {
    const result = await this.find(options);

    return {
      data: result.data.filter(sub => sub.pushConfig !== undefined),
      total: result.data.filter(sub => sub.pushConfig !== undefined).length,
      hasMore: result.hasMore,
    };
  }

  /**
   * Get pull subscriptions (subscriptions without push config)
   */
  async findPullSubscriptions(
    options: SubscriptionQueryOptions = {}
  ): Promise<QueryResult<SubscriptionRecord>> {
    const result = await this.find(options);

    return {
      data: result.data.filter(sub => sub.pushConfig === undefined),
      total: result.data.filter(sub => sub.pushConfig === undefined).length,
      hasMore: result.hasMore,
    };
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
   * Build WHERE clause from query options
   */
  private buildWhereClause(options: SubscriptionQueryOptions): QueryCondition[] {
    const conditions = this.ensureQueryConditionsArray(options.where);

    if (options.projectId) {
      conditions.push({ field: 'projectId', operator: 'eq', value: options.projectId });
    }

    if (options.subscriptionId) {
      conditions.push({ field: 'subscriptionId', operator: 'eq', value: options.subscriptionId });
    }

    if (options.topic) {
      conditions.push({ field: 'topic', operator: 'eq', value: options.topic });
    }

    if (options.topicId) {
      conditions.push({ field: 'topicId', operator: 'eq', value: options.topicId });
    }

    if (options.state) {
      conditions.push({ field: 'state', operator: 'eq', value: options.state });
    }

    // Label filtering is complex and would require JSON queries
    // For now, we'll handle it in the application layer if needed
    if (options.labels) {
      // This would require more sophisticated JSON querying
      // For SQLite, we might need to implement custom filtering
    }

    return conditions;
  }

  /**
   * Type guard to ensure QueryCondition array
   */
  private ensureQueryConditionsArray(where: QueryCondition[] | undefined): QueryCondition[] {
    if (!where) {
      return [];
    }

    if (!Array.isArray(where)) {
      return [];
    }

    return where.filter(this.isValidQueryCondition);
  }

  /**
   * Type guard to validate QueryCondition object
   */
  private isValidQueryCondition(condition: unknown): condition is QueryCondition {
    return (
      typeof condition === 'object' &&
      condition !== null &&
      'field' in condition &&
      'operator' in condition &&
      'value' in condition &&
      typeof (condition as QueryCondition).field === 'string' &&
      typeof (condition as QueryCondition).operator === 'string'
    );
  }

  /**
   * Prepare subscription record for storage (convert objects to JSON strings)
   */
  private prepareForStorage(subscription: SubscriptionRecord): Record<string, unknown> {
    return {
      ...subscription,
      pushConfig: subscription.pushConfig ? JSON.stringify(subscription.pushConfig) : null,
      bigqueryConfig: subscription.bigqueryConfig
        ? JSON.stringify(subscription.bigqueryConfig)
        : null,
      cloudStorageConfig: subscription.cloudStorageConfig
        ? JSON.stringify(subscription.cloudStorageConfig)
        : null,
      labels: JSON.stringify(subscription.labels),
      expirationPolicy: subscription.expirationPolicy
        ? JSON.stringify(subscription.expirationPolicy)
        : null,
      deadLetterPolicy: subscription.deadLetterPolicy
        ? JSON.stringify(subscription.deadLetterPolicy)
        : null,
      retryPolicy: subscription.retryPolicy ? JSON.stringify(subscription.retryPolicy) : null,
      retainAckedMessages: subscription.retainAckedMessages ? 1 : 0,
      enableMessageOrdering: subscription.enableMessageOrdering ? 1 : 0,
      detached: subscription.detached ? 1 : 0,
      enableExactlyOnceDelivery: subscription.enableExactlyOnceDelivery ? 1 : 0,
      createdAt: subscription.createdAt.toISOString(),
      updatedAt: subscription.updatedAt.toISOString(),
    };
  }

  /**
   * Convert storage record back to SubscriptionRecord (parse JSON strings)
   */
  private convertFromStorage(record: Record<string, unknown>): SubscriptionRecord {
    return {
      id: record.id as string,
      createdAt: new Date(record.createdAt as string),
      updatedAt: new Date(record.updatedAt as string),
      name: record.name as string,
      topic: record.topic as string,
      pushConfig: record.pushConfig ? JSON.parse(record.pushConfig as string) : undefined,
      bigqueryConfig: record.bigqueryConfig
        ? JSON.parse(record.bigqueryConfig as string)
        : undefined,
      cloudStorageConfig: record.cloudStorageConfig
        ? JSON.parse(record.cloudStorageConfig as string)
        : undefined,
      ackDeadlineSeconds: record.ackDeadlineSeconds as number,
      retainAckedMessages: Boolean(record.retainAckedMessages),
      messageRetentionDuration: record.messageRetentionDuration as string | undefined,
      labels: JSON.parse((record.labels as string) || '{}'),
      enableMessageOrdering: Boolean(record.enableMessageOrdering),
      expirationPolicy: record.expirationPolicy
        ? JSON.parse(record.expirationPolicy as string)
        : undefined,
      filter: record.filter as string | undefined,
      deadLetterPolicy: record.deadLetterPolicy
        ? JSON.parse(record.deadLetterPolicy as string)
        : undefined,
      retryPolicy: record.retryPolicy ? JSON.parse(record.retryPolicy as string) : undefined,
      detached: Boolean(record.detached),
      enableExactlyOnceDelivery: Boolean(record.enableExactlyOnceDelivery),
      topicMessageRetentionDuration: record.topicMessageRetentionDuration as string | undefined,
      state: record.state as 'ACTIVE' | 'RESOURCE_ERROR',
      projectId: record.projectId as string,
      subscriptionId: record.subscriptionId as string,
      topicId: record.topicId as string,
    };
  }
}
