/**
 * Schema Repository - persistence layer for Pub/Sub schemas
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { DEFAULT_LIST_PAGE_SIZE, parseOffsetToken } from '@/shared/utils/pagination.ts';
import type { SchemaRecord } from './types.ts';
import { PUBSUB_SCHEMAS_TABLE, pubsubSchemasTableSchema } from './types.ts';

export interface ListSchemasResult {
  schemas: SchemaRecord[];
  nextPageToken?: string;
}

export class SchemaRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(PUBSUB_SCHEMAS_TABLE, pubsubSchemasTableSchema);
  }

  async createSchema(data: Omit<SchemaRecord, keyof BaseRecord>): Promise<SchemaRecord> {
    return this.storage.create<SchemaRecord>(PUBSUB_SCHEMAS_TABLE, data);
  }

  async getSchemaByName(name: string): Promise<SchemaRecord | null> {
    return this.storage.findFirst<SchemaRecord>(PUBSUB_SCHEMAS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }

  async listSchemas(
    project: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListSchemasResult> {
    const offset = parseOffsetToken(pageToken);
    const limit = pageSize ?? DEFAULT_LIST_PAGE_SIZE;

    const result = await this.storage.find<SchemaRecord>(PUBSUB_SCHEMAS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'like', value: `projects/${project}/schemas/%` }],
      },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    const listResult: ListSchemasResult = {
      schemas: result.data,
    };

    if (result.hasMore) {
      listResult.nextPageToken = String(offset + limit);
    }

    return listResult;
  }

  async updateSchema(
    name: string,
    data: Partial<Omit<SchemaRecord, keyof BaseRecord>>
  ): Promise<SchemaRecord | null> {
    const existing = await this.getSchemaByName(name);

    if (!existing) {
      return null;
    }

    return this.storage.updateById<SchemaRecord>(PUBSUB_SCHEMAS_TABLE, existing.id, data);
  }

  async deleteSchema(name: string): Promise<boolean> {
    const existing = await this.getSchemaByName(name);

    if (!existing) {
      return false;
    }

    return this.storage.deleteById(PUBSUB_SCHEMAS_TABLE, existing.id);
  }

  async deleteSchemasByProject(project: string): Promise<number> {
    const result = await this.storage.find<SchemaRecord>(PUBSUB_SCHEMAS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'like', value: `projects/${project}/schemas/%` }],
      },
    });

    let deletedCount = 0;

    for (const schema of result.data) {
      const deleted = await this.storage.deleteById(PUBSUB_SCHEMAS_TABLE, schema.id);

      if (deleted) {
        deletedCount++;
      }
    }

    return deletedCount;
  }
}
