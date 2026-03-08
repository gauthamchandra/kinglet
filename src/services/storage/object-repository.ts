/**
 * Object Repository - persistence layer wrapping StorageManager
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord, QueryCondition } from '@/core/storage/types.ts';
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

    const offset = options?.pageToken ? parseInt(options.pageToken, 10) : 0;
    const limit = options?.maxResults ?? 1000;

    const result = await this.storage.find<ObjectRecord>(OBJECTS_TABLE, {
      filter: { conditions, operator: 'and' },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    let objects = result.data;
    const prefixes: string[] = [];

    if (options?.delimiter) {
      const prefixLen = options.prefix?.length ?? 0;
      const seen = new Set<string>();
      const filtered: ObjectRecord[] = [];

      for (const obj of objects) {
        const rest = obj.name.substring(prefixLen);
        const delimIdx = rest.indexOf(options.delimiter);

        if (delimIdx >= 0) {
          const prefix = obj.name.substring(0, prefixLen + delimIdx + options.delimiter.length);

          if (!seen.has(prefix)) {
            seen.add(prefix);
            prefixes.push(prefix);
          }
        } else {
          filtered.push(obj);
        }
      }

      objects = filtered;
    }

    const nextPageToken = result.hasMore ? String(offset + limit) : undefined;

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
