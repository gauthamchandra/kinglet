/**
 * Protocol Buffer Type Definitions and Common Message Types
 * This module provides TypeScript types that correspond to common GCP protocol buffer definitions
 */

// Common Google API types
export interface Status {
  code: number;
  message: string;
  details: Array<{ '@type': string; [key: string]: unknown }>;
}

/**
 * Use Record<never, never> for truly empty messages instead of empty interface.
 * This type provides better type safety than {} by preventing unexpected property additions.
 */
export type Empty = Record<never, never>;

export interface FieldMask {
  paths: string[];
}

export interface Timestamp {
  seconds: string;
  nanos: number;
}

export interface Duration {
  seconds: string;
  nanos: number;
}

export interface Any {
  '@type': string;
  [key: string]: unknown;
}

// Common request patterns
export interface ListRequest {
  parent?: string;
  pageSize?: number;
  pageToken?: string;
  filter?: string;
  orderBy?: string;
}

export interface ListResponse<T> {
  items: T[];
  nextPageToken?: string;
  totalSize?: number;
}

export interface GetRequest {
  name: string;
}

export interface CreateRequest<T> {
  parent?: string;
  resource: T;
  resourceId?: string;
}

export interface UpdateRequest<T> {
  resource: T;
  updateMask?: FieldMask;
}

export interface DeleteRequest {
  name: string;
  force?: boolean;
}

// Pub/Sub message types
export interface Topic {
  name: string;
  labels?: Record<string, string>;
  messageStoragePolicy?: MessageStoragePolicy;
  kmsKeyName?: string;
  schemaSettings?: SchemaSettings;
  satisfiesPzs?: boolean;
  messageRetentionDuration?: string;
}

export interface MessageStoragePolicy {
  allowedPersistenceRegions?: string[];
}

export interface SchemaSettings {
  schema?: string;
  encoding?: 'JSON' | 'BINARY';
  firstRevisionId?: string;
  lastRevisionId?: string;
}

export interface Subscription {
  name: string;
  topic: string;
  pushConfig?: PushConfig;
  bigqueryConfig?: BigQueryConfig;
  cloudStorageConfig?: CloudStorageConfig;
  ackDeadlineSeconds?: number;
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
  state?: 'ACTIVE' | 'RESOURCE_ERROR';
}

export interface PushConfig {
  pushEndpoint?: string;
  attributes?: Record<string, string>;
  oidcToken?: OidcToken;
  pubsubWrapper?: PubsubWrapper;
  noWrapper?: NoWrapper;
}

export interface OidcToken {
  serviceAccountEmail: string;
  audience?: string;
}

/**
 * Use Record<never, never> for empty config indicating Pub/Sub wrapper should be used.
 *
 * This type is preferred over empty interface {} or object type because:
 * - Record<never, never> is truly empty and cannot have properties added to it
 * - Empty interfaces can be extended unexpectedly, reducing type safety
 * - This pattern explicitly communicates that this is an intentionally empty type
 * - It matches the protobuf "empty message" pattern where no fields are defined
 */
export type PubsubWrapper = Record<never, never>;

export interface NoWrapper {
  writeMetadata: boolean;
}

export interface BigQueryConfig {
  table?: string;
  useTopicSchema?: boolean;
  writeMetadata?: boolean;
  dropUnknownFields?: boolean;
  state?: 'ACTIVE' | 'PERMISSION_DENIED' | 'NOT_FOUND' | 'SCHEMA_MISMATCH';
}

export interface CloudStorageConfig {
  bucket?: string;
  filenamePrefix?: string;
  filenameSuffix?: string;
  textConfig?: TextConfig;
  avroConfig?: AvroConfig;
  maxDuration?: string;
  maxBytes?: string;
  state?: 'ACTIVE' | 'PERMISSION_DENIED' | 'NOT_FOUND';
}

/**
 * Use Record<never, never> for empty config indicating text format.
 * This empty type signifies that text format configuration requires no additional parameters.
 */
export type TextConfig = Record<never, never>;

export interface AvroConfig {
  writeMetadata?: boolean;
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

export interface PubsubMessage {
  data?: string; // Base64 encoded
  attributes?: Record<string, string>;
  messageId?: string;
  publishTime?: Timestamp;
  orderingKey?: string;
}

export interface PublishRequest {
  topic: string;
  messages: PubsubMessage[];
}

export interface PublishResponse {
  messageIds: string[];
}

export interface PullRequest {
  subscription: string;
  returnImmediately?: boolean;
  maxMessages: number;
  allowExcessMessages?: boolean;
}

export interface PullResponse {
  receivedMessages: ReceivedMessage[];
}

export interface ReceivedMessage {
  ackId?: string;
  message?: PubsubMessage;
  deliveryAttempt?: number;
}

export interface AcknowledgeRequest {
  subscription: string;
  ackIds: string[];
}

export interface ModifyAckDeadlineRequest {
  subscription: string;
  ackIds: string[];
  ackDeadlineSeconds: number;
}

// Cloud Scheduler message types
export interface Job {
  name: string;
  description?: string;
  schedule?: string;
  timeZone?: string;
  userUpdateTime?: Timestamp;
  state?: 'ENABLED' | 'PAUSED' | 'DISABLED' | 'UPDATE_FAILED';
  status?: Status;
  scheduleTime?: Timestamp;
  lastAttemptTime?: Timestamp;
  retryConfig?: RetryConfig;
  attemptDeadline?: string;

  // Target (oneof)
  pubsubTarget?: PubsubTarget;
  httpTarget?: HttpTarget;
  appEngineHttpTarget?: AppEngineHttpTarget;
}

export interface RetryConfig {
  retryCount?: number;
  maxRetryDuration?: string;
  minBackoffDuration?: string;
  maxBackoffDuration?: string;
  maxDoublings?: number;
}

export interface PubsubTarget {
  topicName: string;
  data?: string; // Base64 encoded
  attributes?: Record<string, string>;
}

export interface HttpTarget {
  uri: string;
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: string; // Base64 encoded
  oauthToken?: OAuthToken;
  oidcToken?: OidcToken;
}

export interface OAuthToken {
  serviceAccountEmail: string;
  scope?: string;
}

export interface AppEngineHttpTarget {
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  appEngineRouting?: AppEngineRouting;
  relativeUri?: string;
  headers?: Record<string, string>;
  body?: string; // Base64 encoded
}

export interface AppEngineRouting {
  service?: string;
  version?: string;
  instance?: string;
}

export interface RunJobRequest {
  name: string;
}

export interface PauseJobRequest {
  name: string;
}

export interface ResumeJobRequest {
  name: string;
}

// Cloud Tasks message types
export interface Queue {
  name: string;
  rateLimits?: RateLimits;
  retryConfig?: QueueRetryConfig;
  state?: 'RUNNING' | 'PAUSED' | 'DISABLED';
  purgeTime?: Timestamp;
  stackdriverLoggingConfig?: StackdriverLoggingConfig;
  type?: 'PUSH' | 'PULL';
  stats?: QueueStats;
}

export interface RateLimits {
  maxDispatchesPerSecond?: number;
  maxBurstSize?: number;
  maxConcurrentDispatches?: number;
}

export interface QueueRetryConfig {
  maxAttempts?: number;
  maxRetryDuration?: string;
  minBackoff?: string;
  maxBackoff?: string;
  maxDoublings?: number;
}

export interface StackdriverLoggingConfig {
  samplingRatio?: number;
}

export interface QueueStats {
  tasksCount?: string;
  oldestEstimatedArrivalTime?: Timestamp;
  executedLastMinuteCount?: string;
  concurrentDispatchesCount?: string;
  effectiveExecutionRate?: number;
}

export interface Task {
  name: string;
  scheduleTime?: Timestamp;
  createTime?: Timestamp;
  dispatchDeadline?: string;
  dispatchCount?: number;
  responseCount?: number;
  firstAttempt?: Attempt;
  lastAttempt?: Attempt;
  view?: 'VIEW_UNSPECIFIED' | 'BASIC' | 'FULL';

  // Payload (oneof)
  appEngineHttpRequest?: AppEngineHttpRequest;
  httpRequest?: HttpRequest;
  pullMessage?: PullMessage;
}

export interface Attempt {
  scheduleTime?: Timestamp;
  dispatchTime?: Timestamp;
  responseTime?: Timestamp;
  responseStatus?: Status;
}

export interface AppEngineHttpRequest {
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  appEngineRouting?: AppEngineRouting;
  relativeUri?: string;
  headers?: Record<string, string>;
  body?: string; // Base64 encoded
}

export interface HttpRequest {
  url: string;
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: string; // Base64 encoded
  oauthToken?: OAuthToken;
  oidcToken?: OidcToken;
}

export interface PullMessage {
  payload?: string; // Base64 encoded
  tag?: string;
}

export interface RunTaskRequest {
  name: string;
  responseView?: 'VIEW_UNSPECIFIED' | 'BASIC' | 'FULL';
}

export interface PurgeQueueRequest {
  name: string;
}

export interface PauseQueueRequest {
  name: string;
}

export interface ResumeQueueRequest {
  name: string;
}

// Secret Manager message types
export interface Secret {
  name: string;
  replication: Replication;
  createTime?: Timestamp;
  labels?: Record<string, string>;
  topics?: Topic[];
  expireTime?: Timestamp;
  ttl?: string;
  etag?: string;
  rotation?: Rotation;
  versionAliases?: Record<string, string>;
  annotations?: Record<string, string>;
  versionDestroyTtl?: string;
  customerManagedEncryption?: CustomerManagedEncryption;
}

export interface Replication {
  automatic?: Automatic;
  userManaged?: UserManaged;
}

export interface Automatic {
  customerManagedEncryption?: CustomerManagedEncryption;
}

export interface UserManaged {
  replicas: Replica[];
}

export interface Replica {
  location: string;
  customerManagedEncryption?: CustomerManagedEncryption;
}

export interface CustomerManagedEncryption {
  kmsKeyName: string;
}

export interface Rotation {
  nextRotationTime?: Timestamp;
  rotationPeriod?: string;
}

export interface SecretVersion {
  name: string;
  createTime?: Timestamp;
  destroyTime?: Timestamp;
  state?: 'STATE_UNSPECIFIED' | 'ENABLED' | 'DISABLED' | 'DESTROYED';
  replicationStatus?: ReplicationStatus;
  etag?: string;
  clientSpecifiedPayloadChecksum?: boolean;
  scheduledDestroyTime?: Timestamp;
  customerManagedEncryption?: CustomerManagedEncryptionStatus;
}

export interface ReplicationStatus {
  automatic?: AutomaticStatus;
  userManaged?: UserManagedStatus;
}

export interface AutomaticStatus {
  customerManagedEncryption?: CustomerManagedEncryptionStatus;
}

export interface UserManagedStatus {
  replicas?: Record<string, ReplicaStatus>;
}

export interface ReplicaStatus {
  location?: string;
  customerManagedEncryption?: CustomerManagedEncryptionStatus;
}

export interface CustomerManagedEncryptionStatus {
  kmsKeyVersionName?: string;
}

export interface SecretPayload {
  data?: string; // Base64 encoded
  dataCrc32c?: string;
}

export interface AddSecretVersionRequest {
  parent: string;
  payload?: SecretPayload;
}

export interface AccessSecretVersionRequest {
  name: string;
}

export interface AccessSecretVersionResponse {
  name?: string;
  payload?: SecretPayload;
}

export interface DestroySecretVersionRequest {
  name: string;
  etag?: string;
}

export interface DisableSecretVersionRequest {
  name: string;
  etag?: string;
}

export interface EnableSecretVersionRequest {
  name: string;
  etag?: string;
}

// Helper type for creating strongly typed service implementations
export type ServiceImplementation<T> = {
  [K in keyof T]: T[K] extends (...args: unknown[]) => unknown
    ? (...args: Parameters<T[K]>) => ReturnType<T[K]>
    : never;
};

// gRPC status codes enum for reference
export enum GrpcStatus {
  OK = 0,
  CANCELLED = 1,
  UNKNOWN = 2,
  INVALID_ARGUMENT = 3,
  DEADLINE_EXCEEDED = 4,
  NOT_FOUND = 5,
  ALREADY_EXISTS = 6,
  PERMISSION_DENIED = 7,
  RESOURCE_EXHAUSTED = 8,
  FAILED_PRECONDITION = 9,
  ABORTED = 10,
  OUT_OF_RANGE = 11,
  UNIMPLEMENTED = 12,
  INTERNAL = 13,
  UNAVAILABLE = 14,
  DATA_LOSS = 15,
  UNAUTHENTICATED = 16,
}

// Common patterns for converting between formats

/**
 * Convert JavaScript Date to Protobuf Timestamp
 */
export function dateToTimestamp(date: Date): Timestamp {
  const seconds = Math.floor(date.getTime() / 1000);
  const nanos = (date.getTime() % 1000) * 1000000;

  return {
    seconds: seconds.toString(),
    nanos,
  };
}

/**
 * Convert Protobuf Timestamp to JavaScript Date
 */
export function timestampToDate(timestamp: Timestamp): Date {
  const seconds = parseInt(timestamp.seconds, 10);
  const milliseconds = Math.floor(timestamp.nanos / 1000000);

  return new Date(seconds * 1000 + milliseconds);
}

/**
 * Create a Duration from milliseconds
 */
export function millisecondsAsDuration(ms: number): Duration {
  const seconds = Math.floor(ms / 1000);
  const nanos = (ms % 1000) * 1000000;

  return {
    seconds: seconds.toString(),
    nanos,
  };
}

/**
 * Convert Duration to milliseconds
 */
export function durationToMilliseconds(duration: Duration): number {
  const seconds = parseInt(duration.seconds, 10);
  const milliseconds = Math.floor(duration.nanos / 1000000);

  return seconds * 1000 + milliseconds;
}

/**
 * Encode string as base64 for protobuf bytes fields
 */
export function encodeBase64(data: string): string {
  return Buffer.from(data, 'utf-8').toString('base64');
}

/**
 * Decode base64 string from protobuf bytes fields
 */
export function decodeBase64(data: string): string {
  return Buffer.from(data, 'base64').toString('utf-8');
}

/**
 * Create a gRPC Status object
 */
export function createStatus(
  code: number,
  message: string,
  details?: Array<{ '@type': string; [key: string]: unknown }>
): Status {
  return {
    code,
    message,
    details: details || [],
  };
}

/**
 * Create an empty FieldMask
 */
export function createFieldMask(paths: string[] = []): FieldMask {
  return { paths };
}
