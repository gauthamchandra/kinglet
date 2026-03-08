/**
 * Queue Service - business logic for Cloud Tasks queue CRUD and state management
 */

import type { RouteResponse } from '@/core/gateway/request-router.ts';
import type { ResponseUtils } from '@/core/gateway/response-handlers.ts';
import type { QueueRepository } from './queue-repository.ts';
import type { QueueResponse } from './types.ts';
import {
  buildQueueName,
  CreateQueueRequestSchema,
  QueueState,
  queueRecordToResponse,
  requestToQueueRecord,
  UpdateQueueRequestSchema,
} from './types.ts';

export type TasksErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_ARGUMENT'
  | 'FAILED_PRECONDITION';

export class TasksError extends Error {
  readonly code: TasksErrorCode;

  constructor(code: TasksErrorCode, message: string) {
    super(message);
    this.name = 'TasksError';
    this.code = code;
  }
}

export function handleTasksError(
  err: unknown,
  resourceType: string,
  responseUtils: ResponseUtils
): RouteResponse {
  if (err instanceof TasksError) {
    switch (err.code) {
      case 'NOT_FOUND':
        return responseUtils.notFound(resourceType, err.message);
      case 'ALREADY_EXISTS':
        return responseUtils.alreadyExists(resourceType, err.message);
      case 'INVALID_ARGUMENT':
        return responseUtils.badRequest(err.message);
      case 'FAILED_PRECONDITION':
        return responseUtils.failedPrecondition(err.message);
    }
  }

  return responseUtils.badRequest(err instanceof Error ? err.message : 'Unknown error');
}

export type PurgeCallback = (queueName: string) => Promise<void>;
export type DeleteCallback = (queueName: string) => Promise<void>;

export interface ListQueuesResponse {
  queues: QueueResponse[];
  nextPageToken?: string | undefined;
}

export class QueueService {
  private repo: QueueRepository;
  private purgeCallback: PurgeCallback | null = null;
  private deleteCallback: DeleteCallback | null = null;

  constructor(repo: QueueRepository) {
    this.repo = repo;
  }

  setPurgeCallback(callback: PurgeCallback): void {
    this.purgeCallback = callback;
  }

  setDeleteCallback(callback: DeleteCallback): void {
    this.deleteCallback = callback;
  }

  async createQueue(
    project: string,
    location: string,
    queueId: string,
    body: unknown
  ): Promise<QueueResponse> {
    const parsed = CreateQueueRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new TasksError('INVALID_ARGUMENT', `Invalid queue request: ${parsed.error.message}`);
    }

    const name = buildQueueName(project, location, queueId);

    const existing = await this.repo.getQueueByName(name);

    if (existing) {
      throw new TasksError('ALREADY_EXISTS', `Queue ${name} already exists`);
    }

    const record = requestToQueueRecord(name, parsed.data);

    const created = await this.repo.createQueue(record);

    return queueRecordToResponse(created);
  }

  async getQueue(name: string): Promise<QueueResponse> {
    const record = await this.repo.getQueueByName(name);

    if (!record) {
      throw new TasksError('NOT_FOUND', `Queue ${name} not found`);
    }

    return queueRecordToResponse(record);
  }

  async listQueues(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListQueuesResponse> {
    const result = await this.repo.listQueues(project, location, pageSize, pageToken);

    return {
      queues: result.queues.map(queueRecordToResponse),
      nextPageToken: result.nextPageToken,
    };
  }

  async updateQueue(name: string, body: unknown): Promise<QueueResponse> {
    const parsed = UpdateQueueRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new TasksError('INVALID_ARGUMENT', `Invalid update request: ${parsed.error.message}`);
    }

    const existing = await this.repo.getQueueByName(name);

    if (!existing) {
      throw new TasksError('NOT_FOUND', `Queue ${name} not found`);
    }

    const request = parsed.data;

    const updates: Record<string, unknown> = {};

    if (request.rateLimits !== undefined) {
      updates.rateLimits = JSON.stringify(request.rateLimits);
    }

    if (request.retryConfig !== undefined) {
      updates.retryConfig = JSON.stringify(request.retryConfig);
    }

    if (request.stackdriverLoggingConfig !== undefined) {
      updates.stackdriverLoggingConfig = JSON.stringify(request.stackdriverLoggingConfig);
    }

    const updated = await this.repo.updateQueue(name, updates);

    if (!updated) {
      throw new TasksError('NOT_FOUND', `Queue ${name} not found`);
    }

    return queueRecordToResponse(updated);
  }

  async deleteQueue(name: string): Promise<void> {
    const deleted = await this.repo.deleteQueue(name);

    if (!deleted) {
      throw new TasksError('NOT_FOUND', `Queue ${name} not found`);
    }

    if (this.deleteCallback) {
      await this.deleteCallback(name);
    }
  }

  async pauseQueue(name: string): Promise<QueueResponse> {
    const existing = await this.repo.getQueueByName(name);

    if (!existing) {
      throw new TasksError('NOT_FOUND', `Queue ${name} not found`);
    }

    if (existing.state === QueueState.PAUSED) {
      throw new TasksError('FAILED_PRECONDITION', `Queue ${name} is already paused`);
    }

    const updated = await this.repo.updateQueue(name, {
      state: QueueState.PAUSED,
    });

    if (!updated) {
      throw new TasksError('NOT_FOUND', `Queue ${name} not found`);
    }

    return queueRecordToResponse(updated);
  }

  async resumeQueue(name: string): Promise<QueueResponse> {
    const existing = await this.repo.getQueueByName(name);

    if (!existing) {
      throw new TasksError('NOT_FOUND', `Queue ${name} not found`);
    }

    if (existing.state !== QueueState.PAUSED) {
      throw new TasksError(
        'FAILED_PRECONDITION',
        `Queue ${name} is not paused (current state: ${existing.state})`
      );
    }

    const updated = await this.repo.updateQueue(name, {
      state: QueueState.RUNNING,
    });

    if (!updated) {
      throw new TasksError('NOT_FOUND', `Queue ${name} not found`);
    }

    return queueRecordToResponse(updated);
  }

  async purgeQueue(name: string): Promise<QueueResponse> {
    const existing = await this.repo.getQueueByName(name);

    if (!existing) {
      throw new TasksError('NOT_FOUND', `Queue ${name} not found`);
    }

    if (this.purgeCallback) {
      await this.purgeCallback(name);
    }

    const updated = await this.repo.updateQueue(name, {
      purgeTime: new Date().toISOString(),
    });

    if (!updated) {
      throw new TasksError('NOT_FOUND', `Queue ${name} not found`);
    }

    return queueRecordToResponse(updated);
  }
}
