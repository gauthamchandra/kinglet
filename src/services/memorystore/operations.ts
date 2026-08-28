/**
 * LRO Operations Store - manages long-running operation records for Memorystore for Valkey
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { DEFAULT_LIST_PAGE_SIZE, parseOffsetToken } from '@/shared/utils/pagination.ts';
import type { OperationMetadata, OperationRecord, OperationResponse } from './types.ts';
import {
  buildMemorystoreOperationName,
  MEMORYSTORE_OPERATIONS_TABLE,
  memorystoreOperationsTableSchema,
  operationRecordToResponse,
} from './types.ts';

const OPERATION_METADATA_TYPE = 'type.googleapis.com/google.cloud.memorystore.v1.OperationMetadata';

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
    const existingTables = await this.storage.listTables();

    if (existingTables.includes(MEMORYSTORE_OPERATIONS_TABLE)) return;

    await this.storage.createTable(MEMORYSTORE_OPERATIONS_TABLE, memorystoreOperationsTableSchema);
  }

  async createOperation(
    project: string,
    location: string,
    target: string,
    verb: string,
    resourceType: string,
    response?: Record<string, unknown>
  ): Promise<OperationResponse> {
    const operationId = crypto.randomUUID();
    const name = buildMemorystoreOperationName(project, location, operationId);
    const now = new Date().toISOString();

    const metadata: OperationMetadata = {
      '@type': OPERATION_METADATA_TYPE,
      createTime: now,
      endTime: now,
      target,
      verb,
      apiVersion: 'v1',
    };

    const data: Omit<OperationRecord, keyof BaseRecord> = {
      name,
      metadata: JSON.stringify(metadata),
      done: 1, // Always done for local emulation
      response: response
        ? JSON.stringify({
            '@type': `type.googleapis.com/google.cloud.memorystore.v1.${resourceType}`,
            ...response,
          })
        : null,
      error: null,
    };

    const record = await this.storage.create<OperationRecord>(MEMORYSTORE_OPERATIONS_TABLE, data);

    return operationRecordToResponse(record);
  }

  async getOperation(name: string): Promise<OperationResponse | null> {
    const record = await this.findRecordByName(name);

    return record ? operationRecordToResponse(record) : null;
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

    const result = await this.storage.find<OperationRecord>(MEMORYSTORE_OPERATIONS_TABLE, {
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
    const record = await this.findRecordByName(name);

    if (!record) return false;

    return this.storage.deleteById(MEMORYSTORE_OPERATIONS_TABLE, record.id);
  }

  async cancelOperation(name: string): Promise<boolean> {
    const record = await this.findRecordByName(name);

    if (!record) return false;

    const metadata = JSON.parse(record.metadata) as OperationMetadata;

    metadata.requestedCancellation = true;

    const updated = await this.storage.updateById<OperationRecord>(
      MEMORYSTORE_OPERATIONS_TABLE,
      record.id,
      { metadata: JSON.stringify(metadata) }
    );

    return updated !== null;
  }

  private async findRecordByName(name: string): Promise<OperationRecord | null> {
    return this.storage.findFirst<OperationRecord>(MEMORYSTORE_OPERATIONS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }
}
