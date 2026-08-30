/**
 * Persistence for AlloyDB clusters. CRUD lives in {@link ResourceRepository}.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import { ResourceRepository } from '@/core/storage/resource-repository.ts';
import type { ClusterRecord } from './types.ts';
import { ALLOYDB_CLUSTERS_TABLE, clusterTableSchema } from './types.ts';

export interface ListClustersResult {
  clusters: ClusterRecord[];
  nextPageToken?: string | undefined;
}

export function buildClusterListPrefix(project: string, location: string): string {
  return `projects/${project}/locations/${location}/clusters/`;
}

export class ClusterRepository extends ResourceRepository<ClusterRecord> {
  constructor(storage: StorageManager) {
    super(storage, ALLOYDB_CLUSTERS_TABLE, clusterTableSchema, 'cluster');
  }

  async listClusters(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListClustersResult> {
    const { records, nextPageToken } = await this.listByPrefix(
      buildClusterListPrefix(project, location),
      pageSize,
      pageToken
    );

    return { clusters: records, nextPageToken };
  }
}
