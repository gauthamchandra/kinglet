/**
 * LRO Operations Store - manages long-running operation records for Cloud Workflows
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { DEFAULT_LIST_PAGE_SIZE, parseOffsetToken } from '@/shared/utils/pagination.ts';
import type { OperationRecord, OperationResponse } from './types.ts';
import {
  buildOperationName,
  operationRecordToResponse,
  WORKFLOW_OPERATIONS_TABLE,
  workflowOperationsTableSchema,
} from './types.ts';

export interface ListOperationsResult {
  operations: OperationResponse[];
  nextPageToken?: string | undefined;
}

export class OperationsStore {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(WORKFLOW_OPERATIONS_TABLE, workflowOperationsTableSchema);
  }

  async createOperation(
    project: string,
    location: string,
    target: string,
    verb: string,
    response?: unknown
  ): Promise<OperationResponse> {
    const operationId = crypto.randomUUID();
    const name = buildOperationName(project, location, operationId);
    const now = new Date().toISOString();

    const data: Omit<OperationRecord, keyof BaseRecord> = {
      name,
      metadata: JSON.stringify({
        createTime: now,
        endTime: now,
        target,
        verb,
        apiVersion: 'v1',
      }),
      done: 1, // Always done for local emulation
      response: response ? JSON.stringify(response) : null,
      error: null,
    };

    const record = await this.storage.create<OperationRecord>(WORKFLOW_OPERATIONS_TABLE, data);

    return operationRecordToResponse(record);
  }

  async getOperation(name: string): Promise<OperationResponse | null> {
    const record = await this.storage.findFirst<OperationRecord>(WORKFLOW_OPERATIONS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });

    if (!record) {
      return null;
    }

    return operationRecordToResponse(record);
  }

  async listOperations(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListOperationsResult> {
    const prefix = `projects/${project}/locations/${location}/operations/`;

    const offset = parseOffsetToken(pageToken);
    const limit = pageSize ?? DEFAULT_LIST_PAGE_SIZE;

    const result = await this.storage.find<OperationRecord>(WORKFLOW_OPERATIONS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'like', value: `${prefix}%` }],
      },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    const nextPageToken = result.hasMore ? String(offset + limit) : undefined;

    return {
      operations: result.data.map(operationRecordToResponse),
      nextPageToken,
    };
  }

  async deleteOperation(name: string): Promise<boolean> {
    const record = await this.storage.findFirst<OperationRecord>(WORKFLOW_OPERATIONS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });

    if (!record) {
      return false;
    }

    return this.storage.deleteById(WORKFLOW_OPERATIONS_TABLE, record.id);
  }
}
