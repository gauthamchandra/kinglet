/**
 * Persistence for Pub/Sub snapshots. CRUD lives in {@link ResourceRepository}.
 *
 * <p>Uniqueness is enforced in the service layer, so the repository does not
 * reject duplicate names — see {@link ResourceRepositoryOptions.rejectDuplicateNames}.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import { ResourceRepository } from '@/core/storage/resource-repository.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import type { SnapshotRecord } from './types.ts';
import { PUBSUB_SNAPSHOTS_TABLE, pubsubSnapshotsTableSchema } from './types.ts';

export interface ListSnapshotsResult {
  snapshots: SnapshotRecord[];
  nextPageToken?: string | undefined;
}

function buildSnapshotListPrefix(project: string): string {
  return `projects/${project}/snapshots/`;
}

export class SnapshotRepository extends ResourceRepository<SnapshotRecord> {
  constructor(storage: StorageManager) {
    super(storage, PUBSUB_SNAPSHOTS_TABLE, pubsubSnapshotsTableSchema, 'snapshot', {
      rejectDuplicateNames: false,
    });
  }

  createSnapshot(data: Omit<SnapshotRecord, keyof BaseRecord>): Promise<SnapshotRecord> {
    return this.create(data);
  }

  getSnapshotByName(name: string): Promise<SnapshotRecord | null> {
    return this.getByName(name);
  }

  updateSnapshot(
    name: string,
    data: Partial<Omit<SnapshotRecord, keyof BaseRecord>>
  ): Promise<SnapshotRecord | null> {
    return this.update(name, data);
  }

  deleteSnapshot(name: string): Promise<boolean> {
    return this.delete(name);
  }

  async listSnapshots(
    project: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListSnapshotsResult> {
    const { records, nextPageToken } = await this.listByPrefix(
      buildSnapshotListPrefix(project),
      pageSize,
      pageToken
    );

    return { snapshots: records, nextPageToken };
  }

  async listSnapshotsByTopic(topicName: string): Promise<SnapshotRecord[]> {
    const result = await this.storage.find<SnapshotRecord>(PUBSUB_SNAPSHOTS_TABLE, {
      filter: {
        conditions: [{ field: 'topic', operator: 'eq', value: topicName }],
      },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    return result.data;
  }
}
