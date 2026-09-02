/**
 * Job Service - business logic for Cloud Scheduler CRUD and state management
 */

import type { CronEngine } from './cron-engine.ts';
import type { JobRepository } from './repository.ts';
import type { JobRecord, JobResponse } from './types.ts';
import {
  buildJobName,
  CreateJobRequestSchema,
  JobState,
  jobRecordToResponse,
  mergeRetryConfig,
  normalizeHttpTarget,
  type RetryConfig,
  requestToJobRecord,
  UpdateJobRequestSchema,
} from './types.ts';

export type ExecuteCallback = (job: JobRecord) => Promise<void>;

export type SchedulerErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_ARGUMENT'
  | 'FAILED_PRECONDITION';

export class SchedulerError extends Error {
  readonly code: SchedulerErrorCode;

  constructor(code: SchedulerErrorCode, message: string) {
    super(message);
    this.name = 'SchedulerError';
    this.code = code;
  }
}

export interface ListJobsResponse {
  jobs: JobResponse[];
  nextPageToken?: string | undefined;
}

export class JobService {
  private repo: JobRepository;
  private cron: CronEngine;
  private executeCallback: ExecuteCallback | null = null;

  constructor(repo: JobRepository, cron: CronEngine) {
    this.repo = repo;
    this.cron = cron;
  }

  setExecuteCallback(callback: ExecuteCallback): void {
    this.executeCallback = callback;
  }

  async createJob(
    project: string,
    location: string,
    jobId: string,
    body: unknown
  ): Promise<JobResponse> {
    const parsed = CreateJobRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new SchedulerError('INVALID_ARGUMENT', `Invalid job request: ${parsed.error.message}`);
    }

    const request = parsed.data;

    const validation = this.cron.validate(request.schedule);

    if (!validation.valid) {
      throw new SchedulerError('INVALID_ARGUMENT', `Invalid cron expression: ${validation.error}`);
    }

    const name = buildJobName(project, location, jobId);

    const existing = await this.repo.getJobByName(name);

    if (existing) {
      throw new SchedulerError('ALREADY_EXISTS', `Job ${name} already exists`);
    }

    const nextRun = this.cron.getNextRunTime(request.schedule, request.timeZone ?? 'UTC');

    const record = requestToJobRecord(name, request, nextRun.toISOString());
    const created = await this.repo.createJob(record);

    return jobRecordToResponse(created);
  }

  async getJob(name: string): Promise<JobResponse> {
    const record = await this.repo.getJobByName(name);

    if (!record) {
      throw new SchedulerError('NOT_FOUND', `Job ${name} not found`);
    }

    return jobRecordToResponse(record);
  }

  async listJobs(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListJobsResponse> {
    const result = await this.repo.listJobs(project, location, pageSize, pageToken);

    return {
      jobs: result.jobs.map(jobRecordToResponse),
      nextPageToken: result.nextPageToken,
    };
  }

  async updateJob(name: string, body: unknown): Promise<JobResponse> {
    const parsed = UpdateJobRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new SchedulerError(
        'INVALID_ARGUMENT',
        `Invalid update request: ${parsed.error.message}`
      );
    }

    const existing = await this.repo.getJobByName(name);

    if (!existing) {
      throw new SchedulerError('NOT_FOUND', `Job ${name} not found`);
    }

    const request = parsed.data;
    const updates: Record<string, unknown> = {};

    if (request.description !== undefined) {
      updates.description = request.description;
    }

    if (request.schedule !== undefined) {
      const validation = this.cron.validate(request.schedule);

      if (!validation.valid) {
        throw new SchedulerError(
          'INVALID_ARGUMENT',
          `Invalid cron expression: ${validation.error}`
        );
      }

      updates.schedule = request.schedule;

      const nextRun = this.cron.getNextRunTime(
        request.schedule,
        request.timeZone ?? existing.timeZone
      );

      updates.scheduleTime = nextRun.toISOString();
    }

    if (request.timeZone !== undefined) {
      updates.timeZone = request.timeZone;
    }

    if (request.httpTarget !== undefined) {
      updates.httpTarget = JSON.stringify(normalizeHttpTarget(request.httpTarget));
      updates.pubsubTarget = null;
    }

    if (request.pubsubTarget !== undefined) {
      updates.pubsubTarget = JSON.stringify(request.pubsubTarget);
      updates.httpTarget = null;
    }

    if (request.retryConfig != null) {
      const existingRetryConfig = JSON.parse(existing.retryConfig) as RetryConfig;

      updates.retryConfig = JSON.stringify(
        mergeRetryConfig(request.retryConfig, existingRetryConfig)
      );
    }

    if (request.attemptDeadline !== undefined) {
      updates.attemptDeadline = request.attemptDeadline;
    }

    updates.userUpdateTime = new Date().toISOString();

    const updated = await this.repo.updateJob(name, updates);

    if (!updated) {
      throw new SchedulerError('NOT_FOUND', `Job ${name} not found`);
    }

    return jobRecordToResponse(updated);
  }

  async deleteJob(name: string): Promise<void> {
    const deleted = await this.repo.deleteJob(name);

    if (!deleted) {
      throw new SchedulerError('NOT_FOUND', `Job ${name} not found`);
    }
  }

  async pauseJob(name: string): Promise<JobResponse> {
    const existing = await this.repo.getJobByName(name);

    if (!existing) {
      throw new SchedulerError('NOT_FOUND', `Job ${name} not found`);
    }

    if (existing.state === JobState.PAUSED) {
      throw new SchedulerError('FAILED_PRECONDITION', `Job ${name} is already paused`);
    }

    const updated = await this.repo.updateJob(name, {
      state: JobState.PAUSED,
      scheduleTime: null,
      userUpdateTime: new Date().toISOString(),
    });

    if (!updated) {
      throw new SchedulerError('NOT_FOUND', `Job ${name} not found`);
    }

    return jobRecordToResponse(updated);
  }

  async resumeJob(name: string): Promise<JobResponse> {
    const existing = await this.repo.getJobByName(name);

    if (!existing) {
      throw new SchedulerError('NOT_FOUND', `Job ${name} not found`);
    }

    if (existing.state === JobState.ENABLED) {
      return jobRecordToResponse(existing);
    }

    if (existing.state !== JobState.PAUSED) {
      throw new SchedulerError(
        'FAILED_PRECONDITION',
        `Job ${name} is not paused (current state: ${existing.state})`
      );
    }

    const nextRun = this.cron.getNextRunTime(existing.schedule, existing.timeZone);

    const updated = await this.repo.updateJob(name, {
      state: JobState.ENABLED,
      scheduleTime: nextRun.toISOString(),
      userUpdateTime: new Date().toISOString(),
    });

    if (!updated) {
      throw new SchedulerError('NOT_FOUND', `Job ${name} not found`);
    }

    return jobRecordToResponse(updated);
  }

  async runJob(name: string): Promise<JobResponse> {
    const existing = await this.repo.getJobByName(name);

    if (!existing) {
      throw new SchedulerError('NOT_FOUND', `Job ${name} not found`);
    }

    if (this.executeCallback) {
      await this.executeCallback(existing);
    }

    return jobRecordToResponse(existing);
  }
}
