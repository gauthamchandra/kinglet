/**
 * Task Service - business logic for Cloud Tasks task CRUD
 */

import { randomUUID } from 'node:crypto';
import type { TaskRepository } from './task-repository.ts';
import type { QueueRepository } from './queue-repository.ts';
import {
  buildTaskName,
  CreateTaskRequestSchema,
  QueueState,
  taskRecordToResponse,
  requestToTaskRecord,
  TaskStatus,
  parseDurationSeconds,
} from './types.ts';
import type { TaskRecord, TaskResponse } from './types.ts';
import { TasksError } from './queue-service.ts';

export type DispatchCallback = (task: TaskRecord) => Promise<void>;

export interface ListTasksResponse {
  tasks: TaskResponse[];
  nextPageToken?: string | undefined;
}

export class TaskService {
  private taskRepo: TaskRepository;
  private queueRepo: QueueRepository;
  private dispatchCallback: DispatchCallback | null = null;

  constructor(taskRepo: TaskRepository, queueRepo: QueueRepository) {
    this.taskRepo = taskRepo;
    this.queueRepo = queueRepo;
  }

  setDispatchCallback(callback: DispatchCallback): void {
    this.dispatchCallback = callback;
  }

  async createTask(
    project: string,
    location: string,
    queueId: string,
    body: unknown
  ): Promise<TaskResponse> {
    const parsed = CreateTaskRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new TasksError('INVALID_ARGUMENT', `Invalid task request: ${parsed.error.message}`);
    }

    const request = parsed.data;

    const queueName = `projects/${project}/locations/${location}/queues/${queueId}`;
    const queue = await this.queueRepo.getQueueByName(queueName);

    if (!queue) {
      throw new TasksError('NOT_FOUND', `Queue ${queueName} not found`);
    }

    if (queue.state === QueueState.DISABLED) {
      throw new TasksError('FAILED_PRECONDITION', `Queue ${queueName} is disabled`);
    }

    let taskId: string;

    if (request.task.name) {
      const nameParts = request.task.name.split('/');

      taskId = nameParts[nameParts.length - 1] ?? randomUUID();
    } else {
      taskId = randomUUID();
    }

    const taskName = buildTaskName(project, location, queueId, taskId);

    const existing = await this.taskRepo.getTaskByName(taskName);

    if (existing) {
      throw new TasksError('ALREADY_EXISTS', `Task ${taskName} already exists`);
    }

    const tombstone = await this.taskRepo.findTombstone(taskName);

    if (tombstone) {
      throw new TasksError(
        'ALREADY_EXISTS',
        `Task ${taskName} was recently deleted (tombstone deduplication)`
      );
    }

    const record = requestToTaskRecord(
      taskName,
      queueName,
      {
        httpRequest: request.task.httpRequest,
        scheduleTime: request.task.scheduleTime,
        dispatchDeadline: request.task.dispatchDeadline,
      },
      { taskTtl: queue.taskTtl, tombstoneTtl: queue.tombstoneTtl }
    );

    const created = await this.taskRepo.createTask(record);

    return taskRecordToResponse(created, request.responseView);
  }

  async getTask(name: string, responseView?: string): Promise<TaskResponse> {
    const record = await this.taskRepo.getTaskByName(name);

    if (!record || record.status === TaskStatus.TOMBSTONE) {
      throw new TasksError('NOT_FOUND', `Task ${name} not found`);
    }

    return taskRecordToResponse(record, responseView);
  }

  async listTasks(
    queueName: string,
    responseView?: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListTasksResponse> {
    const result = await this.taskRepo.listTasks(queueName, pageSize, pageToken);

    return {
      tasks: result.tasks.map(t => taskRecordToResponse(t, responseView)),
      nextPageToken: result.nextPageToken,
    };
  }

  async deleteTask(name: string): Promise<void> {
    const record = await this.taskRepo.getTaskByName(name);

    if (!record || record.status === TaskStatus.TOMBSTONE) {
      throw new TasksError('NOT_FOUND', `Task ${name} not found`);
    }

    const queue = await this.queueRepo.getQueueByName(record.queueName);

    const tombstoneTtlSeconds = queue ? parseDurationSeconds(queue.tombstoneTtl) : 3600;

    const tombstoneExpiry = new Date(Date.now() + tombstoneTtlSeconds * 1000).toISOString();

    await this.taskRepo.updateTask(name, {
      status: TaskStatus.TOMBSTONE,
      tombstoneExpiry,
    });
  }

  async runTask(name: string): Promise<TaskResponse> {
    const record = await this.taskRepo.getTaskByName(name);

    if (!record || record.status === TaskStatus.TOMBSTONE) {
      throw new TasksError('NOT_FOUND', `Task ${name} not found`);
    }

    if (this.dispatchCallback) {
      await this.dispatchCallback(record);
    }

    return taskRecordToResponse(record);
  }
}
