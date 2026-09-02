/**
 * Cloud Scheduler data models, schemas, and helper functions
 */

import { z } from 'zod';
import type { BaseRecord, TableSchema } from '@/core/storage/types.ts';

// ── Constants ──

export const SCHEDULER_JOBS_TABLE = 'scheduler_jobs';

export const DEFAULT_TIMEZONE = 'UTC';

const DEFAULT_ATTEMPT_DEADLINE = '180s';

export const JobState = {
  ENABLED: 'ENABLED',
  PAUSED: 'PAUSED',
  DISABLED: 'DISABLED',
  UPDATE_FAILED: 'UPDATE_FAILED',
} as const;

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  retryCount: 0,
  maxRetryDuration: '0s',
  minBackoffDuration: '5s',
  maxBackoffDuration: '3600s',
  maxDoublings: 5,
};

// ── Interfaces ──

export interface HttpTarget {
  uri: string;
  httpMethod: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface PubsubTarget {
  topicName: string;
  data?: string;
  attributes?: Record<string, string>;
}

export interface RetryConfig {
  retryCount: number;
  maxRetryDuration: string;
  minBackoffDuration: string;
  maxBackoffDuration: string;
  maxDoublings: number;
}

export interface JobResponse {
  name: string;
  description: string;
  schedule: string;
  timeZone: string;
  state: string;
  httpTarget?: HttpTarget;
  pubsubTarget?: PubsubTarget;
  retryConfig: RetryConfig;
  attemptDeadline: string;
  scheduleTime?: string;
  lastAttemptTime?: string;
  userUpdateTime?: string;
}

// ── Storage Record ──

export interface JobRecord extends BaseRecord {
  name: string;
  description: string;
  schedule: string;
  timeZone: string;
  state: string;
  httpTarget: string | null;
  pubsubTarget: string | null;
  retryConfig: string; // JSON-serialized RetryConfig
  attemptDeadline: string;
  lastAttemptTime: string | null;
  scheduleTime: string | null;
  userUpdateTime: string | null;
}

// ── Table Schema ──

export const schedulerJobsTableSchema: TableSchema = {
  name: SCHEDULER_JOBS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'description', type: 'string', nullable: true },
    { name: 'schedule', type: 'string' },
    { name: 'timeZone', type: 'string' },
    { name: 'state', type: 'string' },
    { name: 'httpTarget', type: 'json', nullable: true },
    { name: 'pubsubTarget', type: 'json', nullable: true },
    { name: 'retryConfig', type: 'json' },
    { name: 'attemptDeadline', type: 'string' },
    { name: 'lastAttemptTime', type: 'string', nullable: true },
    { name: 'scheduleTime', type: 'string', nullable: true },
    { name: 'userUpdateTime', type: 'string', nullable: true },
  ],
  indexes: [
    { name: 'idx_scheduler_jobs_name', columns: ['name'], unique: true },
    { name: 'idx_scheduler_jobs_state', columns: ['state'] },
    { name: 'idx_scheduler_jobs_schedule_time', columns: ['scheduleTime'] },
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

export const HttpTargetSchema = z.object({
  uri: z.string().min(1),
  httpMethod: z
    .union([z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']), z.number().int()])
    .transform(val => normalizeHttpMethod(val))
    .optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});

export const PubsubTargetSchema = z.object({
  topicName: z.string().min(1),
  data: z.string().optional(),
  attributes: z.record(z.string(), z.string()).optional(),
});

export const RetryConfigSchema = z.object({
  retryCount: z.number().int().min(0).optional(),
  maxRetryDuration: z.string().optional(),
  minBackoffDuration: z.string().optional(),
  maxBackoffDuration: z.string().optional(),
  maxDoublings: z.number().int().min(0).optional(),
});

export function normalizeHttpTarget(target: z.infer<typeof HttpTargetSchema>): HttpTarget {
  const normalized: HttpTarget = {
    uri: target.uri,
    httpMethod: target.httpMethod ?? 'POST',
  };

  if (target.headers != null) {
    normalized.headers = target.headers;
  }

  if (target.body != null) {
    normalized.body = target.body;
  }

  return normalized;
}

export function mergeRetryConfig(
  partial: z.infer<typeof RetryConfigSchema> | null | undefined,
  base: RetryConfig
): RetryConfig {
  if (!partial) {
    return base;
  }

  return {
    retryCount: partial.retryCount ?? base.retryCount,
    maxRetryDuration: partial.maxRetryDuration ?? base.maxRetryDuration,
    minBackoffDuration: partial.minBackoffDuration ?? base.minBackoffDuration,
    maxBackoffDuration: partial.maxBackoffDuration ?? base.maxBackoffDuration,
    maxDoublings: partial.maxDoublings ?? base.maxDoublings,
  };
}

export const CreateJobRequestSchema = z
  .object({
    description: z.string().optional(),
    schedule: z.string().min(1),
    timeZone: z.string().optional(),
    httpTarget: HttpTargetSchema.optional(),
    pubsubTarget: PubsubTargetSchema.optional(),
    retryConfig: RetryConfigSchema.nullish(),
    attemptDeadline: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    const targetCount = Number(data.httpTarget != null) + Number(data.pubsubTarget != null);

    if (targetCount !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'Exactly one of httpTarget or pubsubTarget must be set',
        path: ['httpTarget'],
      });
    }
  });

export const UpdateJobRequestSchema = z
  .object({
    description: z.string().optional(),
    schedule: z.string().min(1).optional(),
    timeZone: z.string().optional(),
    httpTarget: HttpTargetSchema.optional(),
    pubsubTarget: PubsubTargetSchema.optional(),
    retryConfig: RetryConfigSchema.nullish(),
    attemptDeadline: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.httpTarget != null && data.pubsubTarget != null) {
      ctx.addIssue({
        code: 'custom',
        message: 'At most one of httpTarget or pubsubTarget may be set',
        path: ['httpTarget'],
      });
    }
  });

export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

// ── Helper Functions ──

export function parseJobName(name: string): {
  project: string;
  location: string;
  jobId: string;
} {
  const match = name.match(/^projects\/([^/]+)\/locations\/([^/]+)\/jobs\/([^/]+)$/);

  if (!match) {
    throw new Error(
      `Invalid job resource name: "${name}". Expected format: projects/{project}/locations/{location}/jobs/{jobId}`
    );
  }

  return {
    project: match[1] as string,
    location: match[2] as string,
    jobId: match[3] as string,
  };
}

export function buildJobName(project: string, location: string, jobId: string): string {
  return `projects/${project}/locations/${location}/jobs/${jobId}`;
}

// Re-export shared duration parser for backwards compatibility
export { parseDurationSeconds } from '@/shared/utils/duration.ts';

// ── Conversion Functions ──

export function jobRecordToResponse(record: JobRecord): JobResponse {
  const response: JobResponse = {
    name: record.name,
    description: record.description,
    schedule: record.schedule,
    timeZone: record.timeZone,
    state: record.state,
    retryConfig: mergeRetryConfig(
      JSON.parse(record.retryConfig) as RetryConfig,
      DEFAULT_RETRY_CONFIG
    ),
    attemptDeadline: record.attemptDeadline,
  };

  if (record.pubsubTarget) {
    response.pubsubTarget = JSON.parse(record.pubsubTarget) as PubsubTarget;
  } else if (record.httpTarget) {
    response.httpTarget = JSON.parse(record.httpTarget) as HttpTarget;
  }

  if (record.scheduleTime) {
    response.scheduleTime = record.scheduleTime;
  }

  if (record.lastAttemptTime) {
    response.lastAttemptTime = record.lastAttemptTime;
  }

  if (record.userUpdateTime) {
    response.userUpdateTime = record.userUpdateTime;
  }

  return response;
}

export function requestToJobRecord(
  name: string,
  body: CreateJobRequest,
  scheduleTime: string
): Omit<JobRecord, keyof BaseRecord> {
  return {
    name,
    description: body.description ?? '',
    schedule: body.schedule,
    timeZone: body.timeZone ?? DEFAULT_TIMEZONE,
    state: JobState.ENABLED,
    httpTarget: body.httpTarget ? JSON.stringify(normalizeHttpTarget(body.httpTarget)) : null,
    pubsubTarget: body.pubsubTarget ? JSON.stringify(body.pubsubTarget) : null,
    retryConfig: JSON.stringify(
      mergeRetryConfig(body.retryConfig ?? undefined, DEFAULT_RETRY_CONFIG)
    ),
    attemptDeadline: body.attemptDeadline ?? DEFAULT_ATTEMPT_DEADLINE,
    lastAttemptTime: null,
    scheduleTime,
    userUpdateTime: new Date().toISOString(),
  };
}
