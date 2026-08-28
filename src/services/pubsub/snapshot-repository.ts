/**
 * Snapshot Repository - persistence layer for Pub/Sub snapshots
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { DEFAULT_LIST_PAGE_SIZE, parseOffsetToken } from '@/shared/utils/pagination.ts';
import type { SnapshotRecord } from './types.ts';
import { PUBSUB_SNAPSHOTS_TABLE, pubsubSnapshotsTableSchema } from './types.ts';

export interface ListSnapshotsResult {
  snapshots: SnapshotRecord[];
  nextPageToken?: string;
}

export class SnapshotRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(PUBSUB_SNAPSHOTS_TABLE, pubsubSnapshotsTableSchema);
  }

  async createSnapshot(data: Omit<SnapshotRecord, keyof BaseRecord>): Promise<SnapshotRecord> {
    return this.storage.create<SnapshotRecord>(PUBSUB_SNAPSHOTS_TABLE, data);
  }

  async getSnapshotByName(name: string): Promise<SnapshotRecord | null> {
    return this.storage.findFirst<SnapshotRecord>(PUBSUB_SNAPSHOTS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }

  async listSnapshots(
    project: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListSnapshotsResult> {
    const offset = parseOffsetToken(pageToken);
    const limit = pageSize ?? DEFAULT_LIST_PAGE_SIZE;

    const result = await this.storage.find<SnapshotRecord>(PUBSUB_SNAPSHOTS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'like', value: `projects/${project}/snapshots/%` }],
      },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    const listResult: ListSnapshotsResult = {
      snapshots: result.data,
    };

    if (result.hasMore) {
      listResult.nextPageToken = String(offset + limit);
    }

    return listResult;
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

  async updateSnapshot(
    name: string,
    data: Partial<Omit<SnapshotRecord, keyof BaseRecord>>
  ): Promise<SnapshotRecord | null> {
    const existing = await this.getSnapshotByName(name);

    if (!existing) {
      return null;
    }

    return this.storage.updateById<SnapshotRecord>(PUBSUB_SNAPSHOTS_TABLE, existing.id, data);
  }

  async deleteSnapshot(name: string): Promise<boolean> {
    const existing = await this.getSnapshotByName(name);

    if (!existing) {
      return false;
    }

    return this.storage.deleteById(PUBSUB_SNAPSHOTS_TABLE, existing.id);
  }
}
