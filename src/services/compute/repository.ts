/**
 * Compute service repository — persistence only.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { DEFAULT_LIST_PAGE_SIZE, parseOffsetToken } from '@/shared/utils/pagination.ts';
import type { GlobalOperationRecord, SecurityPolicyRecord } from './types.ts';
import {
  GLOBAL_OPERATIONS_TABLE,
  globalOperationsTableSchema,
  SECURITY_POLICIES_TABLE,
  securityPoliciesTableSchema,
} from './types.ts';

export interface ListPoliciesResult {
  items: SecurityPolicyRecord[];
  nextPageToken?: string | undefined;
}

export class ComputeRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(SECURITY_POLICIES_TABLE, securityPoliciesTableSchema);
    await this.storage.createTable(GLOBAL_OPERATIONS_TABLE, globalOperationsTableSchema);
  }

  async createPolicy(
    data: Omit<SecurityPolicyRecord, keyof BaseRecord>
  ): Promise<SecurityPolicyRecord> {
    const existing = await this.getPolicyByProjectAndName(data.project, data.name);

    if (existing != null) {
      throw new Error(`Policy ${data.name} already exists in project ${data.project}`);
    }

    return this.storage.create<SecurityPolicyRecord>(SECURITY_POLICIES_TABLE, data);
  }

  async getPolicyByProjectAndName(
    project: string,
    name: string
  ): Promise<SecurityPolicyRecord | null> {
    return this.storage.findFirst<SecurityPolicyRecord>(SECURITY_POLICIES_TABLE, {
      filter: {
        conditions: [
          { field: 'project', operator: 'eq', value: project },
          { field: 'name', operator: 'eq', value: name },
        ],
        operator: 'and',
      },
    });
  }

  async listPoliciesByProject(
    project: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListPoliciesResult> {
    const offset = parseOffsetToken(pageToken);
    const limit = pageSize != null && pageSize > 0 ? pageSize : DEFAULT_LIST_PAGE_SIZE;

    const result = await this.storage.find<SecurityPolicyRecord>(SECURITY_POLICIES_TABLE, {
      filter: {
        conditions: [{ field: 'project', operator: 'eq', value: project }],
      },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    const hasMore = result.hasMore;
    const nextPageToken = hasMore ? String(offset + limit) : undefined;

    return {
      items: result.data,
      nextPageToken,
    };
  }

  async updatePolicy(
    id: string,
    data: Partial<Omit<SecurityPolicyRecord, keyof BaseRecord>>
  ): Promise<SecurityPolicyRecord | null> {
    return this.storage.updateById<SecurityPolicyRecord>(SECURITY_POLICIES_TABLE, id, data);
  }

  async deletePolicy(id: string): Promise<boolean> {
    return this.storage.deleteById(SECURITY_POLICIES_TABLE, id);
  }

  async createOperation(
    data: Omit<GlobalOperationRecord, keyof BaseRecord>
  ): Promise<GlobalOperationRecord> {
    return this.storage.create<GlobalOperationRecord>(GLOBAL_OPERATIONS_TABLE, data);
  }

  async getOperationByProjectAndId(
    project: string,
    operationId: string
  ): Promise<GlobalOperationRecord | null> {
    return this.storage.findFirst<GlobalOperationRecord>(GLOBAL_OPERATIONS_TABLE, {
      filter: {
        conditions: [
          { field: 'project', operator: 'eq', value: project },
          { field: 'operationId', operator: 'eq', value: operationId },
        ],
        operator: 'and',
      },
    });
  }
}
