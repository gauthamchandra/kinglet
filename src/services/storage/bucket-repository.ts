/**
 * Bucket Repository - persistence layer wrapping StorageManager
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { DEFAULT_LIST_PAGE_SIZE, parseOffsetToken } from '@/shared/utils/pagination.ts';
import type { BucketRecord } from './types.ts';
import { BUCKETS_TABLE, bucketsTableSchema } from './types.ts';

export interface ListBucketsResult {
  buckets: BucketRecord[];
  nextPageToken?: string | undefined;
}

export class BucketRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(BUCKETS_TABLE, bucketsTableSchema);
  }

  async createBucket(data: Omit<BucketRecord, keyof BaseRecord>): Promise<BucketRecord> {
    const existing = await this.getBucketByName(data.name);

    if (existing) {
      throw new Error(`Bucket ${data.name} already exists`);
    }

    return this.storage.create<BucketRecord>(BUCKETS_TABLE, data);
  }

  async getBucketByName(name: string): Promise<BucketRecord | null> {
    return this.storage.findFirst<BucketRecord>(BUCKETS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }

  async listBuckets(
    project: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListBucketsResult> {
    const offset = parseOffsetToken(pageToken);
    const limit = pageSize ?? DEFAULT_LIST_PAGE_SIZE;

    const result = await this.storage.find<BucketRecord>(BUCKETS_TABLE, {
      filter: {
        conditions: [{ field: 'projectNumber', operator: 'eq', value: project }],
      },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    const nextPageToken = result.hasMore ? String(offset + limit) : undefined;

    return {
      buckets: result.data,
      nextPageToken,
    };
  }

  async updateBucket(
    name: string,
    data: Partial<Omit<BucketRecord, keyof BaseRecord>>
  ): Promise<BucketRecord | null> {
    const existing = await this.getBucketByName(name);

    if (!existing) {
      return null;
    }

    return this.storage.updateById<BucketRecord>(BUCKETS_TABLE, existing.id, data);
  }

  async deleteBucket(name: string): Promise<boolean> {
    const existing = await this.getBucketByName(name);

    if (!existing) {
      return false;
    }

    return this.storage.deleteById(BUCKETS_TABLE, existing.id);
  }
}
