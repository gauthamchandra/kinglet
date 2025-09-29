/**
 * Message Broker
 *
 * This module provides the core message broker functionality for Pub/Sub,
 * including message publishing, delivery, acknowledgment, retry logic,
 * and subscription management.
 */

import { randomUUID } from 'node:crypto';
import type { IStorageManager } from '@/core/storage/interfaces.js';
import { ValidationError } from '@/core/storage/types.js';
import type { Logger } from '@/shared/utils/logger.js';
import type { MessageRecord } from './models.js';
import { PubSubResourceNames } from './models.js';
import {
  MessageRepository,
  type CreateMessageData,
  type MessageQueryOptions,
} from './repositories/message-repository.js';
import { SubscriptionRepository } from './repositories/subscription-repository.js';

/**
 * Message to be published
 */
export interface PublishMessage {
  /** Message data (will be Base64 encoded) */
  readonly data?: string;
  /** Message attributes */
  readonly attributes?: Record<string, string>;
  /** Ordering key for message ordering */
  readonly orderingKey?: string;
}

/**
 * Publish request
 */
export interface PublishRequest {
  /** Topic name to publish to */
  readonly topic: string;
  /** Messages to publish */
  readonly messages: PublishMessage[];
}

/**
 * Publish response
 */
export interface PublishResponse {
  /** Message IDs of published messages */
  readonly messageIds: string[];
}

/**
 * Pull request
 */
export interface PullRequest {
  /** Subscription name to pull from */
  readonly subscription: string;
  /** Maximum number of messages to return */
  readonly maxMessages?: number;
  /** Allow immediate return with fewer messages */
  readonly allowExcessMessages?: boolean;
  /** Return immediately if true */
  readonly returnImmediately?: boolean;
}

/**
 * Received message
 */
export interface ReceivedMessage {
  /** Acknowledgment ID for this message */
  readonly ackId: string;
  /** The message */
  readonly message: {
    /** Message ID */
    readonly messageId: string;
    /** Message data (Base64 encoded) */
    readonly data?: string | undefined;
    /** Message attributes */
    readonly attributes: Record<string, string>;
    /** Message publish time */
    readonly publishTime: string; // ISO string
    /** Ordering key */
    readonly orderingKey?: string | undefined;
  };
  /** Number of times this message has been delivered */
  readonly deliveryAttempt: number;
}

/**
 * Pull response
 */
export interface PullResponse {
  /** Received messages */
  readonly receivedMessages: ReceivedMessage[];
}

/**
 * Acknowledge request
 */
export interface AcknowledgeRequest {
  /** Subscription name */
  readonly subscription: string;
  /** Acknowledgment IDs to acknowledge */
  readonly ackIds: string[];
}

/**
 * Modify ack deadline request
 */
export interface ModifyAckDeadlineRequest {
  /** Subscription name */
  readonly subscription: string;
  /** Acknowledgment IDs to modify */
  readonly ackIds: string[];
  /** New acknowledgment deadline in seconds */
  readonly ackDeadlineSeconds: number;
}

/**
 * Message delivery options
 */
export interface MessageDeliveryOptions {
  /** Maximum retry attempts */
  readonly maxRetries?: number;
  /** Retry delay in milliseconds */
  readonly retryDelayMs?: number;
  /** Enable exactly-once delivery */
  readonly exactlyOnceDelivery?: boolean;
}

/**
 * Message Broker Implementation
 */
export class MessageBroker {
  private readonly messageRepository: MessageRepository;
  private readonly subscriptionRepository: SubscriptionRepository;

  constructor(
    private readonly storage: IStorageManager,
    private readonly logger: Logger
  ) {
    this.messageRepository = new MessageRepository(storage);
    this.subscriptionRepository = new SubscriptionRepository(storage);
  }

  /**
   * Initialize the message broker
   */
  async initialize(): Promise<void> {
    this.logger.info('Initializing Message Broker');
    await this.messageRepository.initialize();
    await this.subscriptionRepository.initialize();
    this.logger.info('Message Broker initialized successfully');
  }

  /**
   * Publish messages to a topic
   */
  async publish(request: PublishRequest): Promise<PublishResponse> {
    this.logger.debug(`Publishing ${request.messages.length} messages to topic: ${request.topic}`);

    // Validate request
    this.validatePublishRequest(request);

    const messageIds: string[] = [];

    try {
      // Process each message
      for (const message of request.messages) {
        const messageId = randomUUID();

        // Calculate message size
        const size = this.calculateMessageSize(message);

        // Base64 encode message data if provided
        const encodedData = message.data ? Buffer.from(message.data).toString('base64') : undefined;

        // Create message data
        const messageData: CreateMessageData = {
          messageId,
          topic: request.topic,
          ...(encodedData !== undefined && { data: encodedData }),
          attributes: message.attributes ?? {},
          ...(message.orderingKey !== undefined && { orderingKey: message.orderingKey }),
          size,
        };

        // Create the message
        await this.messageRepository.create(messageData);
        messageIds.push(messageId);

        this.logger.debug(`Message created: ${messageId} (size: ${size} bytes)`);
      }

      this.logger.info(`Published ${messageIds.length} messages to topic: ${request.topic}`);

      return { messageIds };
    } catch (error) {
      this.logger.error(`Failed to publish messages to topic ${request.topic}:`, error);
      throw error;
    }
  }

  /**
   * Pull messages from a subscription
   */
  async pull(request: PullRequest): Promise<PullResponse> {
    this.logger.debug(`Pulling messages from subscription: ${request.subscription}`);

    // Validate request
    this.validatePullRequest(request);

    try {
      // Get subscription
      const subscription = await this.subscriptionRepository.findByName(request.subscription);

      if (!subscription) {
        throw new ValidationError(`Subscription not found: ${request.subscription}`);
      }

      // Get available messages for the subscription's topic
      const maxMessages = Math.min(request.maxMessages ?? 100, 1000); // GCP limit
      const queryOptions: MessageQueryOptions = {
        topic: subscription.topic,
        pagination: { limit: maxMessages },
        sort: subscription.enableMessageOrdering
          ? [{ field: 'publishTime', direction: 'asc' }]
          : undefined,
      };

      const availableMessages = await this.messageRepository.findAvailableMessages(queryOptions);

      const receivedMessages: ReceivedMessage[] = [];

      // Use transaction to prevent race conditions in concurrent pulls
      await this.storage.withTransaction(async () => {
        // Create leases for messages one by one, checking for conflicts
        for (const message of availableMessages.data) {
          // Check if message matches subscription filter
          if (subscription.filter && !this.matchesFilter(message, subscription.filter)) {
            continue;
          }

          // Generate acknowledgment ID
          const ackId = randomUUID();

          // Calculate lease deadline
          const leaseDeadline = new Date(Date.now() + subscription.ackDeadlineSeconds * 1000);

          // Try to create subscription lease (this will check for existing leases)
          const lease = await this.messageRepository.createSubscriptionLease({
            messageId: message.messageId,
            subscriptionName: subscription.name,
            ackId,
            leaseDeadline,
            deliveryAttempts: message.deliveryAttempts + 1,
          });

          // If lease creation failed (lease already exists), skip this message
          if (!lease) {
            continue;
          }

          // Increment delivery attempts
          await this.messageRepository.incrementDeliveryAttempts(message.messageId);

          // Create received message
          const receivedMessage: ReceivedMessage = {
            ackId,
            message: {
              messageId: message.messageId,
              data: message.data,
              attributes: message.attributes,
              publishTime: message.publishTime.toISOString(),
              orderingKey: message.orderingKey,
            },
            deliveryAttempt: message.deliveryAttempts + 1,
          };

          receivedMessages.push(receivedMessage);
        }
      });

      this.logger.debug(
        `Pulled ${receivedMessages.length} messages from subscription: ${request.subscription}`
      );

      return { receivedMessages };
    } catch (error) {
      this.logger.error(
        `Failed to pull messages from subscription ${request.subscription}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Acknowledge messages
   */
  async acknowledge(request: AcknowledgeRequest): Promise<void> {
    this.logger.debug(
      `Acknowledging ${request.ackIds.length} messages for subscription: ${request.subscription}`
    );

    // Validate request
    this.validateAcknowledgeRequest(request);

    try {
      for (const ackId of request.ackIds) {
        // Find the lease
        const lease = await this.messageRepository.findLeaseByAckId(ackId);

        if (!lease) {
          this.logger.warn(`Lease not found for ack ID: ${ackId}`);
          continue;
        }

        // Check if lease belongs to the correct subscription
        if (lease.subscriptionName !== request.subscription) {
          this.logger.warn(
            `Ack ID ${ackId} does not belong to subscription ${request.subscription}`
          );
          continue;
        }

        // Check if lease has expired
        if (lease.leaseDeadline < new Date()) {
          this.logger.warn(`Lease expired for ack ID: ${ackId}`);
          await this.messageRepository.deleteLeaseByAckId(ackId);
          continue;
        }

        // Acknowledge the message
        await this.messageRepository.acknowledgeMessage(lease.messageId, ackId);

        // Delete the lease
        await this.messageRepository.deleteLeaseByAckId(ackId);

        this.logger.debug(`Message acknowledged: ${lease.messageId} (ack ID: ${ackId})`);
      }

      this.logger.info(
        `Acknowledged ${request.ackIds.length} messages for subscription: ${request.subscription}`
      );
    } catch (error) {
      this.logger.error(
        `Failed to acknowledge messages for subscription ${request.subscription}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Modify acknowledgment deadline for messages
   */
  async modifyAckDeadline(request: ModifyAckDeadlineRequest): Promise<void> {
    this.logger.debug(`Modifying ack deadline for ${request.ackIds.length} messages`);

    // Validate request
    this.validateModifyAckDeadlineRequest(request);

    try {
      for (const ackId of request.ackIds) {
        // Find the lease
        const lease = await this.messageRepository.findLeaseByAckId(ackId);

        if (!lease) {
          this.logger.warn(`Lease not found for ack ID: ${ackId}`);
          continue;
        }

        // Check if lease belongs to the correct subscription
        if (lease.subscriptionName !== request.subscription) {
          this.logger.warn(
            `Ack ID ${ackId} does not belong to subscription ${request.subscription}`
          );
          continue;
        }

        // Calculate new deadline
        const newDeadline = new Date(Date.now() + request.ackDeadlineSeconds * 1000);

        // Update lease in database would require extending the lease interface
        // For now, we'll log the operation
        this.logger.debug(
          `Modified ack deadline for ack ID ${ackId} to ${newDeadline.toISOString()}`
        );
      }

      this.logger.info(`Modified ack deadline for ${request.ackIds.length} messages`);
    } catch (error) {
      this.logger.error(`Failed to modify ack deadline:`, error);
      throw error;
    }
  }

  /**
   * Handle expired leases (background cleanup)
   */
  async handleExpiredLeases(): Promise<void> {
    this.logger.debug('Handling expired leases');

    try {
      const deletedCount = await this.messageRepository.deleteExpiredLeases();

      if (deletedCount > 0) {
        this.logger.info(`Cleaned up ${deletedCount} expired leases`);
      }
    } catch (error) {
      this.logger.error('Failed to handle expired leases:', error);
    }
  }

  /**
   * Handle expired messages (background cleanup)
   */
  async handleExpiredMessages(): Promise<void> {
    this.logger.debug('Handling expired messages');

    try {
      const deletedCount = await this.messageRepository.deleteExpiredMessages();

      if (deletedCount > 0) {
        this.logger.info(`Cleaned up ${deletedCount} expired messages`);
      }
    } catch (error) {
      this.logger.error('Failed to handle expired messages:', error);
    }
  }

  /**
   * Clean up old acknowledged messages
   */
  async cleanupOldMessages(retentionPeriodMs: number = 7 * 24 * 60 * 60 * 1000): Promise<void> {
    this.logger.debug('Cleaning up old acknowledged messages');

    try {
      const deletedCount =
        await this.messageRepository.deleteOldAcknowledgedMessages(retentionPeriodMs);

      if (deletedCount > 0) {
        this.logger.info(`Cleaned up ${deletedCount} old acknowledged messages`);
      }
    } catch (error) {
      this.logger.error('Failed to cleanup old messages:', error);
    }
  }

  /**
   * Get message statistics
   */
  async getMessageStats(topicName?: string): Promise<{
    totalMessages: number;
    unacknowledgedMessages: number;
    acknowledgedMessages: number;
  }> {
    const totalMessages = await this.messageRepository.count(topicName ? { topic: topicName } : {});
    const unacknowledgedMessages = await this.messageRepository.count(
      topicName ? { topic: topicName, acknowledged: false } : { acknowledged: false }
    );
    const acknowledgedMessages = await this.messageRepository.count(
      topicName ? { topic: topicName, acknowledged: true } : { acknowledged: true }
    );

    return {
      totalMessages,
      unacknowledgedMessages,
      acknowledgedMessages,
    };
  }

  /**
   * Validate publish request
   */
  private validatePublishRequest(request: PublishRequest): void {
    if (!request.topic) {
      throw new ValidationError('Topic is required');
    }

    if (!request.messages || request.messages.length === 0) {
      throw new ValidationError('At least one message is required');
    }

    if (request.messages.length > 1000) {
      throw new ValidationError('Maximum 1000 messages per publish request');
    }

    // Validate topic name format
    try {
      PubSubResourceNames.parseTopic(request.topic);
    } catch {
      throw new ValidationError(`Invalid topic name: ${request.topic}`);
    }

    // Validate each message
    for (const [index, message] of request.messages.entries()) {
      if (message.data && Buffer.byteLength(message.data, 'utf8') > 10 * 1024 * 1024) {
        throw new ValidationError(`Message ${index} data too large (max 10MB)`);
      }

      if (message.attributes) {
        const attrCount = Object.keys(message.attributes).length;

        if (attrCount > 100) {
          throw new ValidationError(`Message ${index} has too many attributes (max 100)`);
        }

        for (const [key, value] of Object.entries(message.attributes)) {
          if (key.length > 256) {
            throw new ValidationError(
              `Message ${index} attribute key too long (max 256 chars): ${key}`
            );
          }
          if (value.length > 1024) {
            throw new ValidationError(
              `Message ${index} attribute value too long (max 1024 chars): ${key}`
            );
          }
        }
      }

      if (message.orderingKey && message.orderingKey.length > 1024) {
        throw new ValidationError(`Message ${index} ordering key too long (max 1024 chars)`);
      }
    }
  }

  /**
   * Validate pull request
   */
  private validatePullRequest(request: PullRequest): void {
    if (!request.subscription) {
      throw new ValidationError('Subscription is required');
    }

    // Validate subscription name format
    try {
      PubSubResourceNames.parseSubscription(request.subscription);
    } catch {
      throw new ValidationError(`Invalid subscription name: ${request.subscription}`);
    }

    if (request.maxMessages && (request.maxMessages < 1 || request.maxMessages > 1000)) {
      throw new ValidationError('maxMessages must be between 1 and 1000');
    }
  }

  /**
   * Validate acknowledge request
   */
  private validateAcknowledgeRequest(request: AcknowledgeRequest): void {
    if (!request.subscription) {
      throw new ValidationError('Subscription is required');
    }

    if (!request.ackIds || request.ackIds.length === 0) {
      throw new ValidationError('At least one acknowledgment ID is required');
    }

    if (request.ackIds.length > 1000) {
      throw new ValidationError('Maximum 1000 acknowledgment IDs per request');
    }

    // Validate subscription name format
    try {
      PubSubResourceNames.parseSubscription(request.subscription);
    } catch {
      throw new ValidationError(`Invalid subscription name: ${request.subscription}`);
    }
  }

  /**
   * Validate modify ack deadline request
   */
  private validateModifyAckDeadlineRequest(request: ModifyAckDeadlineRequest): void {
    if (!request.subscription) {
      throw new ValidationError('Subscription is required');
    }

    if (!request.ackIds || request.ackIds.length === 0) {
      throw new ValidationError('At least one acknowledgment ID is required');
    }

    if (request.ackIds.length > 1000) {
      throw new ValidationError('Maximum 1000 acknowledgment IDs per request');
    }

    if (request.ackDeadlineSeconds < 0 || request.ackDeadlineSeconds > 600) {
      throw new ValidationError('Acknowledgment deadline must be between 0 and 600 seconds');
    }

    // Validate subscription name format
    try {
      PubSubResourceNames.parseSubscription(request.subscription);
    } catch {
      throw new ValidationError(`Invalid subscription name: ${request.subscription}`);
    }
  }

  /**
   * Calculate message size in bytes
   */
  private calculateMessageSize(message: PublishMessage): number {
    let size = 0;

    // Data size
    if (message.data) {
      size += Buffer.byteLength(message.data, 'utf8');
    }

    // Attributes size
    if (message.attributes) {
      for (const [key, value] of Object.entries(message.attributes)) {
        size += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8');
      }
    }

    // Ordering key size
    if (message.orderingKey) {
      size += Buffer.byteLength(message.orderingKey, 'utf8');
    }

    return size;
  }

  /**
   * Check if message matches subscription filter
   * This is a simplified implementation - a full implementation would parse
   * and evaluate the filter expression according to Pub/Sub filter syntax
   */
  private matchesFilter(message: MessageRecord, filter: string): boolean {
    // Basic filter matching - in a real implementation, this would be much more sophisticated
    if (filter.includes('attributes.')) {
      // Simple attribute filtering
      const attrMatch = filter.match(/attributes\.(\w+)\s*=\s*"([^"]+)"/);

      if (attrMatch) {
        const [, attrName, attrValue] = attrMatch;

        return attrName ? message.attributes[attrName] === attrValue : false;
      }
    }

    // If no specific filter matches, assume the message passes
    return true;
  }
}
