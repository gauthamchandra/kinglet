/**
 * Cloud Pub/Sub gRPC Handlers
 *
 * Translates incoming gRPC calls (Publisher, Subscriber, SchemaService) into
 * service-layer calls and converts between the formats used by the service
 * layer (ISO timestamps, base64 data, string durations) and the protobuf
 * message shapes that proto-loader deserialises into JS objects.
 *
 * StreamingPull is registered as an UNIMPLEMENTED stub.  A fast-follow PR
 * on cursor/pubsub-grpc-streaming-pull-b4ca will add the full implementation.
 *
 * Known gaps:
 *   - StreamingPull always returns UNIMPLEMENTED.
 *   - grpc-status-details-bin trailing metadata is not sent.
 *   - IAM methods (GetIamPolicy, SetIamPolicy, TestIamPermissions) are
 *     provided by the IAMPolicy service binding outside this file; they are
 *     not part of Publisher or Subscriber according to the Pub/Sub proto.
 */

import * as grpc from '@grpc/grpc-js';
import type { SchemaService } from './schema-service.ts';
import type { SnapshotService } from './snapshot-service.ts';
import type { SubscriptionService } from './subscription-service.ts';
import type { TopicService } from './topic-service.ts';
import type {
  SchemaResponse,
  SnapshotResponse,
  SubscriptionResponse,
  TopicResponse,
} from './types.ts';
import { PubSubError, parseSnapshotName, parseSubscriptionName, parseTopicName } from './types.ts';

// ── Proto message shapes (what proto-loader deserialises into JS) ──

interface ProtoTimestamp {
  seconds: string;
  nanos: number;
}

interface ProtoDuration {
  seconds?: string | number;
  nanos?: number;
}

interface ProtoFieldMask {
  paths?: string[];
}

interface CreateTopicRequest {
  name: string;
  labels?: Record<string, string>;
  messageRetentionDuration?: string;
  kmsKeyName?: string;
  schemaSettings?: Record<string, unknown>;
  satisfiesPzs?: boolean;
  messageStoragePolicy?: Record<string, unknown>;
  ingestionDataSourceSettings?: Record<string, unknown>;
}

interface UpdateTopicRequest {
  topic: {
    name: string;
    labels?: Record<string, string>;
    messageRetentionDuration?: string;
    [key: string]: unknown;
  };
  updateMask?: ProtoFieldMask;
}

interface GetTopicRequest {
  topic: string;
}

interface ListTopicsRequest {
  project: string;
  pageSize?: number;
  pageToken?: string;
}

interface DeleteTopicRequest {
  topic: string;
}

interface PublishRequest {
  topic: string;
  messages: Array<{
    data?: Uint8Array | string;
    attributes?: Record<string, string>;
    orderingKey?: string;
  }>;
}

interface ListTopicSubscriptionsRequest {
  topic: string;
  pageSize?: number;
  pageToken?: string;
}

interface ListTopicSnapshotsRequest {
  topic: string;
  pageSize?: number;
  pageToken?: string;
}

interface DetachSubscriptionRequest {
  subscription: string;
}

interface CreateSubscriptionRequest {
  name: string;
  topic: string;
  pushConfig?: Record<string, unknown>;
  bigqueryConfig?: Record<string, unknown>;
  cloudStorageConfig?: Record<string, unknown>;
  ackDeadlineSeconds?: number;
  retainAckedMessages?: boolean;
  messageRetentionDuration?: string;
  labels?: Record<string, string>;
  enableMessageOrdering?: boolean;
  expirationPolicy?: Record<string, unknown>;
  filter?: string;
  deadLetterPolicy?: Record<string, unknown>;
  retryPolicy?: Record<string, unknown>;
  enableExactlyOnceDelivery?: boolean;
}

interface GetSubscriptionRequest {
  subscription: string;
}

interface UpdateSubscriptionRequest {
  subscription: {
    name: string;
    ackDeadlineSeconds?: number;
    [key: string]: unknown;
  };
  updateMask?: ProtoFieldMask;
}

interface ListSubscriptionsRequest {
  project: string;
  pageSize?: number;
  pageToken?: string;
}

interface DeleteSubscriptionRequest {
  subscription: string;
}

interface ModifyAckDeadlineRequest {
  subscription: string;
  ackIds: string[];
  ackDeadlineSeconds: number;
}

interface AcknowledgeRequest {
  subscription: string;
  ackIds: string[];
}

interface PullRequest {
  subscription: string;
  maxMessages?: number;
}

interface ModifyPushConfigRequest {
  subscription: string;
  pushConfig?: Record<string, unknown>;
}

interface SeekRequest {
  subscription: string;
  seekTo?: string;
  time?: ProtoTimestamp;
  snapshot?: string;
}

interface CreateSnapshotRequest {
  name: string;
  subscription: string;
  labels?: Record<string, string>;
}

interface GetSnapshotRequest {
  snapshot: string;
}

interface UpdateSnapshotRequest {
  snapshot: {
    name: string;
    expireTime?: ProtoTimestamp;
    labels?: Record<string, string>;
  };
  updateMask?: ProtoFieldMask;
}

interface ListSnapshotsRequest {
  project: string;
  pageSize?: number;
  pageToken?: string;
}

interface DeleteSnapshotRequest {
  snapshot: string;
}

interface CreateSchemaRequest {
  parent: string;
  schemaId?: string;
  schema?: {
    type?: string;
    definition?: string;
  };
}

interface GetSchemaRequest {
  name: string;
  view?: string;
}

interface ListSchemasRequest {
  parent: string;
  view?: string;
  pageSize?: number;
  pageToken?: string;
}

interface ListSchemaRevisionsRequest {
  name: string;
  view?: string;
  pageSize?: number;
  pageToken?: string;
}

interface CommitSchemaRequest {
  name: string;
  schema?: {
    type?: string;
    definition?: string;
  };
}

interface RollbackSchemaRequest {
  name: string;
  revisionId?: string;
}

interface DeleteSchemaRevisionRequest {
  name: string;
  revisionId?: string;
}

interface DeleteSchemaRequest {
  name: string;
}

interface ValidateSchemaRequest {
  parent: string;
  schema?: {
    type?: string;
    definition?: string;
  };
}

interface ValidateMessageRequest {
  parent: string;
  name?: string;
  encoding?: string;
  message?: Uint8Array | string;
}

interface StreamingPullRequest {
  subscription?: string;
  ackIds?: string[];
  modifyDeadlineSeconds?: number[];
  modifyDeadlineAckIds?: string[];
  streamAckDeadlineSeconds?: number;
  clientId?: string;
}

// ── Error mapping ──

const PUBSUB_ERROR_TO_GRPC: Record<string, grpc.status> = {
  NOT_FOUND: grpc.status.NOT_FOUND,
  ALREADY_EXISTS: grpc.status.ALREADY_EXISTS,
  INVALID_ARGUMENT: grpc.status.INVALID_ARGUMENT,
  FAILED_PRECONDITION: grpc.status.FAILED_PRECONDITION,
};

function toGrpcError(err: unknown): grpc.ServiceError {
  const code =
    err instanceof PubSubError
      ? (PUBSUB_ERROR_TO_GRPC[err.code] ?? grpc.status.INTERNAL)
      : grpc.status.INTERNAL;

  const message = err instanceof Error ? err.message : 'Internal server error';

  const grpcErr = Object.assign(new Error(message), {
    code,
    name: 'ServiceError',
  }) as grpc.ServiceError;

  return grpcErr;
}

// ── Data conversion utilities ──

/**
 * Convert Uint8Array or string binary data (from proto-loader) to a base64 string
 * suitable for the service layer, which stores/expects base64.
 */
function bytesToBase64(b: Uint8Array | string | null | undefined): string | undefined {
  if (b == null) {
    return undefined;
  }

  if (b instanceof Uint8Array) {
    return b.length === 0 ? undefined : Buffer.from(b).toString('base64');
  }

  return b.length === 0 ? undefined : b;
}

/**
 * Convert a base64 string from the service layer to a Uint8Array for the
 * gRPC response (proto-loader bytes fields are Uint8Array on the wire).
 */
function base64ToBytes(b64: string | null | undefined): Uint8Array | undefined {
  if (!b64) {
    return undefined;
  }

  return Buffer.from(b64, 'base64');
}

/**
 * Convert an incoming proto Duration object ({ seconds, nanos }) or an existing
 * GCP duration string ("604800s") to the service layer's "Xs" string format.
 * Returns undefined for zero/empty values so callers can skip forwarding them.
 */
function protoDurationToStr(d: ProtoDuration | string | null | undefined): string | undefined {
  if (d == null) {
    return undefined;
  }

  if (typeof d === 'string') {
    return d.endsWith('s') && d.length > 1 ? d : undefined;
  }

  const secs = typeof d.seconds === 'string' ? Number.parseInt(d.seconds, 10) : (d.seconds ?? 0);
  const nanos = d.nanos ?? 0;

  if (secs === 0 && nanos === 0) {
    return undefined;
  }

  if (nanos === 0) {
    return `${secs}s`;
  }

  const frac = String(nanos).padStart(9, '0').replace(/0+$/, '');

  return `${secs}.${frac}s`;
}

/**
 * Wrap a resource-name parse function so that malformed names produce
 * INVALID_ARGUMENT instead of INTERNAL. The parse helpers throw a plain Error
 * on bad names; toGrpcError() maps those to grpc.status.INTERNAL by default.
 */
function parseResourceName<T>(parseFn: () => T): T {
  try {
    return parseFn();
  } catch (err) {
    throw new PubSubError(
      'INVALID_ARGUMENT',
      err instanceof Error ? err.message : 'Invalid resource name'
    );
  }
}

/**
 * Page a flat array of items using an opaque base64-encoded offset cursor,
 * consistent with the service layer's own pagination tokens.
 */
function paginateItems<T>(
  items: T[],
  pageSize: number | undefined,
  pageToken: string | undefined
): { page: T[]; nextPageToken: string } {
  const effectivePageSize = pageSize != null && pageSize > 0 ? pageSize : undefined;

  let startIdx = 0;

  if (pageToken) {
    const decoded = parseInt(Buffer.from(pageToken, 'base64url').toString('utf-8'), 10);

    if (!Number.isNaN(decoded) && decoded > 0) {
      startIdx = decoded;
    }
  }

  const page = effectivePageSize
    ? items.slice(startIdx, startIdx + effectivePageSize)
    : items.slice(startIdx);

  const endIdx = startIdx + page.length;
  const nextPageToken =
    effectivePageSize != null && endIdx < items.length
      ? Buffer.from(String(endIdx)).toString('base64url')
      : '';

  return { page, nextPageToken };
}

/**
 * Convert a ProtoTimestamp to an ISO-8601 string for the service layer.
 *
 * proto-loader is loaded with `defaults: true`, so an omitted Timestamp field
 * arrives as `{ seconds: '0', nanos: 0 }`.  Duration conversion already
 * returns undefined for the zero value; mirror that here so omitted timestamps
 * are not stored as `1970-01-01T00:00:00.000Z`.
 */
function timestampToIso(ts: ProtoTimestamp | null | undefined): string | undefined {
  if (!ts) {
    return undefined;
  }

  const secs = Number.parseInt(ts.seconds, 10);
  const nanos = ts.nanos ?? 0;

  if (secs === 0 && nanos === 0) {
    return undefined;
  }

  const ms = secs * 1000 + Math.floor(nanos / 1_000_000);

  return new Date(ms).toISOString();
}

/**
 * Convert an ISO-8601 string to a ProtoTimestamp for the gRPC response.
 */
function isoToTimestamp(iso: string | null | undefined): ProtoTimestamp | undefined {
  if (!iso) {
    return undefined;
  }

  const ms = new Date(iso).getTime();
  const seconds = Math.floor(ms / 1000);
  const nanos = (ms % 1000) * 1_000_000;

  return { seconds: seconds.toString(), nanos };
}

/**
 * Convert a GCP duration string (e.g. "604800s", "3.5s") to a ProtoDuration
 * object for the gRPC response.
 */
function durationStrToProto(
  s: string | null | undefined
): { seconds: string; nanos: number } | undefined {
  if (!s) {
    return undefined;
  }

  const match = s.match(/^(\d+)(?:\.(\d+))?s$/);

  if (!match) {
    return undefined;
  }

  const seconds = match[1] ?? '0';
  const fracStr = match[2] ?? '';
  const nanos = fracStr
    ? Math.round(Number.parseInt(fracStr.padEnd(9, '0').substring(0, 9), 10))
    : 0;

  return { seconds, nanos };
}

/**
 * Normalise proto FieldMask paths (snake_case) to camelCase for the service
 * layer, which uses camelCase field names throughout.
 *
 * Every dot-separated segment is converted independently so that nested paths
 * such as `push_config.push_endpoint` become `pushConfig.pushEndpoint` rather
 * than being truncated to just `pushConfig`.  The service layer then uses the
 * full dotted path to merge only the named sub-field instead of overwriting
 * the whole nested object.
 */
const PROTO_FIELD_TO_CAMEL: Record<string, string> = {
  labels: 'labels',
  name: 'name',
  message_retention_duration: 'messageRetentionDuration',
  schema_settings: 'schemaSettings',
  message_storage_policy: 'messageStoragePolicy',
  ingestion_data_source_settings: 'ingestionDataSourceSettings',
  ack_deadline_seconds: 'ackDeadlineSeconds',
  push_config: 'pushConfig',
  bigquery_config: 'bigqueryConfig',
  cloud_storage_config: 'cloudStorageConfig',
  retain_acked_messages: 'retainAckedMessages',
  expiration_policy: 'expirationPolicy',
  dead_letter_policy: 'deadLetterPolicy',
  retry_policy: 'retryPolicy',
  enable_exactly_once_delivery: 'enableExactlyOnceDelivery',
  expire_time: 'expireTime',
  push_endpoint: 'pushEndpoint',
  oidc_token: 'oidcToken',
  no_wrapper: 'noWrapper',
  minimum_backoff: 'minimumBackoff',
  maximum_backoff: 'maximumBackoff',
  dead_letter_topic: 'deadLetterTopic',
  max_delivery_attempts: 'maxDeliveryAttempts',
  allowed_persistence_regions: 'allowedPersistenceRegions',
  encoding: 'encoding',
  schema: 'schema',
  minimum_object_create_time: 'minimumObjectCreateTime',
  max_duration: 'maxDuration',
};

/**
 * Convert a single snake_case token to camelCase using the explicit lookup
 * table first, then falling back to a generic conversion.
 */
function snakeToCamel(segment: string): string {
  return (
    PROTO_FIELD_TO_CAMEL[segment] ??
    segment.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase())
  );
}

function normaliseMaskPaths(paths: string[]): string {
  const camelPaths = paths.map(p => p.split('.').map(snakeToCamel).join('.'));

  return [...new Set(camelPaths)].join(',');
}

/**
 * Convert the service-layer `cloudStorageConfig` (which stores Duration as an
 * "Xs" string) to the proto shape expected by gRPC clients.
 */
function convertCloudStorageConfigToProto(
  config: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...config };

  if (typeof result.maxDuration === 'string') {
    result.maxDuration = durationStrToProto(result.maxDuration) ?? result.maxDuration;
  }

  return result;
}

/**
 * Normalise an inbound proto `cloudStorageConfig` (where `maxDuration` arrives
 * as a `ProtoDuration` object) to the service-layer shape (duration strings).
 */
function normaliseCloudStorageConfig(config: Record<string, unknown>): Record<string, unknown> {
  const result = { ...config };

  if (result.maxDuration != null && typeof result.maxDuration !== 'string') {
    const converted = protoDurationToStr(result.maxDuration as ProtoDuration | string | undefined);

    if (converted) {
      result.maxDuration = converted;
    } else {
      delete result.maxDuration;
    }
  }

  return result;
}

/**
 * Convert the service-layer `ingestionDataSourceSettings` (which stores
 * Timestamps as ISO strings) to the proto shape expected by gRPC clients.
 */
function convertIngestionDataSourceSettingsToProto(
  settings: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...settings };

  if (result.cloudStorage != null && typeof result.cloudStorage === 'object') {
    const cs = { ...(result.cloudStorage as Record<string, unknown>) };

    if (typeof cs.minimumObjectCreateTime === 'string') {
      cs.minimumObjectCreateTime =
        isoToTimestamp(cs.minimumObjectCreateTime) ?? cs.minimumObjectCreateTime;
    }

    result.cloudStorage = cs;
  }

  return result;
}

/**
 * Normalise an inbound proto `ingestionDataSourceSettings` (where
 * `cloudStorage.minimumObjectCreateTime` arrives as a `ProtoTimestamp` object)
 * to the service-layer shape (ISO strings).
 */
function normaliseIngestionDataSourceSettings(
  settings: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...settings };

  if (result.cloudStorage != null && typeof result.cloudStorage === 'object') {
    const cs = { ...(result.cloudStorage as Record<string, unknown>) };

    if (cs.minimumObjectCreateTime != null && typeof cs.minimumObjectCreateTime !== 'string') {
      const converted = timestampToIso(
        cs.minimumObjectCreateTime as ProtoTimestamp | null | undefined
      );

      if (converted) {
        cs.minimumObjectCreateTime = converted;
      } else {
        delete cs.minimumObjectCreateTime;
      }
    }

    result.cloudStorage = cs;
  }

  return result;
}

// ── Topic response conversion ──

function topicResponseToProto(t: TopicResponse): Record<string, unknown> {
  const proto: Record<string, unknown> = { name: t.name };

  if (t.labels) {
    proto.labels = t.labels;
  }

  if (t.messageRetentionDuration) {
    proto.messageRetentionDuration = durationStrToProto(t.messageRetentionDuration);
  }

  if (t.kmsKeyName) {
    proto.kmsKeyName = t.kmsKeyName;
  }

  if (t.schemaSettings) {
    proto.schemaSettings = t.schemaSettings;
  }

  if (t.satisfiesPzs != null) {
    proto.satisfiesPzs = t.satisfiesPzs;
  }

  if (t.messageStoragePolicy) {
    proto.messageStoragePolicy = t.messageStoragePolicy;
  }

  if (t.ingestionDataSourceSettings) {
    proto.ingestionDataSourceSettings = convertIngestionDataSourceSettingsToProto(
      t.ingestionDataSourceSettings
    );
  }

  if (t.state) {
    proto.state = t.state;
  }

  return proto;
}

// ── Subscription response conversion ──

function subscriptionResponseToProto(s: SubscriptionResponse): Record<string, unknown> {
  const proto: Record<string, unknown> = {
    name: s.name,
    topic: s.topic,
    ackDeadlineSeconds: s.ackDeadlineSeconds,
  };

  if (s.messageRetentionDuration) {
    proto.messageRetentionDuration = durationStrToProto(s.messageRetentionDuration);
  }

  if (s.retainAckedMessages) {
    proto.retainAckedMessages = s.retainAckedMessages;
  }

  if (s.labels) {
    proto.labels = s.labels;
  }

  if (s.pushConfig) {
    proto.pushConfig = s.pushConfig;
  }

  if (s.bigqueryConfig) {
    proto.bigqueryConfig = s.bigqueryConfig;
  }

  if (s.cloudStorageConfig) {
    proto.cloudStorageConfig = convertCloudStorageConfigToProto(s.cloudStorageConfig);
  }

  if (s.enableMessageOrdering) {
    proto.enableMessageOrdering = s.enableMessageOrdering;
  }

  if (s.expirationPolicy) {
    const ep = s.expirationPolicy as { ttl?: string };
    const ttlDuration = ep.ttl ? durationStrToProto(ep.ttl) : undefined;

    proto.expirationPolicy = ttlDuration ? { ttl: ttlDuration } : {};
  }

  if (s.filter) {
    proto.filter = s.filter;
  }

  if (s.deadLetterPolicy) {
    proto.deadLetterPolicy = s.deadLetterPolicy;
  }

  if (s.retryPolicy) {
    const rp = s.retryPolicy as { minimumBackoff?: string; maximumBackoff?: string };
    const rpProto: Record<string, unknown> = {};

    if (rp.minimumBackoff) {
      rpProto.minimumBackoff = durationStrToProto(rp.minimumBackoff);
    }

    if (rp.maximumBackoff) {
      rpProto.maximumBackoff = durationStrToProto(rp.maximumBackoff);
    }

    proto.retryPolicy = rpProto;
  }

  if (s.detached) {
    proto.detached = s.detached;
  }

  if (s.enableExactlyOnceDelivery) {
    proto.enableExactlyOnceDelivery = s.enableExactlyOnceDelivery;
  }

  if (s.topicMessageRetentionDuration) {
    proto.topicMessageRetentionDuration = durationStrToProto(s.topicMessageRetentionDuration);
  }

  if (s.state) {
    proto.state = s.state;
  }

  return proto;
}

// ── Snapshot response conversion ──

function snapshotResponseToProto(s: SnapshotResponse): Record<string, unknown> {
  const proto: Record<string, unknown> = {
    name: s.name,
    topic: s.topic,
  };

  if (s.expireTime) {
    proto.expireTime = isoToTimestamp(s.expireTime);
  }

  if (s.labels) {
    proto.labels = s.labels;
  }

  return proto;
}

// ── Schema response conversion ──

function schemaResponseToProto(s: SchemaResponse): Record<string, unknown> {
  const proto: Record<string, unknown> = {
    name: s.name,
    type: s.type,
    revisionId: s.revisionId,
  };

  if (s.definition != null) {
    proto.definition = s.definition;
  }

  if (s.revisionCreateTime) {
    proto.revisionCreateTime = isoToTimestamp(s.revisionCreateTime);
  }

  return proto;
}

// ── Received message conversion ──

function receivedMessageToProto(rm: {
  ackId: string;
  message: {
    messageId: string;
    data?: string;
    attributes?: Record<string, string>;
    orderingKey?: string;
    publishTime: string;
  };
  deliveryAttempt?: number;
}): Record<string, unknown> {
  const msgProto: Record<string, unknown> = {
    messageId: rm.message.messageId,
    publishTime: isoToTimestamp(rm.message.publishTime),
  };

  const dataBytes = base64ToBytes(rm.message.data);

  if (dataBytes) {
    msgProto.data = dataBytes;
  }

  if (rm.message.attributes && Object.keys(rm.message.attributes).length > 0) {
    msgProto.attributes = rm.message.attributes;
  }

  if (rm.message.orderingKey) {
    msgProto.orderingKey = rm.message.orderingKey;
  }

  const proto: Record<string, unknown> = {
    ackId: rm.ackId,
    message: msgProto,
  };

  if (rm.deliveryAttempt != null && rm.deliveryAttempt > 0) {
    proto.deliveryAttempt = rm.deliveryAttempt;
  }

  return proto;
}

// ── Handler class ──

export class PubSubGrpcHandlers {
  private topicService: TopicService;
  private subscriptionService: SubscriptionService;
  private snapshotService: SnapshotService;
  private schemaService: SchemaService;

  /**
   * Per-stream stop closures.  Each entry sets `cancelled`, clears the poll
   * timer, removes itself from this set, and calls `call.end()`.  Stored as
   * closures (not raw call objects) so `stopActiveStreams()` can also stop the
   * 100 ms poll loop, not just half-close the wire connection.
   */
  private readonly activeStreamStoppers = new Set<() => void>();

  constructor(
    topicService: TopicService,
    subscriptionService: SubscriptionService,
    snapshotService: SnapshotService,
    schemaService: SchemaService
  ) {
    this.topicService = topicService;
    this.subscriptionService = subscriptionService;
    this.snapshotService = snapshotService;
    this.schemaService = schemaService;
  }

  // ── Publisher: CreateTopic ──

  createTopic = async (
    call: grpc.ServerUnaryCall<CreateTopicRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const req = call.request;
      const parsed = parseResourceName(() => parseTopicName(req.name));

      // Extract only the fields the service layer understands and strip proto
      // default values (e.g. empty-string kmsKeyName, zero-Duration fields).
      const body: Record<string, unknown> = {};

      if (req.labels && Object.keys(req.labels).length > 0) {
        body.labels = req.labels;
      }

      // messageRetentionDuration arrives as a Duration object from proto-loader
      // when set, or as the zero Duration { seconds: '0', nanos: 0 } when omitted.
      // protoDurationToStr converts both forms and returns undefined for the zero case.
      const retentionDur = protoDurationToStr(
        req.messageRetentionDuration as ProtoDuration | string | undefined
      );

      if (retentionDur) {
        body.messageRetentionDuration = retentionDur;
      }

      if (typeof req.kmsKeyName === 'string' && req.kmsKeyName.length > 0) {
        body.kmsKeyName = req.kmsKeyName;
      }

      if (req.schemaSettings) {
        const ss = req.schemaSettings as Record<string, unknown>;
        const schemaRef = ss.schema;

        if (typeof schemaRef === 'string' && schemaRef.length > 0) {
          body.schemaSettings = req.schemaSettings;
        }
      }

      if (typeof req.satisfiesPzs === 'boolean') {
        body.satisfiesPzs = req.satisfiesPzs;
      }

      if (req.messageStoragePolicy) {
        body.messageStoragePolicy = req.messageStoragePolicy;
      }

      if (req.ingestionDataSourceSettings) {
        body.ingestionDataSourceSettings = normaliseIngestionDataSourceSettings(
          req.ingestionDataSourceSettings
        );
      }

      const result = await this.topicService.createTopic(parsed.project, parsed.topic, body);

      callback(null, topicResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Publisher: UpdateTopic ──

  updateTopic = async (
    call: grpc.ServerUnaryCall<UpdateTopicRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { topic, updateMask } = call.request;
      const paths = updateMask?.paths ?? [];
      const updateMaskStr = paths.length > 0 ? normaliseMaskPaths(paths) : undefined;

      // Normalize Duration fields: proto-loader delivers { seconds, nanos } objects;
      // the service layer expects "Xs" strings.
      const topicForService = { ...topic } as Record<string, unknown>;

      if (topicForService.messageRetentionDuration != null) {
        topicForService.messageRetentionDuration = protoDurationToStr(
          topicForService.messageRetentionDuration as ProtoDuration | string
        );
      }

      if (topicForService.ingestionDataSourceSettings != null) {
        topicForService.ingestionDataSourceSettings = normaliseIngestionDataSourceSettings(
          topicForService.ingestionDataSourceSettings as Record<string, unknown>
        );
      }

      const body = { topic: topicForService, updateMask: updateMaskStr };
      const result = await this.topicService.updateTopic(topic.name, body);

      callback(null, topicResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Publisher: GetTopic ──

  getTopic = async (
    call: grpc.ServerUnaryCall<GetTopicRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const result = await this.topicService.getTopic(call.request.topic);

      callback(null, topicResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Publisher: ListTopics ──

  listTopics = async (
    call: grpc.ServerUnaryCall<ListTopicsRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { project, pageSize, pageToken } = call.request;
      const projectId = project.replace(/^projects\//, '');
      const effectivePageSize = pageSize != null && pageSize > 0 ? pageSize : undefined;
      const result = await this.topicService.listTopics(projectId, effectivePageSize, pageToken);

      callback(null, {
        topics: result.topics.map(topicResponseToProto),
        nextPageToken: result.nextPageToken ?? '',
      });
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Publisher: DeleteTopic ──

  deleteTopic = async (
    call: grpc.ServerUnaryCall<DeleteTopicRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      await this.topicService.deleteTopic(call.request.topic);

      callback(null, {});
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Publisher: Publish ──

  publish = async (
    call: grpc.ServerUnaryCall<PublishRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { topic, messages } = call.request;

      const serviceMessages = messages.map(m => ({
        data: bytesToBase64(m.data),
        attributes: m.attributes,
        orderingKey: m.orderingKey,
      }));

      const result = await this.subscriptionService.publish(topic, { messages: serviceMessages });

      callback(null, { messageIds: result.messageIds });
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Publisher: ListTopicSubscriptions ──

  listTopicSubscriptions = async (
    call: grpc.ServerUnaryCall<ListTopicSubscriptionsRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { topic, pageSize, pageToken } = call.request;
      const result = await this.subscriptionService.listTopicSubscriptions(topic);
      const { page, nextPageToken } = paginateItems(result.subscriptions, pageSize, pageToken);

      callback(null, { subscriptions: page, nextPageToken });
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Publisher: ListTopicSnapshots ──

  listTopicSnapshots = async (
    call: grpc.ServerUnaryCall<ListTopicSnapshotsRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { topic, pageSize, pageToken } = call.request;
      const result = await this.snapshotService.listTopicSnapshots(topic);
      const { page, nextPageToken } = paginateItems(result.snapshots, pageSize, pageToken);

      callback(null, { snapshots: page, nextPageToken });
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Publisher: DetachSubscription ──

  detachSubscription = async (
    call: grpc.ServerUnaryCall<DetachSubscriptionRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      await this.subscriptionService.detachSubscription(call.request.subscription);

      callback(null, {});
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Subscriber: CreateSubscription ──

  createSubscription = async (
    call: grpc.ServerUnaryCall<CreateSubscriptionRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const req = call.request;
      const parsed = parseResourceName(() => parseSubscriptionName(req.name));

      // Extract only the fields the service layer understands and strip proto
      // default values (e.g. zero ackDeadlineSeconds means "use default").
      const body: Record<string, unknown> = {
        topic: req.topic,
      };

      // ackDeadlineSeconds: 0 means "use service default"; only forward if set
      if (req.ackDeadlineSeconds != null && req.ackDeadlineSeconds > 0) {
        body.ackDeadlineSeconds = req.ackDeadlineSeconds;
      }

      if (req.retainAckedMessages) {
        body.retainAckedMessages = req.retainAckedMessages;
      }

      // Duration fields arrive as { seconds, nanos } objects from proto-loader.
      const retentionDur = protoDurationToStr(
        req.messageRetentionDuration as ProtoDuration | string | undefined
      );

      if (retentionDur) {
        body.messageRetentionDuration = retentionDur;
      }

      if (req.labels && Object.keys(req.labels).length > 0) {
        body.labels = req.labels;
      }

      if (req.pushConfig) {
        const pc = req.pushConfig as Record<string, unknown>;

        if (typeof pc.pushEndpoint === 'string' && pc.pushEndpoint.length > 0) {
          body.pushConfig = req.pushConfig;
        }
      }

      if (req.bigqueryConfig) {
        body.bigqueryConfig = req.bigqueryConfig;
      }

      if (req.cloudStorageConfig) {
        body.cloudStorageConfig = normaliseCloudStorageConfig(req.cloudStorageConfig);
      }

      if (req.enableMessageOrdering) {
        body.enableMessageOrdering = req.enableMessageOrdering;
      }

      if (req.expirationPolicy) {
        const ep = req.expirationPolicy as Record<string, unknown>;
        const ttlStr = protoDurationToStr(ep.ttl as ProtoDuration | string | undefined);

        if (ttlStr) {
          body.expirationPolicy = { ttl: ttlStr };
        }
      }

      if (typeof req.filter === 'string' && req.filter.length > 0) {
        body.filter = req.filter;
      }

      if (req.deadLetterPolicy) {
        const dlp = req.deadLetterPolicy as Record<string, unknown>;

        if (typeof dlp.deadLetterTopic === 'string' && dlp.deadLetterTopic.length > 0) {
          body.deadLetterPolicy = req.deadLetterPolicy;
        }
      }

      if (req.retryPolicy) {
        const rp = req.retryPolicy as Record<string, unknown>;
        const minBackoff = protoDurationToStr(
          rp.minimumBackoff as ProtoDuration | string | undefined
        );
        const maxBackoff = protoDurationToStr(
          rp.maximumBackoff as ProtoDuration | string | undefined
        );

        if (minBackoff ?? maxBackoff) {
          body.retryPolicy = {
            ...(minBackoff ? { minimumBackoff: minBackoff } : {}),
            ...(maxBackoff ? { maximumBackoff: maxBackoff } : {}),
          };
        }
      }

      if (req.enableExactlyOnceDelivery) {
        body.enableExactlyOnceDelivery = req.enableExactlyOnceDelivery;
      }

      const result = await this.subscriptionService.createSubscription(
        parsed.project,
        parsed.subscription,
        body
      );

      callback(null, subscriptionResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Subscriber: GetSubscription ──

  getSubscription = async (
    call: grpc.ServerUnaryCall<GetSubscriptionRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const result = await this.subscriptionService.getSubscription(call.request.subscription);

      callback(null, subscriptionResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Subscriber: UpdateSubscription ──

  updateSubscription = async (
    call: grpc.ServerUnaryCall<UpdateSubscriptionRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { subscription, updateMask } = call.request;
      const paths = updateMask?.paths ?? [];
      const updateMaskStr = paths.length > 0 ? normaliseMaskPaths(paths) : undefined;

      // Normalize Duration fields before passing to service layer.
      const subForService = { ...subscription } as Record<string, unknown>;

      if (subForService.messageRetentionDuration != null) {
        subForService.messageRetentionDuration = protoDurationToStr(
          subForService.messageRetentionDuration as ProtoDuration | string
        );
      }

      if (subForService.expirationPolicy != null) {
        const ep = subForService.expirationPolicy as Record<string, unknown>;
        const ttlStr = protoDurationToStr(ep.ttl as ProtoDuration | string | undefined);

        subForService.expirationPolicy = ttlStr ? { ttl: ttlStr } : null;
      }

      if (subForService.retryPolicy != null) {
        const rp = subForService.retryPolicy as Record<string, unknown>;
        const minBackoff = protoDurationToStr(
          rp.minimumBackoff as ProtoDuration | string | undefined
        );
        const maxBackoff = protoDurationToStr(
          rp.maximumBackoff as ProtoDuration | string | undefined
        );

        subForService.retryPolicy = {
          ...(minBackoff ? { minimumBackoff: minBackoff } : {}),
          ...(maxBackoff ? { maximumBackoff: maxBackoff } : {}),
        };
      }

      if (subForService.cloudStorageConfig != null) {
        subForService.cloudStorageConfig = normaliseCloudStorageConfig(
          subForService.cloudStorageConfig as Record<string, unknown>
        );
      }

      const body = { subscription: subForService, updateMask: updateMaskStr };
      const result = await this.subscriptionService.updateSubscription(subscription.name, body);

      callback(null, subscriptionResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Subscriber: ListSubscriptions ──

  listSubscriptions = async (
    call: grpc.ServerUnaryCall<ListSubscriptionsRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { project, pageSize, pageToken } = call.request;
      const projectId = project.replace(/^projects\//, '');
      const effectivePageSize = pageSize != null && pageSize > 0 ? pageSize : undefined;
      const result = await this.subscriptionService.listSubscriptions(
        projectId,
        effectivePageSize,
        pageToken
      );

      callback(null, {
        subscriptions: result.subscriptions.map(subscriptionResponseToProto),
        nextPageToken: result.nextPageToken ?? '',
      });
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Subscriber: DeleteSubscription ──

  deleteSubscription = async (
    call: grpc.ServerUnaryCall<DeleteSubscriptionRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      await this.subscriptionService.deleteSubscription(call.request.subscription);

      callback(null, {});
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Subscriber: ModifyAckDeadline ──

  modifyAckDeadline = async (
    call: grpc.ServerUnaryCall<ModifyAckDeadlineRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { subscription, ackIds, ackDeadlineSeconds } = call.request;

      await this.subscriptionService.modifyAckDeadline(subscription, {
        ackIds,
        ackDeadlineSeconds,
      });

      callback(null, {});
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Subscriber: Acknowledge ──

  acknowledge = async (
    call: grpc.ServerUnaryCall<AcknowledgeRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { subscription, ackIds } = call.request;

      await this.subscriptionService.acknowledge(subscription, { ackIds });

      callback(null, {});
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Subscriber: Pull ──

  pull = async (
    call: grpc.ServerUnaryCall<PullRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { subscription, maxMessages } = call.request;
      // proto-loader fills unset int32 with 0; treat 0 the same as unset.
      const effectiveMaxMessages = maxMessages != null && maxMessages > 0 ? maxMessages : undefined;
      const result = await this.subscriptionService.pull(subscription, {
        maxMessages: effectiveMaxMessages,
      });

      callback(null, {
        receivedMessages: result.receivedMessages.map(receivedMessageToProto),
      });
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Subscriber: StreamingPull ──

  /**
   * Stop every active StreamingPull — used during service shutdown so that
   * GrpcServer.tryShutdown() is not blocked by open streaming RPCs.
   *
   * Each stopper cancels the poll loop (sets `cancelled`, clears the timer)
   * and calls `call.end()` so the gRPC server sees the stream as finished.
   */
  stopActiveStreams(): void {
    for (const stop of this.activeStreamStoppers) {
      stop();
    }

    this.activeStreamStoppers.clear();
  }

  streamingPull = (call: grpc.ServerDuplexStream<StreamingPullRequest, unknown>): void => {
    let subscriptionName = '';
    let streamAckDeadlineSeconds = 10;
    let cancelled = false;
    let paused = false;
    let pollTimeoutId: ReturnType<typeof setTimeout> | undefined;

    const stopPolling = () => {
      cancelled = true;

      if (pollTimeoutId !== undefined) {
        clearTimeout(pollTimeoutId);
        pollTimeoutId = undefined;
      }
    };

    // stopStream is stored in activeStreamStoppers so that stopActiveStreams()
    // can cancel the poll loop and half-close the wire in one call.
    const stopStream = () => {
      stopPolling();
      this.activeStreamStoppers.delete(stopStream);
      call.end();
    };

    this.activeStreamStoppers.add(stopStream);

    const scheduleNextPoll = () => {
      if (cancelled || paused) {
        return;
      }

      pollTimeoutId = setTimeout(() => {
        void pollMessages();
      }, 100);
    };

    const pollMessages = async () => {
      if (cancelled || !subscriptionName || paused) {
        return;
      }

      try {
        const result = await this.subscriptionService.pull(
          subscriptionName,
          { maxMessages: 100 },
          streamAckDeadlineSeconds
        );

        if (result.receivedMessages.length > 0 && !cancelled) {
          const canWrite = call.write({
            receivedMessages: result.receivedMessages.map(receivedMessageToProto),
          });

          if (!canWrite) {
            paused = true;

            return;
          }
        }
      } catch (err) {
        if (!cancelled) {
          stopPolling();
          this.activeStreamStoppers.delete(stopStream);
          call.emit('error', toGrpcError(err));

          return;
        }
      }

      scheduleNextPoll();
    };

    call.on('data', (request: StreamingPullRequest) => {
      if (!subscriptionName) {
        if (!request.subscription) {
          stopPolling();
          call.emit(
            'error',
            toGrpcError(new PubSubError('INVALID_ARGUMENT', 'subscription must be provided'))
          );

          return;
        }

        const deadline = request.streamAckDeadlineSeconds ?? 0;

        if (deadline < 10 || deadline > 600) {
          stopPolling();
          call.emit(
            'error',
            toGrpcError(
              new PubSubError(
                'INVALID_ARGUMENT',
                `streamAckDeadlineSeconds must be between 10 and 600 seconds, got ${deadline}`
              )
            )
          );

          return;
        }

        subscriptionName = request.subscription;
        streamAckDeadlineSeconds = deadline;
        scheduleNextPoll();
      } else if (request.subscription && request.subscription.length > 0) {
        stopPolling();
        this.activeStreamStoppers.delete(stopStream);
        call.emit(
          'error',
          toGrpcError(
            new PubSubError(
              'INVALID_ARGUMENT',
              'subscription field must only be set on the first StreamingPull request'
            )
          )
        );

        return;
      }

      if (request.ackIds && request.ackIds.length > 0) {
        void this.subscriptionService
          .acknowledge(subscriptionName, { ackIds: request.ackIds })
          .catch(() => {
            // Ack errors in streaming pull are non-fatal
          });
      }

      const modIds = request.modifyDeadlineAckIds ?? [];
      const modSeconds = request.modifyDeadlineSeconds ?? [];

      for (let i = 0; i < modIds.length; i++) {
        const ackId = modIds[i];
        const deadline = modSeconds[i] ?? streamAckDeadlineSeconds;

        if (ackId != null) {
          void this.subscriptionService
            .modifyAckDeadline(subscriptionName, {
              ackIds: [ackId],
              ackDeadlineSeconds: deadline,
            })
            .catch(() => {
              // Deadline modification errors are non-fatal
            });
        }
      }
    });

    call.on('drain', () => {
      paused = false;
      scheduleNextPoll();
    });

    call.on('cancelled', () => {
      stopPolling();
      this.activeStreamStoppers.delete(stopStream);
    });

    call.on('end', () => {
      stopPolling();
      this.activeStreamStoppers.delete(stopStream);
      call.end();
    });

    call.on('error', () => {
      stopPolling();
      this.activeStreamStoppers.delete(stopStream);
    });
  };

  // ── Subscriber: ModifyPushConfig ──

  modifyPushConfig = async (
    call: grpc.ServerUnaryCall<ModifyPushConfigRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { subscription, pushConfig } = call.request;

      await this.subscriptionService.modifyPushConfig(subscription, { pushConfig });

      callback(null, {});
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Subscriber: GetSnapshot ──

  getSnapshot = async (
    call: grpc.ServerUnaryCall<GetSnapshotRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const result = await this.snapshotService.getSnapshot(call.request.snapshot);

      callback(null, snapshotResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Subscriber: ListSnapshots ──

  listSnapshots = async (
    call: grpc.ServerUnaryCall<ListSnapshotsRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { project, pageSize, pageToken } = call.request;
      const projectId = project.replace(/^projects\//, '');
      const effectivePageSize = pageSize != null && pageSize > 0 ? pageSize : undefined;
      const result = await this.snapshotService.listSnapshots(
        projectId,
        effectivePageSize,
        pageToken
      );

      callback(null, {
        snapshots: result.snapshots.map(snapshotResponseToProto),
        nextPageToken: result.nextPageToken ?? '',
      });
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Subscriber: CreateSnapshot ──

  createSnapshot = async (
    call: grpc.ServerUnaryCall<CreateSnapshotRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { name, subscription, labels } = call.request;
      const parsed = parseResourceName(() => parseSnapshotName(name));
      const result = await this.snapshotService.createSnapshot(parsed.project, parsed.snapshot, {
        subscription,
        labels,
      });

      callback(null, snapshotResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Subscriber: UpdateSnapshot ──

  updateSnapshot = async (
    call: grpc.ServerUnaryCall<UpdateSnapshotRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { snapshot, updateMask } = call.request;
      const paths = updateMask?.paths ?? [];
      const updateMaskStr = paths.length > 0 ? normaliseMaskPaths(paths) : undefined;

      const snapshotData: Record<string, unknown> = {};

      if (snapshot.expireTime) {
        snapshotData.expireTime = timestampToIso(snapshot.expireTime);
      }

      if (snapshot.labels) {
        snapshotData.labels = snapshot.labels;
      }

      const body = { snapshot: snapshotData, updateMask: updateMaskStr };
      const result = await this.snapshotService.updateSnapshot(snapshot.name, body);

      callback(null, snapshotResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Subscriber: DeleteSnapshot ──

  deleteSnapshot = async (
    call: grpc.ServerUnaryCall<DeleteSnapshotRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      await this.snapshotService.deleteSnapshot(call.request.snapshot);

      callback(null, {});
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Subscriber: Seek ──

  seek = async (
    call: grpc.ServerUnaryCall<SeekRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { subscription, seekTo, time, snapshot } = call.request;
      const seekBody: Record<string, unknown> = {};

      if (seekTo === 'time' && time) {
        seekBody.time = timestampToIso(time);
      } else if (seekTo === 'snapshot' && snapshot) {
        seekBody.snapshot = snapshot;
      } else if (time) {
        seekBody.time = timestampToIso(time);
      } else if (snapshot) {
        seekBody.snapshot = snapshot;
      }

      await this.subscriptionService.seek(subscription, seekBody);

      callback(null, {});
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── SchemaService: CreateSchema ──

  createSchema = async (
    call: grpc.ServerUnaryCall<CreateSchemaRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { parent, schemaId, schema } = call.request;
      const projectId = parent.replace(/^projects\//, '');
      const id = schemaId ?? '';
      const result = await this.schemaService.createSchema(projectId, id, schema ?? {});

      callback(null, schemaResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── SchemaService: GetSchema ──

  getSchema = async (
    call: grpc.ServerUnaryCall<GetSchemaRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { name, view } = call.request;
      const normView = normaliseSchemaView(view);
      const result = await this.schemaService.getSchema(name, normView);

      callback(null, schemaResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── SchemaService: ListSchemas ──

  listSchemas = async (
    call: grpc.ServerUnaryCall<ListSchemasRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { parent, view, pageSize, pageToken } = call.request;
      const projectId = parent.replace(/^projects\//, '');
      const normView = normaliseSchemaView(view);
      const effectivePageSize = pageSize != null && pageSize > 0 ? pageSize : undefined;
      const result = await this.schemaService.listSchemas(
        projectId,
        effectivePageSize,
        pageToken,
        normView
      );

      callback(null, {
        schemas: result.schemas.map(schemaResponseToProto),
        nextPageToken: result.nextPageToken ?? '',
      });
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── SchemaService: ListSchemaRevisions ──

  listSchemaRevisions = async (
    call: grpc.ServerUnaryCall<ListSchemaRevisionsRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { name, view, pageSize, pageToken } = call.request;
      const normView = normaliseSchemaView(view);
      const effectivePageSize = pageSize != null && pageSize > 0 ? pageSize : undefined;
      const result = await this.schemaService.listRevisions(
        name,
        effectivePageSize,
        pageToken,
        normView
      );

      callback(null, {
        schemas: result.schemas.map(schemaResponseToProto),
        nextPageToken: '',
      });
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── SchemaService: CommitSchema ──

  commitSchema = async (
    call: grpc.ServerUnaryCall<CommitSchemaRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { name, schema } = call.request;
      const result = await this.schemaService.commitSchema(name, { schema });

      callback(null, schemaResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── SchemaService: RollbackSchema ──

  rollbackSchema = async (
    call: grpc.ServerUnaryCall<RollbackSchemaRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { name, revisionId } = call.request;
      const result = await this.schemaService.rollbackSchema(name, { revisionId });

      callback(null, schemaResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── SchemaService: DeleteSchemaRevision ──

  deleteSchemaRevision = async (
    call: grpc.ServerUnaryCall<DeleteSchemaRevisionRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { name, revisionId } = call.request;
      const result = await this.schemaService.deleteRevision(name, revisionId ?? '');

      callback(null, schemaResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── SchemaService: DeleteSchema ──

  deleteSchema = async (
    call: grpc.ServerUnaryCall<DeleteSchemaRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      await this.schemaService.deleteSchema(call.request.name);

      callback(null, {});
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── SchemaService: ValidateSchema ──

  validateSchema = async (
    call: grpc.ServerUnaryCall<ValidateSchemaRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { parent, schema } = call.request;
      const projectId = parent.replace(/^projects\//, '');
      const result = await this.schemaService.validateSchema(projectId, { schema });

      callback(null, result);
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── SchemaService: ValidateMessage ──

  validateMessage = async (
    call: grpc.ServerUnaryCall<ValidateMessageRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { parent, name, encoding, message } = call.request;
      const projectId = parent.replace(/^projects\//, '');
      const result = await this.schemaService.validateMessage(projectId, {
        name,
        encoding,
        message: bytesToBase64(message),
      });

      callback(null, result);
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Build the gRPC service implementation objects ──

  toServiceImplementation(): grpc.UntypedServiceImplementation {
    return {
      // Publisher
      CreateTopic: this.createTopic,
      UpdateTopic: this.updateTopic,
      Publish: this.publish,
      GetTopic: this.getTopic,
      ListTopics: this.listTopics,
      ListTopicSubscriptions: this.listTopicSubscriptions,
      ListTopicSnapshots: this.listTopicSnapshots,
      DeleteTopic: this.deleteTopic,
      DetachSubscription: this.detachSubscription,
      // Subscriber
      CreateSubscription: this.createSubscription,
      GetSubscription: this.getSubscription,
      UpdateSubscription: this.updateSubscription,
      ListSubscriptions: this.listSubscriptions,
      DeleteSubscription: this.deleteSubscription,
      ModifyAckDeadline: this.modifyAckDeadline,
      Acknowledge: this.acknowledge,
      Pull: this.pull,
      StreamingPull: this.streamingPull,
      ModifyPushConfig: this.modifyPushConfig,
      GetSnapshot: this.getSnapshot,
      ListSnapshots: this.listSnapshots,
      CreateSnapshot: this.createSnapshot,
      UpdateSnapshot: this.updateSnapshot,
      DeleteSnapshot: this.deleteSnapshot,
      Seek: this.seek,
      // SchemaService
      CreateSchema: this.createSchema,
      GetSchema: this.getSchema,
      ListSchemas: this.listSchemas,
      ListSchemaRevisions: this.listSchemaRevisions,
      CommitSchema: this.commitSchema,
      RollbackSchema: this.rollbackSchema,
      DeleteSchemaRevision: this.deleteSchemaRevision,
      DeleteSchema: this.deleteSchema,
      ValidateSchema: this.validateSchema,
      ValidateMessage: this.validateMessage,
    };
  }
}

// ── Schema view normalisation ──

function normaliseSchemaView(view: string | undefined): string | undefined {
  if (!view || view === 'SCHEMA_VIEW_UNSPECIFIED' || view === '0') {
    return undefined;
  }

  if (view === 'BASIC' || view === '1') {
    return 'BASIC';
  }

  if (view === 'FULL' || view === '2') {
    return 'FULL';
  }

  return undefined;
}
