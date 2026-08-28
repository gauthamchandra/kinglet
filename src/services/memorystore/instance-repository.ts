/**
 * Instance Repository - persistence layer for Memorystore instances
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { DEFAULT_LIST_PAGE_SIZE, parseOffsetToken } from '@/shared/utils/pagination.ts';
import type { InstanceRecord } from './types.ts';
import { instanceTableSchema, MEMORYSTORE_INSTANCES_TABLE } from './types.ts';

export interface ListInstancesResult {
  instances: InstanceRecord[];
  nextPageToken?: string;
}

export class InstanceRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    const existingTables = await this.storage.listTables();

    if (existingTables.includes(MEMORYSTORE_INSTANCES_TABLE)) return;

    await this.storage.createTable(MEMORYSTORE_INSTANCES_TABLE, instanceTableSchema);
  }

  async createInstance(data: Omit<InstanceRecord, keyof BaseRecord>): Promise<InstanceRecord> {
    const existing = await this.getInstanceByName(data.name);

    if (existing) {
      throw new Error(`A Memorystore instance named "${data.name}" already exists`);
    }

    return this.storage.create<InstanceRecord>(MEMORYSTORE_INSTANCES_TABLE, data);
  }

  async getInstanceByName(name: string): Promise<InstanceRecord | null> {
    return this.storage.findFirst<InstanceRecord>(MEMORYSTORE_INSTANCES_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }

  async listInstances(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListInstancesResult> {
    const offset = parseOffsetToken(pageToken);
    const limit = pageSize ?? DEFAULT_LIST_PAGE_SIZE;
    const prefix = `projects/${project}/locations/${location}/instances/`;

    const result = await this.storage.find<InstanceRecord>(MEMORYSTORE_INSTANCES_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'like', value: `${prefix}%` }],
      },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    const listResult: ListInstancesResult = { instances: result.data };

    if (result.hasMore) {
      listResult.nextPageToken = String(offset + limit);
    }

    return listResult;
  }

  async updateInstance(
    name: string,
    data: Partial<Omit<InstanceRecord, keyof BaseRecord>>
  ): Promise<InstanceRecord | null> {
    const existing = await this.getInstanceByName(name);

    if (!existing) return null;

    return this.storage.updateById<InstanceRecord>(MEMORYSTORE_INSTANCES_TABLE, existing.id, data);
  }

  async deleteInstance(name: string): Promise<boolean> {
    const existing = await this.getInstanceByName(name);

    if (!existing) return false;

    return this.storage.deleteById(MEMORYSTORE_INSTANCES_TABLE, existing.id);
  }

  /**
   * List every persisted instance across all projects and locations.
   *
   * For future maintainers: this exists for restart rehydration
   * ({@link MemorystoreService.initialize}), which must find every ACTIVE
   * instance regardless of which project it belongs to so it can re-spawn a
   * data-plane process for it. Project-scoped lookups belong in
   * {@link listInstances} instead.
   */
  async listAllInstances(): Promise<InstanceRecord[]> {
    const result = await this.storage.find<InstanceRecord>(MEMORYSTORE_INSTANCES_TABLE, {});

    return result.data;
  }
}
