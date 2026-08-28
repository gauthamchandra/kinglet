/**
 * Object Repository - persistence layer wrapping StorageManager
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord, QueryCondition } from '@/core/storage/types.ts';
import { parseOffsetToken } from '@/shared/utils/pagination.ts';
import type { ObjectRecord } from './types.ts';
import { OBJECTS_TABLE, objectsTableSchema } from './types.ts';

export interface ListObjectsResult {
  objects: ObjectRecord[];
  prefixes: string[];
  nextPageToken?: string | undefined;
}

export class ObjectRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(OBJECTS_TABLE, objectsTableSchema);
  }

  async createObject(data: Omit<ObjectRecord, keyof BaseRecord>): Promise<ObjectRecord> {
    return this.storage.create<ObjectRecord>(OBJECTS_TABLE, data);
  }

  async getObject(bucket: string, name: string, generation?: string): Promise<ObjectRecord | null> {
    const conditions: QueryCondition[] = [
      { field: 'bucket', operator: 'eq', value: bucket },
      { field: 'name', operator: 'eq', value: name },
    ];

    if (generation) {
      conditions.push({ field: 'generation', operator: 'eq', value: generation });
    }

    return this.storage.findFirst<ObjectRecord>(OBJECTS_TABLE, {
      filter: { conditions },
      sort: [{ field: 'generation', direction: 'desc' }],
    });
  }

  async listObjects(
    bucket: string,
    options?: {
      prefix?: string;
      delimiter?: string;
      maxResults?: number;
      pageToken?: string;
    }
  ): Promise<ListObjectsResult> {
    const conditions: QueryCondition[] = [{ field: 'bucket', operator: 'eq', value: bucket }];

    if (options?.prefix) {
      conditions.push({ field: 'name', operator: 'like', value: `${options.prefix}%` });
    }

    if (options?.delimiter) {
      return this.listObjectsWithDelimiter(conditions, {
        ...options,
        delimiter: options.delimiter,
      });
    }

    return this.listObjectsSimple(conditions, options);
  }

  /**
   * List objects without delimiter — uses DB-level pagination directly.
   */
  private async listObjectsSimple(
    conditions: QueryCondition[],
    options?: { maxResults?: number; pageToken?: string }
  ): Promise<ListObjectsResult> {
    const offset = parseOffsetToken(options?.pageToken);
    const limit = options?.maxResults ?? 1000;

    const result = await this.storage.find<ObjectRecord>(OBJECTS_TABLE, {
      filter: { conditions, operator: 'and' },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    const nextPageToken = result.hasMore ? String(offset + limit) : undefined;

    return { objects: result.data, prefixes: [], nextPageToken };
  }

  /**
   * List objects with delimiter — fetches all matching objects and applies
   * delimiter grouping before pagination, so that maxResults applies to the
   * combined count of objects + prefixes (matching real GCS behavior).
   *
   * Tradeoff: we fetch all matching rows from the DB rather than paginating
   * at the DB level. The DB has no concept of delimiter-based grouping, so a
   * LIMIT N query can produce anywhere from 1 to N combined items after
   * filtering — making consistent page sizes impossible without
   * application-level control. For a local emulator with test-scale data
   * this is negligible. If it becomes a bottleneck, a cursor-based approach
   * (fetch in batches, accumulate until maxResults, encode last object name
   * as token) would avoid loading the full result set into memory.
   */
  private async listObjectsWithDelimiter(
    conditions: QueryCondition[],
    options: { prefix?: string; delimiter: string; maxResults?: number; pageToken?: string }
  ): Promise<ListObjectsResult> {
    const result = await this.storage.find<ObjectRecord>(OBJECTS_TABLE, {
      filter: { conditions, operator: 'and' },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    const prefixLen = options.prefix?.length ?? 0;
    const seenPrefixes = new Set<string>();

    type ListItem = { kind: 'object'; record: ObjectRecord } | { kind: 'prefix'; value: string };
    const combined: ListItem[] = [];

    for (const obj of result.data) {
      const rest = obj.name.substring(prefixLen);
      const delimIdx = rest.indexOf(options.delimiter);

      if (delimIdx >= 0) {
        const prefix = obj.name.substring(0, prefixLen + delimIdx + options.delimiter.length);

        if (!seenPrefixes.has(prefix)) {
          seenPrefixes.add(prefix);
          combined.push({ kind: 'prefix', value: prefix });
        }
      } else {
        combined.push({ kind: 'object', record: obj });
      }
    }

    const offset = parseOffsetToken(options.pageToken);
    const limit = options.maxResults ?? 1000;
    const page = combined.slice(offset, offset + limit);

    const objects: ObjectRecord[] = [];
    const prefixes: string[] = [];

    for (const item of page) {
      if (item.kind === 'object') {
        objects.push(item.record);
      } else {
        prefixes.push(item.value);
      }
    }

    const nextPageToken = offset + limit < combined.length ? String(offset + limit) : undefined;

    return { objects, prefixes, nextPageToken };
  }

  async updateObject(
    bucket: string,
    name: string,
    data: Partial<Omit<ObjectRecord, keyof BaseRecord>>
  ): Promise<ObjectRecord | null> {
    const existing = await this.getObject(bucket, name);

    if (!existing) {
      return null;
    }

    return this.storage.updateById<ObjectRecord>(OBJECTS_TABLE, existing.id, data);
  }

  async deleteObject(bucket: string, name: string): Promise<boolean> {
    const existing = await this.getObject(bucket, name);

    if (!existing) {
      return false;
    }

    return this.storage.deleteById(OBJECTS_TABLE, existing.id);
  }

  async deleteObjectsByBucket(bucket: string): Promise<number> {
    return this.storage.deleteMany(OBJECTS_TABLE, {
      conditions: [{ field: 'bucket', operator: 'eq', value: bucket }],
    });
  }

  async countObjectsInBucket(bucket: string): Promise<number> {
    return this.storage.count(OBJECTS_TABLE, {
      conditions: [{ field: 'bucket', operator: 'eq', value: bucket }],
    });
  }
}
