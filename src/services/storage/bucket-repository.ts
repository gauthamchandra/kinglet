/**
 * Bucket Repository - persistence layer wrapping StorageManager
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { DEFAULT_LIST_PAGE_SIZE, parseOffsetToken } from '@/shared/utils/pagination.ts';
import type { BucketRecord } from './types.ts';
import { BUCKETS_TABLE, bucketsTableSchema, projectNumberFromProjectId } from './types.ts';

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
    // ADR-010 adds the nullable projectId column and then CREATE INDEX IF NOT
    // EXISTS, which leaves an existing idx_storage_buckets_project on
    // projectNumber. Rewrite legacy rows here, then point that index at projectId.
    await this.migrateLegacyProjectNumbers();
    this.retargetProjectIndex();
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
        conditions: [{ field: 'projectId', operator: 'eq', value: project }],
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

  private async migrateLegacyProjectNumbers(): Promise<void> {
    const existing = await this.storage.find<BucketRecord>(BUCKETS_TABLE);

    for (const row of existing.data) {
      if (typeof row.projectNumber !== 'string') {
        continue;
      }

      // An all-digit value is already a uint64, so it is not hashed again.
      // A legacy row still has no projectId. Copy the digits across so
      // buckets.list?project= keeps finding a bucket created with a numeric id.
      if (isDecimalProjectNumber(row.projectNumber)) {
        if (row.projectId == null) {
          await this.storage.updateById<BucketRecord>(BUCKETS_TABLE, row.id, {
            projectId: row.projectNumber,
          });
        }

        continue;
      }

      await this.storage.updateById<BucketRecord>(BUCKETS_TABLE, row.id, {
        projectId: row.projectNumber,
        projectNumber: projectNumberFromProjectId(row.projectNumber),
      });
    }
  }

  private retargetProjectIndex(): void {
    const provider = this.storage.getProvider();
    const projectIndex = bucketsTableSchema.indexes?.find(
      index => index.name === 'idx_storage_buckets_project'
    );

    if (!projectIndex) {
      throw new Error(`Index idx_storage_buckets_project is not declared on ${BUCKETS_TABLE}`);
    }

    provider.retargetIndex(BUCKETS_TABLE, projectIndex.name, projectIndex.columns);
  }
}

function isDecimalProjectNumber(value: string): boolean {
  return /^\d+$/.test(value);
}
