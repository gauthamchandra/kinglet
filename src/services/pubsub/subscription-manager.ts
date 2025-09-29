/**
 * Subscription Manager
 *
 * This module provides business logic for Pub/Sub subscription management,
 * including validation, CRUD operations, push/pull configuration, filtering,
 * and dead letter policy support.
 */

import type { IStorageManager } from '@/core/storage/interfaces.js';
import { ValidationError } from '@/core/storage/types.js';
import type { Logger } from '@/shared/utils/logger.js';
import type { SubscriptionRecord } from './models.js';
import { PubSubResourceNames } from './models.js';
import {
  SubscriptionRepository,
  type CreateSubscriptionData,
  type UpdateSubscriptionData,
  type SubscriptionQueryOptions,
} from './repositories/subscription-repository.js';
import type { QueryResult } from '@/core/storage/types.js';

/**
 * Subscription creation request
 */
export interface CreateSubscriptionRequest {
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
}

/**
 * Subscription update request
 */
export interface UpdateSubscriptionRequest {
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
}

/**
 * Subscription listing request
 */
export interface ListSubscriptionsRequest {
  /** Project ID to list subscriptions for */
  readonly projectId: string;
  /** Maximum number of subscriptions to return */
  readonly pageSize?: number | undefined;
  /** Page token for pagination */
  readonly pageToken?: string | undefined;
  /** Filter expression */
  readonly filter?: string | undefined;
  /** Order by clause */
  readonly orderBy?: string | undefined;
}

/**
 * Subscription listing response
 */
export interface ListSubscriptionsResponse {
  /** List of subscriptions */
  readonly subscriptions: SubscriptionRecord[];
  /** Next page token */
  readonly nextPageToken?: string | undefined;
  /** Total number of subscriptions */
  readonly totalSize?: number | undefined;
}

/**
 * Topic subscriptions listing request
 */
export interface ListTopicSubscriptionsRequest {
  /** Topic name to list subscriptions for */
  readonly topic: string;
  /** Maximum number of subscriptions to return */
  readonly pageSize?: number | undefined;
  /** Page token for pagination */
  readonly pageToken?: string | undefined;
}

/**
 * Subscription Manager Implementation
 */
export class SubscriptionManager {
  private readonly repository: SubscriptionRepository;

  constructor(
    storage: IStorageManager,
    private readonly logger: Logger
  ) {
    this.repository = new SubscriptionRepository(storage);
  }

  /**
   * Initialize the subscription manager
   */
  async initialize(): Promise<void> {
    this.logger.info('Initializing Subscription Manager');
    await this.repository.initialize();
    this.logger.info('Subscription Manager initialized successfully');
  }

  /**
   * Create a new subscription
   */
  async createSubscription(request: CreateSubscriptionRequest): Promise<SubscriptionRecord> {
    this.logger.info(`Creating subscription: ${request.name}`);

    // Validate request
    this.validateCreateSubscriptionRequest(request);

    try {
      // Create subscription data
      const subscriptionData: CreateSubscriptionData = {
        name: request.name,
        topic: request.topic,
        pushConfig: request.pushConfig,
        bigqueryConfig: request.bigqueryConfig,
        cloudStorageConfig: request.cloudStorageConfig,
        ackDeadlineSeconds: this.validateAckDeadline(request.ackDeadlineSeconds),
        retainAckedMessages: request.retainAckedMessages ?? false,
        messageRetentionDuration: this.validateMessageRetentionDuration(
          request.messageRetentionDuration
        ),
        labels: this.validateAndCleanLabels(request.labels),
        enableMessageOrdering: request.enableMessageOrdering ?? false,
        expirationPolicy: this.validateExpirationPolicy(request.expirationPolicy),
        filter: this.validateFilter(request.filter),
        deadLetterPolicy: this.validateDeadLetterPolicy(request.deadLetterPolicy),
        retryPolicy: this.validateRetryPolicy(request.retryPolicy),
        detached: request.detached ?? false,
        enableExactlyOnceDelivery: request.enableExactlyOnceDelivery ?? false,
        topicMessageRetentionDuration: request.topicMessageRetentionDuration,
      };

      const subscription = await this.repository.create(subscriptionData);

      this.logger.info(
        `Subscription created successfully: ${subscription.name} (ID: ${subscription.id})`
      );

      return subscription;
    } catch (error) {
      this.logger.error(`Failed to create subscription ${request.name}:`, error);
      throw error;
    }
  }

  /**
   * Get a subscription by name
   */
  async getSubscription(name: string): Promise<SubscriptionRecord | null> {
    this.logger.debug(`Getting subscription: ${name}`);

    // Validate subscription name format
    this.validateSubscriptionName(name);

    const subscription = await this.repository.findByName(name);

    if (subscription) {
      this.logger.debug(`Subscription found: ${name} (ID: ${subscription.id})`);
    } else {
      this.logger.debug(`Subscription not found: ${name}`);
    }

    return subscription;
  }

  /**
   * Update a subscription
   */
  async updateSubscription(
    name: string,
    request: UpdateSubscriptionRequest
  ): Promise<SubscriptionRecord | null> {
    this.logger.info(`Updating subscription: ${name}`);

    // Validate subscription name format
    this.validateSubscriptionName(name);

    // Validate update request
    this.validateUpdateSubscriptionRequest(request);

    try {
      // Prepare update data
      const updateData: UpdateSubscriptionData = {
        pushConfig: request.pushConfig,
        bigqueryConfig: request.bigqueryConfig,
        cloudStorageConfig: request.cloudStorageConfig,
        ackDeadlineSeconds:
          request.ackDeadlineSeconds !== undefined
            ? this.validateAckDeadline(request.ackDeadlineSeconds)
            : undefined,
        retainAckedMessages: request.retainAckedMessages,
        messageRetentionDuration: request.messageRetentionDuration
          ? this.validateMessageRetentionDuration(request.messageRetentionDuration)
          : undefined,
        labels: request.labels ? this.validateAndCleanLabels(request.labels) : undefined,
        enableMessageOrdering: request.enableMessageOrdering,
        expirationPolicy:
          request.expirationPolicy !== undefined
            ? this.validateExpirationPolicy(request.expirationPolicy)
            : undefined,
        filter: request.filter !== undefined ? this.validateFilter(request.filter) : undefined,
        deadLetterPolicy:
          request.deadLetterPolicy !== undefined
            ? this.validateDeadLetterPolicy(request.deadLetterPolicy)
            : undefined,
        retryPolicy:
          request.retryPolicy !== undefined
            ? this.validateRetryPolicy(request.retryPolicy)
            : undefined,
        enableExactlyOnceDelivery: request.enableExactlyOnceDelivery,
        topicMessageRetentionDuration: request.topicMessageRetentionDuration,
      };

      const subscription = await this.repository.updateByName(name, updateData);

      if (subscription) {
        this.logger.info(`Subscription updated successfully: ${name} (ID: ${subscription.id})`);
      } else {
        this.logger.warn(`Subscription not found for update: ${name}`);
      }

      return subscription;
    } catch (error) {
      this.logger.error(`Failed to update subscription ${name}:`, error);
      throw error;
    }
  }

  /**
   * Delete a subscription
   */
  async deleteSubscription(name: string): Promise<boolean> {
    this.logger.info(`Deleting subscription: ${name}`);

    // Validate subscription name format
    this.validateSubscriptionName(name);

    try {
      const deleted = await this.repository.deleteByName(name);

      if (deleted) {
        this.logger.info(`Subscription deleted successfully: ${name}`);
      } else {
        this.logger.warn(`Subscription not found for deletion: ${name}`);
      }

      return deleted;
    } catch (error) {
      this.logger.error(`Failed to delete subscription ${name}:`, error);
      throw error;
    }
  }

  /**
   * List subscriptions in a project
   */
  async listSubscriptions(request: ListSubscriptionsRequest): Promise<ListSubscriptionsResponse> {
    this.logger.debug(`Listing subscriptions for project: ${request.projectId}`);

    // Validate request
    this.validateListSubscriptionsRequest(request);

    try {
      const queryOptions: SubscriptionQueryOptions = {
        projectId: request.projectId,
        limit: request.pageSize ?? 50,
        offset: this.parsePageToken(request.pageToken) ?? 0,
        orderBy: request.orderBy ? [{ field: request.orderBy, direction: 'asc' }] : undefined,
      };

      // Apply filter if provided
      if (request.filter) {
        this.applyFilter(queryOptions, request.filter);
      }

      const result = await this.repository.find(queryOptions);

      // Generate next page token if there are more results
      let nextPageToken: string | undefined;

      if (result.hasMore) {
        const nextOffset = (queryOptions.offset || 0) + result.data.length;

        nextPageToken = this.generatePageToken(nextOffset);
      }

      const response: ListSubscriptionsResponse = {
        subscriptions: result.data,
        nextPageToken,
        totalSize: result.total,
      };

      this.logger.debug(
        `Found ${result.data.length} subscriptions for project ${request.projectId}`
      );

      return response;
    } catch (error) {
      this.logger.error(`Failed to list subscriptions for project ${request.projectId}:`, error);
      throw error;
    }
  }

  /**
   * List subscriptions for a topic
   */
  async listTopicSubscriptions(
    request: ListTopicSubscriptionsRequest
  ): Promise<ListSubscriptionsResponse> {
    this.logger.debug(`Listing subscriptions for topic: ${request.topic}`);

    // Validate topic name format
    this.validateTopicName(request.topic);

    try {
      const queryOptions: SubscriptionQueryOptions = {
        topic: request.topic,
        limit: request.pageSize ?? 50,
        offset: this.parsePageToken(request.pageToken) ?? 0,
      };

      const result = await this.repository.find(queryOptions);

      // Generate next page token if there are more results
      let nextPageToken: string | undefined;

      if (result.hasMore) {
        const nextOffset = (queryOptions.offset || 0) + result.data.length;

        nextPageToken = this.generatePageToken(nextOffset);
      }

      const response: ListSubscriptionsResponse = {
        subscriptions: result.data,
        nextPageToken,
        totalSize: result.total,
      };

      this.logger.debug(`Found ${result.data.length} subscriptions for topic ${request.topic}`);

      return response;
    } catch (error) {
      this.logger.error(`Failed to list subscriptions for topic ${request.topic}:`, error);
      throw error;
    }
  }

  /**
   * Check if a subscription exists
   */
  async subscriptionExists(name: string): Promise<boolean> {
    this.validateSubscriptionName(name);

    return this.repository.existsByName(name);
  }

  /**
   * Get subscription count for a project
   */
  async getSubscriptionCount(projectId: string): Promise<number> {
    return this.repository.countByProject(projectId);
  }

  /**
   * Get subscription count for a topic
   */
  async getTopicSubscriptionCount(topicName: string): Promise<number> {
    return this.repository.countByTopic(topicName);
  }

  /**
   * Get push subscriptions
   */
  async getPushSubscriptions(
    options: SubscriptionQueryOptions = {}
  ): Promise<QueryResult<SubscriptionRecord>> {
    return this.repository.findPushSubscriptions(options);
  }

  /**
   * Get pull subscriptions
   */
  async getPullSubscriptions(
    options: SubscriptionQueryOptions = {}
  ): Promise<QueryResult<SubscriptionRecord>> {
    return this.repository.findPullSubscriptions(options);
  }

  /**
   * Validate create subscription request
   */
  private validateCreateSubscriptionRequest(request: CreateSubscriptionRequest): void {
    if (!request.name) {
      throw new ValidationError('Subscription name is required');
    }

    if (!request.topic) {
      throw new ValidationError('Topic name is required');
    }

    this.validateSubscriptionName(request.name);
    this.validateTopicName(request.topic);

    if (request.labels) {
      this.validateLabels(request.labels);
    }

    if (request.ackDeadlineSeconds !== undefined) {
      this.validateAckDeadline(request.ackDeadlineSeconds);
    }

    if (request.messageRetentionDuration !== undefined) {
      this.validateMessageRetentionDuration(request.messageRetentionDuration);
    }

    if (request.filter !== undefined) {
      this.validateFilter(request.filter);
    }

    if (request.deadLetterPolicy !== undefined) {
      this.validateDeadLetterPolicy(request.deadLetterPolicy);
    }

    if (request.retryPolicy !== undefined) {
      this.validateRetryPolicy(request.retryPolicy);
    }

    if (request.expirationPolicy !== undefined) {
      this.validateExpirationPolicy(request.expirationPolicy);
    }

    if (request.pushConfig && request.enableMessageOrdering) {
      throw new ValidationError('Message ordering is not supported for push subscriptions');
    }
  }

  /**
   * Validate update subscription request
   */
  private validateUpdateSubscriptionRequest(request: UpdateSubscriptionRequest): void {
    if (request.labels) {
      this.validateLabels(request.labels);
    }

    if (request.ackDeadlineSeconds !== undefined) {
      this.validateAckDeadline(request.ackDeadlineSeconds);
    }

    if (request.messageRetentionDuration !== undefined) {
      this.validateMessageRetentionDuration(request.messageRetentionDuration);
    }

    if (request.filter !== undefined) {
      this.validateFilter(request.filter);
    }

    if (request.deadLetterPolicy !== undefined) {
      this.validateDeadLetterPolicy(request.deadLetterPolicy);
    }

    if (request.retryPolicy !== undefined) {
      this.validateRetryPolicy(request.retryPolicy);
    }

    if (request.expirationPolicy !== undefined) {
      this.validateExpirationPolicy(request.expirationPolicy);
    }

    if (request.pushConfig && request.enableMessageOrdering) {
      throw new ValidationError('Message ordering is not supported for push subscriptions');
    }
  }

  /**
   * Validate list subscriptions request
   */
  private validateListSubscriptionsRequest(request: ListSubscriptionsRequest): void {
    if (!request.projectId) {
      throw new ValidationError('Project ID is required');
    }

    if (request.pageSize && (request.pageSize < 1 || request.pageSize > 1000)) {
      throw new ValidationError('Page size must be between 1 and 1000');
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
   * Validate labels
   */
  private validateLabels(labels: Record<string, string>): void {
    const labelCount = Object.keys(labels).length;

    if (labelCount > 64) {
      throw new ValidationError(`Too many labels: ${labelCount}. Maximum allowed: 64`);
    }

    for (const [key, value] of Object.entries(labels)) {
      if (!key || key.length > 63) {
        throw new ValidationError(`Invalid label key: ${key}. Must be 1-63 characters`);
      }

      if (value.length > 63) {
        throw new ValidationError(
          `Invalid label value for key ${key}: ${value}. Must be 0-63 characters`
        );
      }

      // Basic validation for GCP label format
      if (!/^[a-z0-9_-]+$/i.test(key)) {
        throw new ValidationError(
          `Invalid label key format: ${key}. Must contain only letters, numbers, underscores, and hyphens`
        );
      }
    }
  }

  /**
   * Validate and clean labels
   */
  private validateAndCleanLabels(labels?: Record<string, string>): Record<string, string> {
    if (!labels) {
      return {};
    }

    this.validateLabels(labels);

    return { ...labels }; // Return a clean copy
  }

  /**
   * Validate acknowledgment deadline
   */
  private validateAckDeadline(ackDeadlineSeconds?: number): number {
    if (ackDeadlineSeconds === undefined) {
      return 10; // Default value
    }

    if (ackDeadlineSeconds < 10 || ackDeadlineSeconds > 600) {
      throw new ValidationError(
        `Invalid ack deadline: ${ackDeadlineSeconds}. Must be between 10 and 600 seconds`
      );
    }

    return ackDeadlineSeconds;
  }

  /**
   * Validate message retention duration
   */
  private validateMessageRetentionDuration(duration?: string): string | undefined {
    if (duration === undefined || duration === null) {
      return undefined;
    }

    // Empty string should be rejected
    if (duration === '') {
      throw new ValidationError(
        `Invalid message retention duration format: "${duration}". Expected format: {number}{unit} (e.g., "600s", "10m", "1h")`
      );
    }

    // Basic duration format validation (e.g., "600s", "10m", "1h")
    if (!/^\d+[smhd]$/.test(duration)) {
      throw new ValidationError(
        `Invalid message retention duration format: ${duration}. Expected format: {number}{unit} (e.g., "600s", "10m", "1h")`
      );
    }

    return duration;
  }

  /**
   * Validate filter expression
   */
  private validateFilter(filter?: string): string | undefined {
    if (filter === undefined || filter === null) {
      return undefined;
    }

    // Basic filter validation - in a real implementation, this would parse and validate
    // the filter expression according to Pub/Sub filter syntax
    if (filter.length > 1000) {
      throw new ValidationError(
        `Filter expression too long: ${filter.length} characters. Maximum allowed: 1000`
      );
    }

    return filter;
  }

  /**
   * Validate dead letter policy
   */
  private validateDeadLetterPolicy(
    policy?: SubscriptionRecord['deadLetterPolicy']
  ): SubscriptionRecord['deadLetterPolicy'] {
    if (!policy) {
      return undefined;
    }

    if (policy.deadLetterTopic) {
      this.validateTopicName(policy.deadLetterTopic);
    }

    if (policy.maxDeliveryAttempts !== undefined) {
      if (policy.maxDeliveryAttempts < 5 || policy.maxDeliveryAttempts > 100) {
        throw new ValidationError(
          `Invalid max delivery attempts: ${policy.maxDeliveryAttempts}. Must be between 5 and 100`
        );
      }
    }

    return policy;
  }

  /**
   * Validate retry policy
   */
  private validateRetryPolicy(
    policy?: SubscriptionRecord['retryPolicy']
  ): SubscriptionRecord['retryPolicy'] {
    if (!policy) {
      return undefined;
    }

    // Basic validation for retry policy durations
    if (policy.minimumBackoff && !/^\d+(\.\d+)?s$/.test(policy.minimumBackoff)) {
      throw new ValidationError(
        `Invalid minimum backoff format: ${policy.minimumBackoff}. Expected format: {number}s`
      );
    }

    if (policy.maximumBackoff && !/^\d+(\.\d+)?s$/.test(policy.maximumBackoff)) {
      throw new ValidationError(
        `Invalid maximum backoff format: ${policy.maximumBackoff}. Expected format: {number}s`
      );
    }

    return policy;
  }

  /**
   * Validate expiration policy
   */
  private validateExpirationPolicy(
    policy?: SubscriptionRecord['expirationPolicy']
  ): SubscriptionRecord['expirationPolicy'] {
    if (!policy) {
      return undefined;
    }

    // Basic validation for TTL format
    if (policy.ttl && !/^\d+[smhd]$/.test(policy.ttl)) {
      throw new ValidationError(
        `Invalid TTL format: ${policy.ttl}. Expected format: {number}{unit} (e.g., "600s", "10m", "1h")`
      );
    }

    return policy;
  }

  /**
   * Apply filter to query options
   */
  private applyFilter(options: SubscriptionQueryOptions, filter: string): void {
    // Basic filter parsing - in a real implementation, this would parse
    // complex filter expressions according to GCP filtering syntax
    // For now, we'll just handle simple cases

    if (filter.includes('labels.')) {
      // Handle label filtering
      this.logger.debug(`Filter by labels not fully implemented: ${filter}`);
    }
  }

  /**
   * Parse page token to get offset
   */
  private parsePageToken(token?: string): number | undefined {
    if (!token) {
      return undefined;
    }

    try {
      // Simple base64 encoding of offset
      const decoded = Buffer.from(token, 'base64').toString();
      const offset = parseInt(decoded, 10);

      return isNaN(offset) ? 0 : offset;
    } catch {
      return 0;
    }
  }

  /**
   * Generate page token from offset
   */
  private generatePageToken(offset: number): string {
    return Buffer.from(offset.toString()).toString('base64');
  }
}
