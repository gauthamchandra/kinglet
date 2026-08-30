/**
 * Persistence for Memorystore instances. CRUD lives in {@link ResourceRepository}.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import { ResourceRepository } from '@/core/storage/resource-repository.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import type { InstanceRecord } from './types.ts';
import { instanceTableSchema, MEMORYSTORE_INSTANCES_TABLE } from './types.ts';

export interface ListInstancesResult {
  instances: InstanceRecord[];
  nextPageToken?: string | undefined;
}

function buildInstanceListPrefix(project: string, location: string): string {
  return `projects/${project}/locations/${location}/instances/`;
}

export class InstanceRepository extends ResourceRepository<InstanceRecord> {
  constructor(storage: StorageManager) {
    super(storage, MEMORYSTORE_INSTANCES_TABLE, instanceTableSchema, 'Memorystore instance');
  }

  createInstance(data: Omit<InstanceRecord, keyof BaseRecord>): Promise<InstanceRecord> {
    return this.create(data);
  }

  getInstanceByName(name: string): Promise<InstanceRecord | null> {
    return this.getByName(name);
  }

  updateInstance(
    name: string,
    data: Partial<Omit<InstanceRecord, keyof BaseRecord>>
  ): Promise<InstanceRecord | null> {
    return this.update(name, data);
  }

  deleteInstance(name: string): Promise<boolean> {
    return this.delete(name);
  }

  async listInstances(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListInstancesResult> {
    const { records, nextPageToken } = await this.listByPrefix(
      buildInstanceListPrefix(project, location),
      pageSize,
      pageToken
    );

    return { instances: records, nextPageToken };
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
