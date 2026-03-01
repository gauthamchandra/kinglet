/**
 * Task Repository - persistence layer wrapping StorageManager
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { tasksTableSchema, TASKS_TABLE, TaskStatus } from './types.ts';
import type { TaskRecord } from './types.ts';

export interface ListTasksResult {
  tasks: TaskRecord[];
  nextPageToken?: string | undefined;
}

export class TaskRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(TASKS_TABLE, tasksTableSchema);
  }

  async createTask(data: Omit<TaskRecord, keyof BaseRecord>): Promise<TaskRecord> {
    const existing = await this.getTaskByName(data.name);

    if (existing) {
      throw new Error(`Task ${data.name} already exists`);
    }

    return this.storage.create<TaskRecord>(TASKS_TABLE, data);
  }

  async getTaskByName(name: string): Promise<TaskRecord | null> {
    return this.storage.findFirst<TaskRecord>(TASKS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }

  async listTasks(
    queueName: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListTasksResult> {
    const offset = pageToken ? parseInt(pageToken, 10) : 0;
    const limit = pageSize ?? 100;

    const result = await this.storage.find<TaskRecord>(TASKS_TABLE, {
      filter: {
        conditions: [
          { field: 'queueName', operator: 'eq', value: queueName },
          { field: 'status', operator: 'ne', value: TaskStatus.TOMBSTONE },
        ],
        operator: 'and',
      },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    const hasMore = result.hasMore;
    const nextPageToken = hasMore ? String(offset + limit) : undefined;

    return {
      tasks: result.data,
      nextPageToken,
    };
  }

  async deleteTask(name: string): Promise<boolean> {
    const existing = await this.getTaskByName(name);

    if (!existing) {
      return false;
    }

    return this.storage.deleteById(TASKS_TABLE, existing.id);
  }

  async deleteTasksByQueue(queueName: string): Promise<number> {
    return this.storage.deleteMany(TASKS_TABLE, {
      conditions: [{ field: 'queueName', operator: 'eq', value: queueName }],
    });
  }

  async findDispatchableTasks(queueName: string, limit: number): Promise<TaskRecord[]> {
    const now = new Date().toISOString();

    const result = await this.storage.find<TaskRecord>(TASKS_TABLE, {
      filter: {
        conditions: [
          { field: 'queueName', operator: 'eq', value: queueName },
          { field: 'status', operator: 'eq', value: TaskStatus.PENDING },
          { field: 'scheduleTime', operator: 'lte', value: now },
        ],
        operator: 'and',
      },
      pagination: { limit },
      sort: [{ field: 'scheduleTime', direction: 'asc' }],
    });

    return result.data;
  }

  async updateTask(
    name: string,
    data: Partial<Omit<TaskRecord, keyof BaseRecord>>
  ): Promise<TaskRecord | null> {
    const existing = await this.getTaskByName(name);

    if (!existing) {
      return null;
    }

    return this.storage.updateById<TaskRecord>(TASKS_TABLE, existing.id, data);
  }

  async findTombstone(name: string): Promise<TaskRecord | null> {
    return this.storage.findFirst<TaskRecord>(TASKS_TABLE, {
      filter: {
        conditions: [
          { field: 'name', operator: 'eq', value: name },
          { field: 'status', operator: 'eq', value: TaskStatus.TOMBSTONE },
        ],
        operator: 'and',
      },
    });
  }

  async cleanupExpiredTombstones(): Promise<number> {
    const now = new Date().toISOString();

    return this.storage.deleteMany(TASKS_TABLE, {
      conditions: [
        { field: 'status', operator: 'eq', value: TaskStatus.TOMBSTONE },
        { field: 'tombstoneExpiry', operator: 'lte', value: now },
        { field: 'tombstoneExpiry', operator: 'ne', value: null },
      ],
      operator: 'and',
    });
  }
}
