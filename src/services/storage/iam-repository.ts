/**
 * IAM policy persistence. One row per resource name.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import type { IamPolicyRecord } from './types.ts';
import { IAM_POLICIES_TABLE, iamPoliciesTableSchema } from './types.ts';

export class IamPolicyRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(IAM_POLICIES_TABLE, iamPoliciesTableSchema);
  }

  async getByResourceId(resourceId: string): Promise<IamPolicyRecord | null> {
    return this.storage.findFirst<IamPolicyRecord>(IAM_POLICIES_TABLE, {
      filter: {
        conditions: [{ field: 'resourceId', operator: 'eq', value: resourceId }],
      },
    });
  }

  async save(data: Omit<IamPolicyRecord, keyof BaseRecord>): Promise<IamPolicyRecord> {
    const existing = await this.getByResourceId(data.resourceId);

    if (!existing) {
      return this.storage.create<IamPolicyRecord>(IAM_POLICIES_TABLE, data);
    }

    const updated = await this.storage.updateById<IamPolicyRecord>(
      IAM_POLICIES_TABLE,
      existing.id,
      {
        version: data.version,
        etag: data.etag,
        bindings: data.bindings,
      }
    );

    if (!updated) {
      throw new Error(`IAM policy ${data.resourceId} disappeared during update`);
    }

    return updated;
  }
}
