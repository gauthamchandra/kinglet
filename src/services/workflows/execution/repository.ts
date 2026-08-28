/**
 * Execution Repository — persistence layer for workflow executions
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { DEFAULT_LIST_PAGE_SIZE, parseOffsetToken } from '@/shared/utils/pagination.ts';
import type { ExecutionRecord } from './types.ts';
import { EXECUTIONS_TABLE, executionsTableSchema } from './types.ts';

export interface ListExecutionsResult {
  executions: ExecutionRecord[];
  nextPageToken?: string | undefined;
}

export class ExecutionRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(EXECUTIONS_TABLE, executionsTableSchema);
  }

  async createExecution(data: Omit<ExecutionRecord, keyof BaseRecord>): Promise<ExecutionRecord> {
    return this.storage.create<ExecutionRecord>(EXECUTIONS_TABLE, data);
  }

  async getExecutionByName(name: string): Promise<ExecutionRecord | null> {
    return this.storage.findFirst<ExecutionRecord>(EXECUTIONS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }

  async listExecutions(
    workflowName: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListExecutionsResult> {
    const offset = parseOffsetToken(pageToken);
    const limit = pageSize ?? DEFAULT_LIST_PAGE_SIZE;

    const result = await this.storage.find<ExecutionRecord>(EXECUTIONS_TABLE, {
      filter: {
        conditions: [{ field: 'workflowName', operator: 'eq', value: workflowName }],
      },
      pagination: { limit, offset },
      sort: [{ field: 'startTime', direction: 'desc' }],
    });

    const nextPageToken = result.hasMore ? String(offset + limit) : undefined;

    return {
      executions: result.data,
      nextPageToken,
    };
  }

  async updateExecution(
    name: string,
    data: Partial<Omit<ExecutionRecord, keyof BaseRecord>>
  ): Promise<ExecutionRecord | null> {
    const existing = await this.getExecutionByName(name);

    if (!existing) {
      return null;
    }

    return this.storage.updateById<ExecutionRecord>(EXECUTIONS_TABLE, existing.id, data);
  }
}
