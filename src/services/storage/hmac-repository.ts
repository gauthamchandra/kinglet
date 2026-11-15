/**
 * HMAC key persistence. The secret stays on the row; callers decide
 * whether a response is allowed to include it.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord, QueryCondition } from '@/core/storage/types.ts';
import { parseOffsetToken } from '@/shared/utils/pagination.ts';
import type { HmacKeyRecord } from './types.ts';
import { HMAC_KEYS_TABLE, HmacKeyState, hmacKeysTableSchema } from './types.ts';

export interface ListHmacKeysQuery {
  projectId: string;
  serviceAccountEmail?: string | undefined;
  showDeletedKeys: boolean;
  limit: number;
  pageToken?: string | undefined;
}

export interface ListHmacKeysResult {
  keys: HmacKeyRecord[];
  nextPageToken?: string | undefined;
}

export class HmacKeyRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(HMAC_KEYS_TABLE, hmacKeysTableSchema);
  }

  async create(data: Omit<HmacKeyRecord, keyof BaseRecord>): Promise<HmacKeyRecord> {
    return this.storage.create<HmacKeyRecord>(HMAC_KEYS_TABLE, data);
  }

  async getByAccessId(projectId: string, accessId: string): Promise<HmacKeyRecord | null> {
    return this.storage.findFirst<HmacKeyRecord>(HMAC_KEYS_TABLE, {
      filter: {
        conditions: [
          { field: 'projectId', operator: 'eq', value: projectId },
          { field: 'accessId', operator: 'eq', value: accessId },
        ],
      },
    });
  }

  async list(query: ListHmacKeysQuery): Promise<ListHmacKeysResult> {
    const offset = parseOffsetToken(query.pageToken);
    const conditions: QueryCondition[] = [
      { field: 'projectId', operator: 'eq', value: query.projectId },
    ];

    if (query.serviceAccountEmail) {
      conditions.push({
        field: 'serviceAccountEmail',
        operator: 'eq',
        value: query.serviceAccountEmail,
      });
    }

    if (!query.showDeletedKeys) {
      conditions.push({ field: 'state', operator: 'ne', value: HmacKeyState.DELETED });
    }

    const result = await this.storage.find<HmacKeyRecord>(HMAC_KEYS_TABLE, {
      filter: { conditions },
      pagination: { limit: query.limit, offset },
      sort: [{ field: 'accessId', direction: 'asc' }],
    });

    const nextPageToken = result.hasMore ? String(offset + query.limit) : undefined;

    return {
      keys: result.data,
      nextPageToken,
    };
  }

  async countNonDeleted(projectId: string, serviceAccountEmail: string): Promise<number> {
    return this.storage.count(HMAC_KEYS_TABLE, {
      conditions: [
        { field: 'projectId', operator: 'eq', value: projectId },
        { field: 'serviceAccountEmail', operator: 'eq', value: serviceAccountEmail },
        { field: 'state', operator: 'ne', value: HmacKeyState.DELETED },
      ],
    });
  }

  async update(
    id: string,
    data: Partial<Omit<HmacKeyRecord, keyof BaseRecord>>
  ): Promise<HmacKeyRecord | null> {
    return this.storage.updateById<HmacKeyRecord>(HMAC_KEYS_TABLE, id, data);
  }
}
