/**
 * Queue Repository - persistence layer wrapping StorageManager
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { tasksQueuesTableSchema, TASKS_QUEUES_TABLE, QueueState } from './types.ts';
import type { QueueRecord } from './types.ts';

export interface ListQueuesResult {
  queues: QueueRecord[];
  nextPageToken?: string | undefined;
}

export class QueueRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(TASKS_QUEUES_TABLE, tasksQueuesTableSchema);
  }

  async createQueue(data: Omit<QueueRecord, keyof BaseRecord>): Promise<QueueRecord> {
    const existing = await this.getQueueByName(data.name);

    if (existing) {
      throw new Error(`Queue ${data.name} already exists`);
    }

    return this.storage.create<QueueRecord>(TASKS_QUEUES_TABLE, data);
  }

  async getQueueByName(name: string): Promise<QueueRecord | null> {
    return this.storage.findFirst<QueueRecord>(TASKS_QUEUES_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }

  async listQueues(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListQueuesResult> {
    const prefix = `projects/${project}/locations/${location}/queues/`;

    const offset = pageToken ? parseInt(pageToken, 10) : 0;
    const limit = pageSize ?? 100;

    const result = await this.storage.find<QueueRecord>(TASKS_QUEUES_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'like', value: `${prefix}%` }],
      },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    const hasMore = result.hasMore;
    const nextPageToken = hasMore ? String(offset + limit) : undefined;

    return {
      queues: result.data,
      nextPageToken,
    };
  }

  async updateQueue(
    name: string,
    data: Partial<Omit<QueueRecord, keyof BaseRecord>>
  ): Promise<QueueRecord | null> {
    const existing = await this.getQueueByName(name);

    if (!existing) {
      return null;
    }

    return this.storage.updateById<QueueRecord>(TASKS_QUEUES_TABLE, existing.id, data);
  }

  async deleteQueue(name: string): Promise<boolean> {
    const existing = await this.getQueueByName(name);

    if (!existing) {
      return false;
    }

    return this.storage.deleteById(TASKS_QUEUES_TABLE, existing.id);
  }

  async findRunningQueues(): Promise<QueueRecord[]> {
    const result = await this.storage.find<QueueRecord>(TASKS_QUEUES_TABLE, {
      filter: {
        conditions: [{ field: 'state', operator: 'eq', value: QueueState.RUNNING }],
      },
    });

    return result.data;
  }
}
