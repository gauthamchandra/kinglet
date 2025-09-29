/**
 * Pub/Sub Data Models
 *
 * This module defines the data models for Pub/Sub service including Topic, Subscription,
 * and Message entities. All models extend BaseRecord to provide common fields.
 */

import type { BaseRecord, TableSchema } from '@/core/storage/types.js';

/**
 * Topic entity representing a Pub/Sub topic
 */
export interface TopicRecord extends BaseRecord {
  /** Topic name in the format: projects/{project}/topics/{topic} */
  readonly name: string;
  /** Labels for the topic */
  readonly labels: Record<string, string>;
  /** Message storage policy configuration */
  readonly messageStoragePolicy?: MessageStoragePolicy | undefined;
  /** KMS key name for encryption */
  readonly kmsKeyName?: string | undefined;
  /** Schema settings for message validation */
  readonly schemaSettings?: SchemaSettings | undefined;
  /** Whether the topic satisfies Pub/Sub zone separation */
  readonly satisfiesPzs: boolean;
  /** Duration for retaining messages */
  readonly messageRetentionDuration?: string | undefined;
  /** Project ID extracted from topic name */
  readonly projectId: string;
  /** Topic ID extracted from topic name */
  readonly topicId: string;
}

/**
 * Message storage policy for topics
 */
export interface MessageStoragePolicy {
  /** List of regions where messages can be stored */
  readonly allowedPersistenceRegions?: string[] | undefined;
}

/**
 * Schema settings for topic message validation
 */
export interface SchemaSettings {
  /** Schema resource name */
  readonly schema?: string | undefined;
  /** Message encoding format */
  readonly encoding?: 'JSON' | 'BINARY' | undefined;
  /** First revision ID */
  readonly firstRevisionId?: string;
  /** Last revision ID */
  readonly lastRevisionId?: string;
}

/**
 * Subscription entity representing a Pub/Sub subscription
 */
export interface SubscriptionRecord extends BaseRecord {
  /** Subscription name in the format: projects/{project}/subscriptions/{subscription} */
  readonly name: string;
  /** Topic name this subscription is attached to */
  readonly topic: string;
  /** Push configuration for push subscriptions */
  readonly pushConfig?: PushConfig | undefined;
  /** BigQuery configuration for BigQuery subscriptions */
  readonly bigqueryConfig?: BigQueryConfig | undefined;
  /** Cloud Storage configuration */
  readonly cloudStorageConfig?: CloudStorageConfig | undefined;
  /** Acknowledgment deadline in seconds */
  readonly ackDeadlineSeconds: number;
  /** Whether to retain acknowledged messages */
  readonly retainAckedMessages: boolean;
  /** Message retention duration */
  readonly messageRetentionDuration?: string | undefined;
  /** Labels for the subscription */
  readonly labels: Record<string, string>;
  /** Whether to enable message ordering */
  readonly enableMessageOrdering: boolean;
  /** Expiration policy for the subscription */
  readonly expirationPolicy?: ExpirationPolicy | undefined;
  /** Filter expression for messages */
  readonly filter?: string | undefined;
  /** Dead letter policy */
  readonly deadLetterPolicy?: DeadLetterPolicy | undefined;
  /** Retry policy */
  readonly retryPolicy?: RetryPolicy | undefined;
  /** Whether the subscription is detached */
  readonly detached: boolean;
  /** Whether to enable exactly-once delivery */
  readonly enableExactlyOnceDelivery: boolean;
  /** Topic message retention duration */
  readonly topicMessageRetentionDuration?: string | undefined;
  /** Subscription state */
  readonly state: 'ACTIVE' | 'RESOURCE_ERROR';
  /** Project ID extracted from subscription name */
  readonly projectId: string;
  /** Subscription ID extracted from subscription name */
  readonly subscriptionId: string;
  /** Topic ID extracted from topic name */
  readonly topicId: string;
}

/**
 * Push configuration for push subscriptions
 */
export interface PushConfig {
  /** Push endpoint URL */
  readonly pushEndpoint?: string;
  /** Additional attributes for push requests */
  readonly attributes?: Record<string, string>;
  /** OIDC token configuration */
  readonly oidcToken?: OidcToken;
  /** Pub/Sub wrapper configuration */
  readonly pubsubWrapper?: PubsubWrapper;
  /** No wrapper configuration */
  readonly noWrapper?: NoWrapper;
}

/**
 * OIDC token configuration for push subscriptions
 */
export interface OidcToken {
  /** Service account email for OIDC token */
  readonly serviceAccountEmail: string;
  /** Audience for the OIDC token */
  readonly audience?: string;
}

/**
 * Pub/Sub wrapper configuration (empty object)
 */
export type PubsubWrapper = Record<never, never>;

/**
 * No wrapper configuration
 */
export interface NoWrapper {
  /** Whether to write metadata */
  readonly writeMetadata: boolean;
}

/**
 * BigQuery configuration for subscriptions
 */
export interface BigQueryConfig {
  /** BigQuery table name */
  readonly table?: string;
  /** Whether to use topic schema */
  readonly useTopicSchema?: boolean;
  /** Whether to write metadata */
  readonly writeMetadata?: boolean;
  /** Whether to drop unknown fields */
  readonly dropUnknownFields?: boolean;
  /** BigQuery config state */
  readonly state?: 'ACTIVE' | 'PERMISSION_DENIED' | 'NOT_FOUND' | 'SCHEMA_MISMATCH';
}

/**
 * Cloud Storage configuration for subscriptions
 */
export interface CloudStorageConfig {
  /** Cloud Storage bucket name */
  readonly bucket?: string;
  /** Filename prefix */
  readonly filenamePrefix?: string;
  /** Filename suffix */
  readonly filenameSuffix?: string;
  /** Text configuration */
  readonly textConfig?: TextConfig;
  /** Avro configuration */
  readonly avroConfig?: AvroConfig;
  /** Maximum duration before creating a new file */
  readonly maxDuration?: string;
  /** Maximum bytes before creating a new file */
  readonly maxBytes?: string;
  /** Cloud Storage config state */
  readonly state?: 'ACTIVE' | 'PERMISSION_DENIED' | 'NOT_FOUND';
}

/**
 * Text configuration (empty object)
 */
export type TextConfig = Record<never, never>;

/**
 * Avro configuration
 */
export interface AvroConfig {
  /** Whether to write metadata */
  readonly writeMetadata?: boolean;
}

/**
 * Expiration policy for subscriptions
 */
export interface ExpirationPolicy {
  /** Time-to-live duration */
  readonly ttl?: string;
}

/**
 * Dead letter policy for failed message handling
 */
export interface DeadLetterPolicy {
  /** Dead letter topic name */
  readonly deadLetterTopic?: string;
  /** Maximum delivery attempts before sending to dead letter topic */
  readonly maxDeliveryAttempts?: number;
}

/**
 * Retry policy for message delivery
 */
export interface RetryPolicy {
  /** Minimum backoff duration */
  readonly minimumBackoff?: string;
  /** Maximum backoff duration */
  readonly maximumBackoff?: string;
}

/**
 * Message entity representing a Pub/Sub message
 */
export interface MessageRecord extends BaseRecord {
  /** Unique message ID */
  readonly messageId: string;
  /** Topic name where message was published */
  readonly topic: string;
  /** Message data (Base64 encoded) */
  readonly data?: string | undefined;
  /** Message attributes */
  readonly attributes: Record<string, string>;
  /** Message publish time */
  readonly publishTime: Date;
  /** Ordering key for message ordering */
  readonly orderingKey?: string | undefined;
  /** Message size in bytes */
  readonly size: number;
  /** Number of delivery attempts */
  readonly deliveryAttempts: number;
  /** Message expiration time */
  readonly expirationTime?: Date | undefined;
  /** Whether message is acknowledged */
  readonly acknowledged: boolean;
  /** Acknowledgment ID for tracking */
  readonly ackId?: string | undefined;
  /** Time when message was acknowledged */
  readonly acknowledgedAt?: Date | undefined;
  /** Project ID extracted from topic name */
  readonly projectId: string;
  /** Topic ID extracted from topic name */
  readonly topicId: string;
}

/**
 * Subscription lease entity for tracking message leases
 */
export interface SubscriptionLeaseRecord extends BaseRecord {
  /** Message ID being leased */
  readonly messageId: string;
  /** Subscription name that has the lease */
  readonly subscriptionName: string;
  /** Acknowledgment ID for the lease */
  readonly ackId: string;
  /** Lease deadline timestamp */
  readonly leaseDeadline: Date;
  /** Number of delivery attempts for this lease */
  readonly deliveryAttempts: number;
  /** Project ID */
  readonly projectId: string;
  /** Subscription ID */
  readonly subscriptionId: string;
}

/**
 * Database schema for topics table
 */
export const TOPICS_SCHEMA: TableSchema = {
  name: 'pubsub_topics',
  columns: [
    { name: 'id', type: 'string', primaryKey: true },
    { name: 'createdAt', type: 'date', nullable: false },
    { name: 'updatedAt', type: 'date', nullable: false },
    { name: 'name', type: 'string', nullable: false, unique: true },
    { name: 'labels', type: 'json', nullable: false, defaultValue: '{}' },
    { name: 'messageStoragePolicy', type: 'json', nullable: true },
    { name: 'kmsKeyName', type: 'string', nullable: true },
    { name: 'schemaSettings', type: 'json', nullable: true },
    { name: 'satisfiesPzs', type: 'boolean', nullable: false, defaultValue: false },
    { name: 'messageRetentionDuration', type: 'string', nullable: true },
    { name: 'projectId', type: 'string', nullable: false },
    { name: 'topicId', type: 'string', nullable: false },
  ],
  indexes: [
    { name: 'idx_topics_name', columns: ['name'], unique: false },
    { name: 'idx_topics_project', columns: ['projectId'], unique: false },
    { name: 'idx_topics_project_topic', columns: ['projectId', 'topicId'], unique: false },
  ],
};

/**
 * Database schema for subscriptions table
 */
export const SUBSCRIPTIONS_SCHEMA: TableSchema = {
  name: 'pubsub_subscriptions',
  columns: [
    { name: 'id', type: 'string', primaryKey: true },
    { name: 'createdAt', type: 'date', nullable: false },
    { name: 'updatedAt', type: 'date', nullable: false },
    { name: 'name', type: 'string', nullable: false, unique: true },
    { name: 'topic', type: 'string', nullable: false },
    { name: 'pushConfig', type: 'json', nullable: true },
    { name: 'bigqueryConfig', type: 'json', nullable: true },
    { name: 'cloudStorageConfig', type: 'json', nullable: true },
    { name: 'ackDeadlineSeconds', type: 'number', nullable: false, defaultValue: 10 },
    { name: 'retainAckedMessages', type: 'boolean', nullable: false, defaultValue: false },
    { name: 'messageRetentionDuration', type: 'string', nullable: true },
    { name: 'labels', type: 'json', nullable: false, defaultValue: '{}' },
    { name: 'enableMessageOrdering', type: 'boolean', nullable: false, defaultValue: false },
    { name: 'expirationPolicy', type: 'json', nullable: true },
    { name: 'filter', type: 'string', nullable: true },
    { name: 'deadLetterPolicy', type: 'json', nullable: true },
    { name: 'retryPolicy', type: 'json', nullable: true },
    { name: 'detached', type: 'boolean', nullable: false, defaultValue: false },
    { name: 'enableExactlyOnceDelivery', type: 'boolean', nullable: false, defaultValue: false },
    { name: 'topicMessageRetentionDuration', type: 'string', nullable: true },
    { name: 'state', type: 'string', nullable: false, defaultValue: 'ACTIVE' },
    { name: 'projectId', type: 'string', nullable: false },
    { name: 'subscriptionId', type: 'string', nullable: false },
    { name: 'topicId', type: 'string', nullable: false },
  ],
  indexes: [
    { name: 'idx_subscriptions_name', columns: ['name'], unique: false },
    { name: 'idx_subscriptions_topic', columns: ['topic'], unique: false },
    { name: 'idx_subscriptions_project', columns: ['projectId'], unique: false },
    {
      name: 'idx_subscriptions_project_subscription',
      columns: ['projectId', 'subscriptionId'],
      unique: false,
    },
    { name: 'idx_subscriptions_project_topic', columns: ['projectId', 'topicId'], unique: false },
  ],
};

/**
 * Database schema for messages table
 */
export const MESSAGES_SCHEMA: TableSchema = {
  name: 'pubsub_messages',
  columns: [
    { name: 'id', type: 'string', primaryKey: true },
    { name: 'createdAt', type: 'date', nullable: false },
    { name: 'updatedAt', type: 'date', nullable: false },
    { name: 'messageId', type: 'string', nullable: false, unique: true },
    { name: 'topic', type: 'string', nullable: false },
    { name: 'data', type: 'string', nullable: true },
    { name: 'attributes', type: 'json', nullable: false, defaultValue: '{}' },
    { name: 'publishTime', type: 'date', nullable: false },
    { name: 'orderingKey', type: 'string', nullable: true },
    { name: 'size', type: 'number', nullable: false },
    { name: 'deliveryAttempts', type: 'number', nullable: false, defaultValue: 0 },
    { name: 'expirationTime', type: 'date', nullable: true },
    { name: 'acknowledged', type: 'boolean', nullable: false, defaultValue: false },
    { name: 'ackId', type: 'string', nullable: true },
    { name: 'acknowledgedAt', type: 'date', nullable: true },
    { name: 'projectId', type: 'string', nullable: false },
    { name: 'topicId', type: 'string', nullable: false },
  ],
  indexes: [
    { name: 'idx_messages_messageId', columns: ['messageId'], unique: false },
    { name: 'idx_messages_topic', columns: ['topic'], unique: false },
    { name: 'idx_messages_publishTime', columns: ['publishTime'], unique: false },
    { name: 'idx_messages_acknowledged', columns: ['acknowledged'], unique: false },
    { name: 'idx_messages_orderingKey', columns: ['orderingKey'], unique: false },
    { name: 'idx_messages_project_topic', columns: ['projectId', 'topicId'], unique: false },
    { name: 'idx_messages_expiration', columns: ['expirationTime'], unique: false },
  ],
};

/**
 * Database schema for subscription leases table
 */
export const SUBSCRIPTION_LEASES_SCHEMA: TableSchema = {
  name: 'pubsub_subscription_leases',
  columns: [
    { name: 'id', type: 'string', primaryKey: true },
    { name: 'createdAt', type: 'date', nullable: false },
    { name: 'updatedAt', type: 'date', nullable: false },
    { name: 'messageId', type: 'string', nullable: false },
    { name: 'subscriptionName', type: 'string', nullable: false },
    { name: 'ackId', type: 'string', nullable: false, unique: true },
    { name: 'leaseDeadline', type: 'date', nullable: false },
    { name: 'deliveryAttempts', type: 'number', nullable: false, defaultValue: 1 },
    { name: 'projectId', type: 'string', nullable: false },
    { name: 'subscriptionId', type: 'string', nullable: false },
  ],
  indexes: [
    { name: 'idx_leases_messageId', columns: ['messageId'], unique: false },
    { name: 'idx_leases_subscription', columns: ['subscriptionName'], unique: false },
    { name: 'idx_leases_ackId', columns: ['ackId'], unique: false },
    { name: 'idx_leases_deadline', columns: ['leaseDeadline'], unique: false },
    {
      name: 'idx_leases_project_subscription',
      columns: ['projectId', 'subscriptionId'],
      unique: false,
    },
  ],
};

/**
 * Utility functions for working with Pub/Sub resource names
 */
export class PubSubResourceNames {
  /**
   * Parse topic name into components
   */
  static parseTopic(name: string): { projectId: string; topicId: string } {
    const match = name.match(/^projects\/([^/]+)\/topics\/([^/]+)$/);

    if (!match) {
      throw new Error(`Invalid topic name format: ${name}`);
    }
    const projectId = match[1];
    const topicId = match[2];

    if (!projectId || !topicId) {
      throw new Error(`Invalid topic name format: ${name}`);
    }

    return { projectId, topicId };
  }

  /**
   * Parse subscription name into components
   */
  static parseSubscription(name: string): { projectId: string; subscriptionId: string } {
    const match = name.match(/^projects\/([^/]+)\/subscriptions\/([^/]+)$/);

    if (!match) {
      throw new Error(`Invalid subscription name format: ${name}`);
    }
    const projectId = match[1];
    const subscriptionId = match[2];

    if (!projectId || !subscriptionId) {
      throw new Error(`Invalid subscription name format: ${name}`);
    }

    return { projectId, subscriptionId };
  }

  /**
   * Format topic name from components
   */
  static formatTopic(projectId: string, topicId: string): string {
    return `projects/${projectId}/topics/${topicId}`;
  }

  /**
   * Format subscription name from components
   */
  static formatSubscription(projectId: string, subscriptionId: string): string {
    return `projects/${projectId}/subscriptions/${subscriptionId}`;
  }

  /**
   * Extract topic ID from topic name
   */
  static extractTopicId(topicName: string): string {
    return this.parseTopic(topicName).topicId;
  }

  /**
   * Extract project ID from topic name
   */
  static extractProjectId(topicName: string): string {
    return this.parseTopic(topicName).projectId;
  }
}
