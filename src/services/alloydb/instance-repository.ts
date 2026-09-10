/**
 * Persistence for AlloyDB instances. CRUD lives in {@link ResourceRepository}.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import { ResourceRepository } from '@/core/storage/resource-repository.ts';
import type { InstanceRecord } from './types.ts';
import { ALLOYDB_INSTANCES_TABLE, buildClusterName, instanceTableSchema } from './types.ts';

export interface ListInstancesResult {
  instances: InstanceRecord[];
  nextPageToken?: string | undefined;
}

export function buildInstanceListPrefix(
  project: string,
  location: string,
  clusterId: string
): string {
  return `${buildClusterName(project, location, clusterId)}/instances/`;
}

export class InstanceRepository extends ResourceRepository<InstanceRecord> {
  constructor(storage: StorageManager) {
    super(storage, ALLOYDB_INSTANCES_TABLE, instanceTableSchema, 'instance');
  }

  async listInstances(
    project: string,
    location: string,
    clusterId: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListInstancesResult> {
    const { records, nextPageToken } = await this.listByPrefix(
      buildInstanceListPrefix(project, location, clusterId),
      pageSize,
      pageToken
    );

    return { instances: records, nextPageToken };
  }

  /**
   * Every instance under one cluster, for cascade deletes and placement checks
   * that must see the full topology rather than a single page.
   */
  async listAllInstancesInCluster(
    project: string,
    location: string,
    clusterId: string
  ): Promise<InstanceRecord[]> {
    return this.listAllByPrefix(buildInstanceListPrefix(project, location, clusterId));
  }

  /**
   * Every instance in every project, for restoring the data plane on startup:
   * the persisted rows are the only record of what was running before the
   * emulator went down, and they are not scoped to one project.
   */
  async listAllInstances(): Promise<InstanceRecord[]> {
    const result = await this.storage.find<InstanceRecord>(ALLOYDB_INSTANCES_TABLE, {
      sort: [{ field: 'name', direction: 'asc' }],
    });

    return result.data;
  }
}
