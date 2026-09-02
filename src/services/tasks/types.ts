/**
 * Cloud Tasks data models, schemas, and helper functions
 */

import { z } from 'zod';
import type { BaseRecord, TableSchema } from '@/core/storage/types.ts';

// ── Constants ──

export const TASKS_QUEUES_TABLE = 'tasks_queues';
export const TASKS_TABLE = 'tasks_items';

export const QueueState = {
  STATE_UNSPECIFIED: 'STATE_UNSPECIFIED',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  DISABLED: 'DISABLED',
} as const;

export const TaskStatus = {
  PENDING: 'PENDING',
  DISPATCHING: 'DISPATCHING',
  FAILED: 'FAILED',
  TOMBSTONE: 'TOMBSTONE',
} as const;

// ── Default Configurations ──

export interface RateLimits {
  maxDispatchesPerSecond: number;
  maxBurstSize: number;
  maxConcurrentDispatches: number;
}

export interface TaskRetryConfig {
  maxAttempts: number;
  maxRetryDuration: string;
  minBackoff: string;
  maxBackoff: string;
  maxDoublings: number;
}

export interface StackdriverLoggingConfig {
  samplingRatio: number;
}

export interface AppEngineHttpRequest {
  httpMethod?: string;
  relativeUri?: string;
  headers?: Record<string, string>;
  body?: string;
  appEngineRouting?: {
    service?: string;
    version?: string;
    instance?: string;
  };
}

export interface AppEngineRoutingOverride {
  service?: string;
  version?: string;
  instance?: string;
}

export interface QueueHttpTarget {
  uriOverride?: {
    host?: string;
    port?: number;
    pathOverride?: { path?: string };
    queryOverride?: { queryParams?: string };
    scheme?: string;
    uriOverrideEnforceMode?: string;
  };
  httpMethod?: string;
  headerOverrides?: Array<{ header: { key: string; value: string } }>;
  oauthToken?: { serviceAccountEmail?: string; scope?: string };
  oidcToken?: { serviceAccountEmail?: string; audience?: string };
}

export interface TaskHttpRequest {
  url: string;
  httpMethod: string;
  headers?: Record<string, string>;
  body?: string;
  oauthToken?: { serviceAccountEmail?: string; scope?: string };
  oidcToken?: { serviceAccountEmail?: string; audience?: string };
}

export interface Attempt {
  scheduleTime?: string;
  dispatchTime?: string;
  responseTime?: string;
  responseStatus?: { code: number; message: string };
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  maxDispatchesPerSecond: 500,
  maxBurstSize: 100,
  maxConcurrentDispatches: 1000,
};

export const DEFAULT_RETRY_CONFIG: TaskRetryConfig = {
  maxAttempts: 100,
  maxRetryDuration: '0s',
  minBackoff: '0.100s',
  maxBackoff: '3600s',
  maxDoublings: 16,
};

export const DEFAULT_TASK_TTL = '2678400s'; // 31 days
export const DEFAULT_TOMBSTONE_TTL = '3600s'; // 1 hour
export const DEFAULT_DISPATCH_DEADLINE = '600s'; // 10 minutes

// ── Response Interfaces ──

export interface QueueResponse {
  name: string;
  state: string;
  rateLimits: RateLimits;
  retryConfig: TaskRetryConfig;
  taskTtl: string;
  tombstoneTtl: string;
  purgeTime?: string;
  stackdriverLoggingConfig?: StackdriverLoggingConfig;
  httpTarget?: QueueHttpTarget;
  appEngineRoutingOverride?: AppEngineRoutingOverride;
}

export interface TaskResponse {
  name: string;
  httpRequest?: TaskHttpRequest;
  appEngineHttpRequest?: AppEngineHttpRequest;
  scheduleTime: string;
  createTime: string;
  dispatchDeadline: string;
  dispatchCount: number;
  responseCount: number;
  firstAttempt?: Attempt;
  lastAttempt?: Attempt;
  view: string;
}

// ── Storage Records ──

export interface QueueRecord extends BaseRecord {
  name: string;
  state: string;
  rateLimits: string; // JSON-serialized RateLimits
  retryConfig: string; // JSON-serialized TaskRetryConfig
  purgeTime: string | null;
  taskTtl: string;
  tombstoneTtl: string;
  stackdriverLoggingConfig: string | null; // JSON-serialized
  httpTarget: string | null; // JSON-serialized
  appEngineRoutingOverride: string | null; // JSON-serialized
}

export interface TaskRecord extends BaseRecord {
  name: string;
  queueName: string;
  httpRequest: string | null; // JSON-serialized TaskHttpRequest
  appEngineHttpRequest: string | null; // JSON-serialized AppEngineHttpRequest
  scheduleTime: string;
  dispatchDeadline: string;
  dispatchCount: number;
  responseCount: number;
  firstAttempt: string | null; // JSON-serialized Attempt
  lastAttempt: string | null; // JSON-serialized Attempt
  status: string;
  tombstoneExpiry: string | null;
}

// ── Table Schemas ──

export const tasksQueuesTableSchema: TableSchema = {
  name: TASKS_QUEUES_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'state', type: 'string' },
    { name: 'rateLimits', type: 'json' },
    { name: 'retryConfig', type: 'json' },
    { name: 'purgeTime', type: 'string', nullable: true },
    { name: 'taskTtl', type: 'string' },
    { name: 'tombstoneTtl', type: 'string' },
    { name: 'stackdriverLoggingConfig', type: 'json', nullable: true },
    { name: 'httpTarget', type: 'json', nullable: true },
    { name: 'appEngineRoutingOverride', type: 'json', nullable: true },
  ],
  indexes: [
    { name: 'idx_tasks_queues_name', columns: ['name'], unique: true },
    { name: 'idx_tasks_queues_state', columns: ['state'] },
  ],
  timestamps: true,
};

export const tasksTableSchema: TableSchema = {
  name: TASKS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'queueName', type: 'string' },
    { name: 'httpRequest', type: 'json', nullable: true },
    { name: 'appEngineHttpRequest', type: 'json', nullable: true },
    { name: 'scheduleTime', type: 'string' },
    { name: 'dispatchDeadline', type: 'string' },
    { name: 'dispatchCount', type: 'number' },
    { name: 'responseCount', type: 'number' },
    { name: 'firstAttempt', type: 'json', nullable: true },
    { name: 'lastAttempt', type: 'json', nullable: true },
    { name: 'status', type: 'string' },
    { name: 'tombstoneExpiry', type: 'string', nullable: true },
  ],
  indexes: [
    { name: 'idx_tasks_items_name', columns: ['name'], unique: true },
    { name: 'idx_tasks_items_queue_status', columns: ['queueName', 'status'] },
    { name: 'idx_tasks_items_schedule_time', columns: ['scheduleTime'] },
    { name: 'idx_tasks_items_tombstone_expiry', columns: ['tombstoneExpiry'] },
  ],
  timestamps: true,
};

// ── Protobuf Enum Mapping ──

const VALID_HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;

type HttpMethodString = (typeof VALID_HTTP_METHODS)[number];

const PROTOBUF_HTTP_METHOD_MAP: Record<number, HttpMethodString> = {
  0: 'POST', // HTTP_METHOD_UNSPECIFIED defaults to POST
  1: 'POST',
  2: 'GET',
  3: 'HEAD',
  4: 'PUT',
  5: 'DELETE',
  6: 'PATCH',
  7: 'OPTIONS',
};

export function normalizeHttpMethod(value: string | number): HttpMethodString {
  if (typeof value === 'number') {
    const method = PROTOBUF_HTTP_METHOD_MAP[value];

    if (!method) {
      throw new Error(`Unknown protobuf HttpMethod enum value: ${value}`);
    }

    return method;
  }

  const upper = value.toUpperCase();

  if (!VALID_HTTP_METHODS.includes(upper as HttpMethodString)) {
    throw new Error(`Unknown HTTP method: ${value}`);
  }

  return upper as HttpMethodString;
}

// ── Zod Schemas ──

export const RateLimitsSchema = z.object({
  maxDispatchesPerSecond: z.number().min(0.01).max(500).optional(),
  maxBurstSize: z.number().int().min(0).optional(),
  maxConcurrentDispatches: z.number().int().min(0).max(5000).optional(),
});

export const TaskRetryConfigSchema = z.object({
  maxAttempts: z.number().int().min(-1).max(100).optional(),
  maxRetryDuration: z.string().optional(),
  minBackoff: z.string().optional(),
  maxBackoff: z.string().optional(),
  maxDoublings: z.number().int().min(0).optional(),
});

export function mergeRateLimits(
  partial: z.infer<typeof RateLimitsSchema> | null | undefined,
  base: RateLimits
): RateLimits {
  if (!partial) {
    return base;
  }

  return {
    maxDispatchesPerSecond: partial.maxDispatchesPerSecond ?? base.maxDispatchesPerSecond,
    maxBurstSize: partial.maxBurstSize ?? base.maxBurstSize,
    maxConcurrentDispatches: partial.maxConcurrentDispatches ?? base.maxConcurrentDispatches,
  };
}

export function mergeTaskRetryConfig(
  partial: z.infer<typeof TaskRetryConfigSchema> | null | undefined,
  base: TaskRetryConfig
): TaskRetryConfig {
  if (!partial) {
    return base;
  }

  return {
    maxAttempts: partial.maxAttempts ?? base.maxAttempts,
    maxRetryDuration: partial.maxRetryDuration ?? base.maxRetryDuration,
    minBackoff: partial.minBackoff ?? base.minBackoff,
    maxBackoff: partial.maxBackoff ?? base.maxBackoff,
    maxDoublings: partial.maxDoublings ?? base.maxDoublings,
  };
}

const StackdriverLoggingConfigSchema = z.object({
  samplingRatio: z.number().min(0).max(1),
});

export const TaskHttpRequestSchema = z.object({
  url: z.string().min(1),
  httpMethod: z
    .union([z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']), z.number().int()])
    .transform(val => normalizeHttpMethod(val)),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  oauthToken: z
    .object({
      serviceAccountEmail: z.string().optional(),
      scope: z.string().optional(),
    })
    .optional(),
  oidcToken: z
    .object({
      serviceAccountEmail: z.string().optional(),
      audience: z.string().optional(),
    })
    .optional(),
});

const UriOverrideSchema = z.object({
  host: z.string().optional(),
  port: z.number().int().optional(),
  pathOverride: z.object({ path: z.string().optional() }).optional(),
  queryOverride: z.object({ queryParams: z.string().optional() }).optional(),
  scheme: z.string().optional(),
  uriOverrideEnforceMode: z.string().optional(),
});

const HeaderOverrideSchema = z.object({
  header: z.object({ key: z.string(), value: z.string() }),
});

const AppEngineHttpRequestSchema = z.object({
  httpMethod: z
    .union([z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']), z.number().int()])
    .transform(val => normalizeHttpMethod(val))
    .optional(),
  relativeUri: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  appEngineRouting: z
    .object({
      service: z.string().optional(),
      version: z.string().optional(),
      instance: z.string().optional(),
    })
    .optional(),
});

const AppEngineRoutingOverrideSchema = z.object({
  service: z.string().optional(),
  version: z.string().optional(),
  instance: z.string().optional(),
});

const QueueHttpTargetSchema = z.object({
  uriOverride: UriOverrideSchema.optional(),
  httpMethod: z
    .union([z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']), z.number().int()])
    .transform(val => normalizeHttpMethod(val))
    .optional(),
  headerOverrides: z.array(HeaderOverrideSchema).optional(),
  oauthToken: z
    .object({
      serviceAccountEmail: z.string().optional(),
      scope: z.string().optional(),
    })
    .optional(),
  oidcToken: z
    .object({
      serviceAccountEmail: z.string().optional(),
      audience: z.string().optional(),
    })
    .optional(),
});

export const CreateQueueRequestSchema = z.object({
  rateLimits: RateLimitsSchema.nullish(),
  retryConfig: TaskRetryConfigSchema.nullish(),
  stackdriverLoggingConfig: StackdriverLoggingConfigSchema.nullish(),
  httpTarget: QueueHttpTargetSchema.nullish(),
  appEngineRoutingOverride: AppEngineRoutingOverrideSchema.nullish(),
});

export const UpdateQueueRequestSchema = z.object({
  rateLimits: RateLimitsSchema.nullish(),
  retryConfig: TaskRetryConfigSchema.nullish(),
  stackdriverLoggingConfig: StackdriverLoggingConfigSchema.nullish(),
  httpTarget: QueueHttpTargetSchema.nullish(),
  appEngineRoutingOverride: AppEngineRoutingOverrideSchema.nullish(),
});

export const CreateTaskRequestSchema = z.object({
  task: z
    .object({
      name: z.string().optional(),
      httpRequest: TaskHttpRequestSchema.optional(),
      appEngineHttpRequest: AppEngineHttpRequestSchema.optional(),
      scheduleTime: z.string().datetime({ offset: true }).optional(),
      dispatchDeadline: z.string().optional(),
    })
    .refine(data => data.httpRequest || data.appEngineHttpRequest, {
      message: 'Either httpRequest or appEngineHttpRequest must be provided',
    }),
  responseView: z.enum(['BASIC', 'FULL']).optional(),
});

export type CreateQueueRequest = z.infer<typeof CreateQueueRequestSchema>;

// ── Helper Functions ──

export function parseQueueName(name: string): {
  project: string;
  location: string;
  queueId: string;
} {
  const match = name.match(/^projects\/([^/]+)\/locations\/([^/]+)\/queues\/([^/]+)$/);

  if (!match) {
    throw new Error(
      `Invalid queue resource name: "${name}". Expected format: projects/{project}/locations/{location}/queues/{queueId}`
    );
  }

  return {
    project: match[1] as string,
    location: match[2] as string,
    queueId: match[3] as string,
  };
}

export function buildQueueName(project: string, location: string, queueId: string): string {
  return `projects/${project}/locations/${location}/queues/${queueId}`;
}

export function parseTaskName(name: string): {
  project: string;
  location: string;
  queueId: string;
  taskId: string;
} {
  const match = name.match(
    /^projects\/([^/]+)\/locations\/([^/]+)\/queues\/([^/]+)\/tasks\/([^/]+)$/
  );

  if (!match) {
    throw new Error(
      `Invalid task resource name: "${name}". Expected format: projects/{project}/locations/{location}/queues/{queueId}/tasks/{taskId}`
    );
  }

  return {
    project: match[1] as string,
    location: match[2] as string,
    queueId: match[3] as string,
    taskId: match[4] as string,
  };
}

export function buildTaskName(
  project: string,
  location: string,
  queueId: string,
  taskId: string
): string {
  return `projects/${project}/locations/${location}/queues/${queueId}/tasks/${taskId}`;
}

// Re-export shared duration parser for backwards compatibility
export { parseDurationSeconds } from '@/shared/utils/duration.ts';

// ── Conversion Utilities ──

function parseJsonField<T>(json: string, fieldName: string, recordName: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new Error(
      `Corrupt ${fieldName} JSON in record "${recordName}": ${json.substring(0, 100)}`
    );
  }
}

// ── Conversion Functions ──

export function queueRecordToResponse(record: QueueRecord): QueueResponse {
  const response: QueueResponse = {
    name: record.name,
    state: record.state,
    rateLimits: parseJsonField<RateLimits>(record.rateLimits, 'rateLimits', record.name),
    retryConfig: parseJsonField<TaskRetryConfig>(record.retryConfig, 'retryConfig', record.name),
    taskTtl: record.taskTtl,
    tombstoneTtl: record.tombstoneTtl,
  };

  if (record.purgeTime) {
    response.purgeTime = record.purgeTime;
  }

  if (record.stackdriverLoggingConfig) {
    response.stackdriverLoggingConfig = parseJsonField<StackdriverLoggingConfig>(
      record.stackdriverLoggingConfig,
      'stackdriverLoggingConfig',
      record.name
    );
  }

  if (record.httpTarget) {
    response.httpTarget = parseJsonField<QueueHttpTarget>(
      record.httpTarget,
      'httpTarget',
      record.name
    );
  }

  if (record.appEngineRoutingOverride) {
    response.appEngineRoutingOverride = parseJsonField<AppEngineRoutingOverride>(
      record.appEngineRoutingOverride,
      'appEngineRoutingOverride',
      record.name
    );
  }

  return response;
}

export function requestToQueueRecord(
  name: string,
  body: CreateQueueRequest
): Omit<QueueRecord, keyof BaseRecord> {
  return {
    name,
    state: QueueState.RUNNING,
    rateLimits: JSON.stringify(mergeRateLimits(body.rateLimits ?? undefined, DEFAULT_RATE_LIMITS)),
    retryConfig: JSON.stringify(
      mergeTaskRetryConfig(body.retryConfig ?? undefined, DEFAULT_RETRY_CONFIG)
    ),
    purgeTime: null,
    taskTtl: DEFAULT_TASK_TTL,
    tombstoneTtl: DEFAULT_TOMBSTONE_TTL,
    stackdriverLoggingConfig: body.stackdriverLoggingConfig
      ? JSON.stringify(body.stackdriverLoggingConfig)
      : null,
    httpTarget: body.httpTarget ? JSON.stringify(body.httpTarget) : null,
    appEngineRoutingOverride: body.appEngineRoutingOverride
      ? JSON.stringify(body.appEngineRoutingOverride)
      : null,
  };
}

export function taskRecordToResponse(record: TaskRecord, view?: string): TaskResponse {
  const isBasic = view === 'BASIC';

  const response: TaskResponse = {
    name: record.name,
    scheduleTime: record.scheduleTime,
    createTime: record.createdAt.toISOString(),
    dispatchDeadline: record.dispatchDeadline,
    dispatchCount: record.dispatchCount,
    responseCount: record.responseCount,
    view: view ?? 'FULL',
  };

  if (record.httpRequest) {
    const httpRequest = parseJsonField<TaskHttpRequest>(
      record.httpRequest,
      'httpRequest',
      record.name
    );

    if (isBasic) {
      delete httpRequest.body;
    }

    response.httpRequest = httpRequest;
  }

  if (record.appEngineHttpRequest) {
    const appEngineHttpRequest = parseJsonField<AppEngineHttpRequest>(
      record.appEngineHttpRequest,
      'appEngineHttpRequest',
      record.name
    );

    if (isBasic) {
      delete appEngineHttpRequest.body;
    }

    response.appEngineHttpRequest = appEngineHttpRequest;
  }

  if (!isBasic && record.firstAttempt) {
    response.firstAttempt = parseJsonField<Attempt>(
      record.firstAttempt,
      'firstAttempt',
      record.name
    );
  }

  if (!isBasic && record.lastAttempt) {
    response.lastAttempt = parseJsonField<Attempt>(record.lastAttempt, 'lastAttempt', record.name);
  }

  return response;
}

export function requestToTaskRecord(
  name: string,
  queueName: string,
  taskData: {
    httpRequest?: {
      url: string;
      httpMethod: string;
      headers?: Record<string, string> | undefined;
      body?: string | undefined;
    };
    appEngineHttpRequest?: AppEngineHttpRequest;
    scheduleTime?: string | undefined;
    dispatchDeadline?: string | undefined;
  },
  defaults: { taskTtl: string; tombstoneTtl: string }
): Omit<TaskRecord, keyof BaseRecord> {
  // TODO(task-ttl): Neither defaults.taskTtl nor defaults.tombstoneTtl is applied yet, so
  // task records and tombstones never expire. Real Cloud Tasks purges completed tasks after
  // the queue's retention window; until this is wired up, storage grows without bound.
  void defaults;

  return {
    name,
    queueName,
    httpRequest: taskData.httpRequest ? JSON.stringify(taskData.httpRequest) : null,
    appEngineHttpRequest: taskData.appEngineHttpRequest
      ? JSON.stringify(taskData.appEngineHttpRequest)
      : null,
    scheduleTime: taskData.scheduleTime ?? new Date().toISOString(),
    dispatchDeadline: taskData.dispatchDeadline ?? DEFAULT_DISPATCH_DEADLINE,
    dispatchCount: 0,
    responseCount: 0,
    firstAttempt: null,
    lastAttempt: null,
    status: TaskStatus.PENDING,
    tombstoneExpiry: null,
  };
}
