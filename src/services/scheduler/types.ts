/**
 * Cloud Scheduler data models, schemas, and helper functions
 */

import { z } from 'zod';
import type { BaseRecord, TableSchema } from '@/core/storage/types.ts';

// ── Constants ──

export const SCHEDULER_JOBS_TABLE = 'scheduler_jobs';

export const DEFAULT_TIMEZONE = 'UTC';

export const DEFAULT_ATTEMPT_DEADLINE = '180s';

export const JobState = {
  ENABLED: 'ENABLED',
  PAUSED: 'PAUSED',
  DISABLED: 'DISABLED',
  UPDATE_FAILED: 'UPDATE_FAILED',
} as const;

export type JobStateType = (typeof JobState)[keyof typeof JobState];

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  retryCount: 0,
  maxRetryDuration: '0s',
  minBackoffDuration: '5s',
  maxBackoffDuration: '3600s',
};

// ── Interfaces ──

export interface HttpTarget {
  uri: string;
  httpMethod: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface RetryConfig {
  retryCount: number;
  maxRetryDuration: string;
  minBackoffDuration: string;
  maxBackoffDuration: string;
}

export interface JobResponse {
  name: string;
  description: string;
  schedule: string;
  timeZone: string;
  state: string;
  httpTarget: HttpTarget;
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
  httpTarget: string; // JSON-serialized HttpTarget
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
    { name: 'httpTarget', type: 'json' },
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

const HttpTargetSchema = z.object({
  uri: z.string().min(1),
  httpMethod: z
    .union([z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']), z.number().int()])
    .transform(val => normalizeHttpMethod(val)),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});

const RetryConfigSchema = z.object({
  retryCount: z.number().int().min(0),
  maxRetryDuration: z.string(),
  minBackoffDuration: z.string(),
  maxBackoffDuration: z.string(),
});

export const CreateJobRequestSchema = z.object({
  description: z.string().optional(),
  schedule: z.string().min(1),
  timeZone: z.string().optional(),
  httpTarget: HttpTargetSchema,
  retryConfig: RetryConfigSchema.optional(),
  attemptDeadline: z.string().optional(),
});

export const UpdateJobRequestSchema = z.object({
  description: z.string().optional(),
  schedule: z.string().min(1).optional(),
  timeZone: z.string().optional(),
  httpTarget: HttpTargetSchema.optional(),
  retryConfig: RetryConfigSchema.optional(),
  attemptDeadline: z.string().optional(),
});

export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;
export type UpdateJobRequest = z.infer<typeof UpdateJobRequestSchema>;

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

/**
 * Parse a GCP-style duration string (e.g., "5s", "3600s") into seconds.
 * Cloud Scheduler durations use this format for retry config fields.
 */
export function parseDurationSeconds(duration: string): number {
  const match = duration.match(/^(\d+(?:\.\d+)?)s$/);

  if (!match) {
    throw new Error(`Invalid duration format: "${duration}". Expected format like "5s" or "3600s"`);
  }

  return parseFloat(match[1] as string);
}

// ── Conversion Functions ──

export function jobRecordToResponse(record: JobRecord): JobResponse {
  const response: JobResponse = {
    name: record.name,
    description: record.description,
    schedule: record.schedule,
    timeZone: record.timeZone,
    state: record.state,
    httpTarget: JSON.parse(record.httpTarget) as HttpTarget,
    retryConfig: JSON.parse(record.retryConfig) as RetryConfig,
    attemptDeadline: record.attemptDeadline,
  };

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
    httpTarget: JSON.stringify(body.httpTarget),
    retryConfig: JSON.stringify(body.retryConfig ?? DEFAULT_RETRY_CONFIG),
    attemptDeadline: body.attemptDeadline ?? DEFAULT_ATTEMPT_DEADLINE,
    lastAttemptTime: null,
    scheduleTime,
    userUpdateTime: new Date().toISOString(),
  };
}
