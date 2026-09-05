/**
 * Queue Repository - persistence layer wrapping StorageManager
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord, QueryCondition } from '@/core/storage/types.ts';
import { DEFAULT_LIST_PAGE_SIZE, parseOffsetToken } from '@/shared/utils/pagination.ts';
import { TasksError } from './errors.ts';
import type { QueueRecord } from './types.ts';
import { QueueState, TASKS_QUEUES_TABLE, tasksQueuesTableSchema } from './types.ts';

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
    pageToken?: string,
    filter?: string
  ): Promise<ListQueuesResult> {
    const prefix = `projects/${project}/locations/${location}/queues/`;

    const offset = parseOffsetToken(pageToken);
    const limit = pageSize ?? DEFAULT_LIST_PAGE_SIZE;

    const conditions: QueryCondition[] = [{ field: 'name', operator: 'like', value: `${prefix}%` }];

    if (filter) {
      const match = filter.match(/^(\w+)\s*=\s*(\w+)$/);

      if (!match) {
        throw new TasksError('INVALID_ARGUMENT', `Invalid filter expression: ${filter}`);
      }

      conditions.push({ field: match[1] as string, operator: 'eq', value: match[2] as string });
    }

    const result = await this.storage.find<QueueRecord>(TASKS_QUEUES_TABLE, {
      filter: {
        conditions,
        operator: 'and',
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
