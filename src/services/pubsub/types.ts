/**
 * Cloud Pub/Sub data models, schemas, and helper functions
 */

import { z } from 'zod';
import type { RouteResponse } from '@/core/gateway/request-router.ts';
import type { ResponseUtils } from '@/core/gateway/response-handlers.ts';
import type { BaseRecord, TableSchema } from '@/core/storage/types.ts';

// ── Constants ──

export const PUBSUB_TOPICS_TABLE = 'pubsub_topics';
export const PUBSUB_SUBSCRIPTIONS_TABLE = 'pubsub_subscriptions';
export const PUBSUB_MESSAGES_TABLE = 'pubsub_messages';
export const PUBSUB_DELIVERED_MESSAGES_TABLE = 'pubsub_delivered_messages';
export const PUBSUB_SNAPSHOTS_TABLE = 'pubsub_snapshots';
export const PUBSUB_SCHEMAS_TABLE = 'pubsub_schemas';

const TopicState = {
  ACTIVE: 'ACTIVE',
  INGESTION_RESOURCE_ERROR: 'INGESTION_RESOURCE_ERROR',
} as const;

export const AckStatus = {
  PENDING: 'PENDING',
  ACKED: 'ACKED',
} as const;

export const DEFAULT_ACK_DEADLINE_SECONDS = 10;
export const DEFAULT_MESSAGE_RETENTION = '604800s'; // 7 days

// ── Error Class ──

export type PubSubErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_ARGUMENT'
  | 'FAILED_PRECONDITION';

export class PubSubError extends Error {
  readonly code: PubSubErrorCode;
  readonly resourceName: string | undefined;

  constructor(code: PubSubErrorCode, message: string, resourceName?: string) {
    super(message);
    this.name = 'PubSubError';
    this.code = code;
    this.resourceName = resourceName;
  }
}

export function handlePubSubError(
  err: unknown,
  resourceType: string,
  responseUtils: ResponseUtils
): RouteResponse {
  if (err instanceof PubSubError) {
    switch (err.code) {
      case 'NOT_FOUND':
        return responseUtils.notFound(resourceType, err.resourceName);
      case 'ALREADY_EXISTS':
        return responseUtils.alreadyExists(resourceType, err.resourceName ?? resourceType);
      case 'INVALID_ARGUMENT':
        return responseUtils.badRequest(err.message);
      case 'FAILED_PRECONDITION':
        return responseUtils.failedPrecondition(err.message);
    }
  }

  return responseUtils.internalError(err instanceof Error ? err.message : 'Internal server error');
}

// ── Response Interfaces ──

export interface TopicResponse {
  name: string;
  labels?: Record<string, string>;
  messageRetentionDuration?: string;
  kmsKeyName?: string;
  schemaSettings?: SchemaSettings;
  satisfiesPzs?: boolean;
  messageStoragePolicy?: MessageStoragePolicy;
  ingestionDataSourceSettings?: Record<string, unknown>;
  state?: string;
}

export interface SchemaSettings {
  schema?: string;
  encoding?: string;
  firstRevisionId?: string;
  lastRevisionId?: string;
}

export interface MessageStoragePolicy {
  allowedPersistenceRegions?: string[];
  enforceInTransit?: boolean;
}

export interface SubscriptionResponse {
  name: string;
  topic: string;
  pushConfig?: PushConfig;
  bigqueryConfig?: Record<string, unknown>;
  cloudStorageConfig?: Record<string, unknown>;
  ackDeadlineSeconds: number;
  retainAckedMessages?: boolean;
  messageRetentionDuration?: string;
  labels?: Record<string, string>;
  enableMessageOrdering?: boolean;
  expirationPolicy?: ExpirationPolicy;
  filter?: string;
  deadLetterPolicy?: DeadLetterPolicy;
  retryPolicy?: RetryPolicy;
  detached?: boolean;
  enableExactlyOnceDelivery?: boolean;
  topicMessageRetentionDuration?: string;
  state?: string;
}

export interface PushConfig {
  pushEndpoint?: string;
  attributes?: Record<string, string>;
  oidcToken?: { serviceAccountEmail?: string; audience?: string };
  pubsubWrapper?: Record<string, never>;
  noWrapper?: { writeMetadata?: boolean };
}

export interface ExpirationPolicy {
  ttl?: string;
}

export interface DeadLetterPolicy {
  deadLetterTopic?: string;
  maxDeliveryAttempts?: number;
}

export interface RetryPolicy {
  minimumBackoff?: string;
  maximumBackoff?: string;
}

export interface PubsubMessageResponse {
  messageId: string;
  data?: string;
  attributes?: Record<string, string>;
  publishTime: string;
  orderingKey?: string;
}

export interface ReceivedMessageResponse {
  ackId: string;
  message: PubsubMessageResponse;
  deliveryAttempt?: number;
}

export interface ListTopicsResponse {
  topics: TopicResponse[];
  nextPageToken?: string;
}

export interface ListSubscriptionsResponse {
  subscriptions: SubscriptionResponse[];
  nextPageToken?: string;
}

export interface ListTopicSubscriptionsResponse {
  subscriptions: string[];
  nextPageToken?: string;
}

export interface ListTopicSnapshotsResponse {
  snapshots: string[];
  nextPageToken?: string;
}

export interface PublishResponse {
  messageIds: string[];
}

export interface PullResponse {
  receivedMessages: ReceivedMessageResponse[];
}

export interface SnapshotResponse {
  name: string;
  topic: string;
  expireTime?: string;
  labels?: Record<string, string>;
}

export interface SchemaResponse {
  name: string;
  type: string;
  definition?: string;
  revisionId: string;
  revisionCreateTime: string;
}

export interface ListSchemasResponse {
  schemas: SchemaResponse[];
  nextPageToken?: string;
}

export interface ListSchemaRevisionsResponse {
  schemas: SchemaResponse[];
  nextPageToken?: string;
}

// ── Storage Records ──

export interface TopicRecord extends BaseRecord {
  name: string;
  labels: string | null; // JSON-serialized Record<string, string>
  messageRetentionDuration: string | null;
  kmsKeyName: string | null;
  schemaSettings: string | null; // JSON-serialized SchemaSettings
  satisfiesPzs: string | null; // stored as string 'true'/'false'
  messageStoragePolicy: string | null; // JSON-serialized
  ingestionDataSourceSettings: string | null; // JSON-serialized
  state: string;
}

export interface SubscriptionRecord extends BaseRecord {
  name: string;
  topic: string;
  pushConfig: string | null; // JSON-serialized PushConfig
  bigqueryConfig: string | null;
  cloudStorageConfig: string | null;
  ackDeadlineSeconds: number;
  retainAckedMessages: number; // 0 or 1 for boolean
  messageRetentionDuration: string;
  labels: string | null;
  enableMessageOrdering: number; // 0 or 1
  expirationPolicy: string | null;
  filter: string | null;
  deadLetterPolicy: string | null;
  retryPolicy: string | null;
  detached: number; // 0 or 1
  enableExactlyOnceDelivery: number; // 0 or 1
  topicMessageRetentionDuration: string | null;
  state: string;
}

export interface MessageRecord extends BaseRecord {
  messageId: string;
  topicName: string;
  data: string | null;
  attributes: string | null; // JSON-serialized Record<string, string>
  orderingKey: string | null;
  publishTime: string;
}

export interface DeliveredMessageRecord extends BaseRecord {
  ackId: string;
  subscriptionName: string;
  messageId: string;
  deliveryAttempt: number;
  ackDeadline: string; // ISO timestamp
  ackStatus: string;
}

export interface SnapshotRecord extends BaseRecord {
  name: string;
  topic: string;
  expireTime: string | null;
  labels: string | null;
}

export interface SchemaRecord extends BaseRecord {
  name: string;
  type: string;
  definition: string | null;
  revisionId: string;
  revisionCreateTime: string;
}

// ── Table Schemas ──

export const pubsubTopicsTableSchema: TableSchema = {
  name: PUBSUB_TOPICS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'labels', type: 'json', nullable: true },
    { name: 'messageRetentionDuration', type: 'string', nullable: true },
    { name: 'kmsKeyName', type: 'string', nullable: true },
    { name: 'schemaSettings', type: 'json', nullable: true },
    { name: 'satisfiesPzs', type: 'string', nullable: true },
    { name: 'messageStoragePolicy', type: 'json', nullable: true },
    { name: 'ingestionDataSourceSettings', type: 'json', nullable: true },
    { name: 'state', type: 'string' },
  ],
  indexes: [{ name: 'idx_pubsub_topics_name', columns: ['name'], unique: true }],
  timestamps: true,
};

export const pubsubSubscriptionsTableSchema: TableSchema = {
  name: PUBSUB_SUBSCRIPTIONS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'topic', type: 'string' },
    { name: 'pushConfig', type: 'json', nullable: true },
    { name: 'bigqueryConfig', type: 'json', nullable: true },
    { name: 'cloudStorageConfig', type: 'json', nullable: true },
    { name: 'ackDeadlineSeconds', type: 'number' },
    { name: 'retainAckedMessages', type: 'number' },
    { name: 'messageRetentionDuration', type: 'string' },
    { name: 'labels', type: 'json', nullable: true },
    { name: 'enableMessageOrdering', type: 'number' },
    { name: 'expirationPolicy', type: 'json', nullable: true },
    { name: 'filter', type: 'string', nullable: true },
    { name: 'deadLetterPolicy', type: 'json', nullable: true },
    { name: 'retryPolicy', type: 'json', nullable: true },
    { name: 'detached', type: 'number' },
    { name: 'enableExactlyOnceDelivery', type: 'number' },
    { name: 'topicMessageRetentionDuration', type: 'string', nullable: true },
    { name: 'state', type: 'string' },
  ],
  indexes: [
    { name: 'idx_pubsub_subscriptions_name', columns: ['name'], unique: true },
    { name: 'idx_pubsub_subscriptions_topic', columns: ['topic'] },
  ],
  timestamps: true,
};

export const pubsubMessagesTableSchema: TableSchema = {
  name: PUBSUB_MESSAGES_TABLE,
  columns: [
    { name: 'messageId', type: 'string', unique: true },
    { name: 'topicName', type: 'string' },
    { name: 'data', type: 'string', nullable: true },
    { name: 'attributes', type: 'json', nullable: true },
    { name: 'orderingKey', type: 'string', nullable: true },
    { name: 'publishTime', type: 'string' },
  ],
  indexes: [
    { name: 'idx_pubsub_messages_topic', columns: ['topicName'] },
    { name: 'idx_pubsub_messages_publish_time', columns: ['publishTime'] },
  ],
  timestamps: true,
};

export const pubsubDeliveredMessagesTableSchema: TableSchema = {
  name: PUBSUB_DELIVERED_MESSAGES_TABLE,
  columns: [
    { name: 'ackId', type: 'string', unique: true },
    { name: 'subscriptionName', type: 'string' },
    { name: 'messageId', type: 'string' },
    { name: 'deliveryAttempt', type: 'number' },
    { name: 'ackDeadline', type: 'string' },
    { name: 'ackStatus', type: 'string' },
  ],
  indexes: [
    { name: 'idx_pubsub_delivered_sub_status', columns: ['subscriptionName', 'ackStatus'] },
    { name: 'idx_pubsub_delivered_deadline', columns: ['ackDeadline'] },
    { name: 'idx_pubsub_delivered_message', columns: ['messageId'] },
  ],
  timestamps: true,
};

export const pubsubSnapshotsTableSchema: TableSchema = {
  name: PUBSUB_SNAPSHOTS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'topic', type: 'string' },
    { name: 'expireTime', type: 'string', nullable: true },
    { name: 'labels', type: 'json', nullable: true },
  ],
  indexes: [{ name: 'idx_pubsub_snapshots_name', columns: ['name'], unique: true }],
  timestamps: true,
};

export const pubsubSchemasTableSchema: TableSchema = {
  name: PUBSUB_SCHEMAS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'type', type: 'string' },
    { name: 'definition', type: 'string', nullable: true },
    { name: 'revisionId', type: 'string' },
    { name: 'revisionCreateTime', type: 'string' },
  ],
  indexes: [{ name: 'idx_pubsub_schemas_name', columns: ['name'], unique: true }],
  timestamps: true,
};

// ── Zod Validation Schemas ──

export const CreateTopicRequestSchema = z
  .object({
    labels: z.record(z.string(), z.string()).optional(),
    messageRetentionDuration: z.string().optional(),
    kmsKeyName: z.string().optional(),
    schemaSettings: z
      .object({
        schema: z.string().optional(),
        encoding: z.string().optional(),
        firstRevisionId: z.string().optional(),
        lastRevisionId: z.string().optional(),
      })
      .optional(),
    satisfiesPzs: z.boolean().optional(),
    messageStoragePolicy: z
      .object({
        allowedPersistenceRegions: z.array(z.string()).optional(),
        enforceInTransit: z.boolean().optional(),
      })
      .optional(),
    ingestionDataSourceSettings: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const PubsubMessageSchema = z.object({
  data: z.string().optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  orderingKey: z.string().optional(),
});

export const PublishRequestSchema = z.object({
  messages: z.array(PubsubMessageSchema).min(1),
});

export const CreateSubscriptionRequestSchema = z
  .object({
    topic: z.string().min(1),
    pushConfig: z
      .object({
        pushEndpoint: z.string().optional(),
        attributes: z.record(z.string(), z.string()).optional(),
        oidcToken: z
          .object({
            serviceAccountEmail: z.string().optional(),
            audience: z.string().optional(),
          })
          .optional(),
        noWrapper: z.object({ writeMetadata: z.boolean().optional() }).optional(),
      })
      .optional(),
    bigqueryConfig: z.record(z.string(), z.unknown()).optional(),
    cloudStorageConfig: z.record(z.string(), z.unknown()).optional(),
    ackDeadlineSeconds: z.number().int().min(10).max(600).optional(),
    retainAckedMessages: z.boolean().optional(),
    messageRetentionDuration: z.string().optional(),
    labels: z.record(z.string(), z.string()).optional(),
    enableMessageOrdering: z.boolean().optional(),
    expirationPolicy: z.object({ ttl: z.string().optional() }).optional(),
    filter: z.string().optional(),
    deadLetterPolicy: z
      .object({
        deadLetterTopic: z.string().optional(),
        maxDeliveryAttempts: z.number().int().optional(),
      })
      .optional(),
    retryPolicy: z
      .object({
        minimumBackoff: z.string().optional(),
        maximumBackoff: z.string().optional(),
      })
      .optional(),
    enableExactlyOnceDelivery: z.boolean().optional(),
  })
  .passthrough();

// ── Resource Name Helpers ──

export function parseTopicName(name: string): { project: string; topic: string } {
  const match = name.match(/^projects\/([^/]+)\/topics\/([^/]+)$/);

  if (!match) {
    throw new Error(
      `Invalid topic resource name: "${name}". Expected format: projects/{project}/topics/{topic}`
    );
  }

  return {
    project: match[1] as string,
    topic: match[2] as string,
  };
}

export function buildTopicName(project: string, topic: string): string {
  return `projects/${project}/topics/${topic}`;
}

export function parseSubscriptionName(name: string): {
  project: string;
  subscription: string;
} {
  const match = name.match(/^projects\/([^/]+)\/subscriptions\/([^/]+)$/);

  if (!match) {
    throw new Error(
      `Invalid subscription resource name: "${name}". Expected format: projects/{project}/subscriptions/{subscription}`
    );
  }

  return {
    project: match[1] as string,
    subscription: match[2] as string,
  };
}

export function buildSubscriptionName(project: string, subscription: string): string {
  return `projects/${project}/subscriptions/${subscription}`;
}

export function parseSnapshotName(name: string): {
  project: string;
  snapshot: string;
} {
  const match = name.match(/^projects\/([^/]+)\/snapshots\/([^/]+)$/);

  if (!match) {
    throw new Error(
      `Invalid snapshot resource name: "${name}". Expected format: projects/{project}/snapshots/{snapshot}`
    );
  }

  return {
    project: match[1] as string,
    snapshot: match[2] as string,
  };
}

export function buildSnapshotName(project: string, snapshot: string): string {
  return `projects/${project}/snapshots/${snapshot}`;
}

export function parseSchemaName(name: string): { project: string; schema: string } {
  const match = name.match(/^projects\/([^/]+)\/schemas\/([^/]+)$/);

  if (!match) {
    throw new Error(
      `Invalid schema resource name: "${name}". Expected format: projects/{project}/schemas/{schema}`
    );
  }

  return {
    project: match[1] as string,
    schema: match[2] as string,
  };
}

export function buildSchemaName(project: string, schema: string): string {
  return `projects/${project}/schemas/${schema}`;
}

// ── Conversion Utilities ──

function parseJsonFieldOptional<T>(json: string | null): T | undefined {
  if (json == null) return undefined;

  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}

export function topicRecordToResponse(record: TopicRecord): TopicResponse {
  const response: TopicResponse = {
    name: record.name,
    state: record.state,
  };

  const labels = parseJsonFieldOptional<Record<string, string>>(record.labels);

  if (labels) {
    response.labels = labels;
  }

  if (record.messageRetentionDuration) {
    response.messageRetentionDuration = record.messageRetentionDuration;
  }

  if (record.kmsKeyName) {
    response.kmsKeyName = record.kmsKeyName;
  }

  const schemaSettings = parseJsonFieldOptional<SchemaSettings>(record.schemaSettings);

  if (schemaSettings) {
    response.schemaSettings = schemaSettings;
  }

  if (record.satisfiesPzs != null) {
    response.satisfiesPzs = record.satisfiesPzs === 'true';
  }

  const messageStoragePolicy = parseJsonFieldOptional<MessageStoragePolicy>(
    record.messageStoragePolicy
  );

  if (messageStoragePolicy) {
    response.messageStoragePolicy = messageStoragePolicy;
  }

  const ingestionDataSourceSettings = parseJsonFieldOptional<Record<string, unknown>>(
    record.ingestionDataSourceSettings
  );

  if (ingestionDataSourceSettings) {
    response.ingestionDataSourceSettings = ingestionDataSourceSettings;
  }

  return response;
}

export function topicRequestToRecord(
  name: string,
  body: Record<string, unknown>
): Omit<TopicRecord, keyof BaseRecord> {
  return {
    name,
    labels: body.labels ? JSON.stringify(body.labels) : null,
    messageRetentionDuration: (body.messageRetentionDuration as string) ?? null,
    kmsKeyName: (body.kmsKeyName as string) ?? null,
    schemaSettings: body.schemaSettings ? JSON.stringify(body.schemaSettings) : null,
    satisfiesPzs: body.satisfiesPzs != null ? String(body.satisfiesPzs) : null,
    messageStoragePolicy: body.messageStoragePolicy
      ? JSON.stringify(body.messageStoragePolicy)
      : null,
    ingestionDataSourceSettings: body.ingestionDataSourceSettings
      ? JSON.stringify(body.ingestionDataSourceSettings)
      : null,
    state: TopicState.ACTIVE,
  };
}

export function subscriptionRecordToResponse(record: SubscriptionRecord): SubscriptionResponse {
  const response: SubscriptionResponse = {
    name: record.name,
    topic: record.topic,
    ackDeadlineSeconds: record.ackDeadlineSeconds,
    messageRetentionDuration: record.messageRetentionDuration,
    state: record.state,
  };

  if (record.retainAckedMessages) {
    response.retainAckedMessages = true;
  }

  if (record.enableMessageOrdering) {
    response.enableMessageOrdering = true;
  }

  if (record.enableExactlyOnceDelivery) {
    response.enableExactlyOnceDelivery = true;
  }

  if (record.detached) {
    response.detached = true;
  }

  if (record.filter) {
    response.filter = record.filter;
  }

  if (record.topicMessageRetentionDuration) {
    response.topicMessageRetentionDuration = record.topicMessageRetentionDuration;
  }

  const labels = parseJsonFieldOptional<Record<string, string>>(record.labels);

  if (labels) {
    response.labels = labels;
  }

  const pushConfig = parseJsonFieldOptional<PushConfig>(record.pushConfig);

  if (pushConfig) {
    response.pushConfig = pushConfig;
  }

  const bigqueryConfig = parseJsonFieldOptional<Record<string, unknown>>(record.bigqueryConfig);

  if (bigqueryConfig) {
    response.bigqueryConfig = bigqueryConfig;
  }

  const cloudStorageConfig = parseJsonFieldOptional<Record<string, unknown>>(
    record.cloudStorageConfig
  );

  if (cloudStorageConfig) {
    response.cloudStorageConfig = cloudStorageConfig;
  }

  const expirationPolicy = parseJsonFieldOptional<ExpirationPolicy>(record.expirationPolicy);

  if (expirationPolicy) {
    response.expirationPolicy = expirationPolicy;
  }

  const deadLetterPolicy = parseJsonFieldOptional<DeadLetterPolicy>(record.deadLetterPolicy);

  if (deadLetterPolicy) {
    response.deadLetterPolicy = deadLetterPolicy;
  }

  const retryPolicy = parseJsonFieldOptional<RetryPolicy>(record.retryPolicy);

  if (retryPolicy) {
    response.retryPolicy = retryPolicy;
  }

  return response;
}

export function schemaRecordToResponse(record: SchemaRecord): SchemaResponse {
  const response: SchemaResponse = {
    name: record.name,
    type: record.type,
    revisionId: record.revisionId,
    revisionCreateTime: record.revisionCreateTime,
  };

  if (record.definition != null) {
    response.definition = record.definition;
  }

  return response;
}
