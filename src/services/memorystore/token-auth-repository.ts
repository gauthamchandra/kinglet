/**
 * Token Auth Repository - persistence layer for Memorystore token auth users and auth tokens
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { parseOffsetToken } from '@/shared/utils/pagination.ts';
import type { AuthTokenRecord, TokenAuthUserRecord } from './types.ts';
import {
  authTokenTableSchema,
  MEMORYSTORE_AUTH_TOKENS_TABLE,
  MEMORYSTORE_TOKEN_AUTH_USERS_TABLE,
  tokenAuthUserTableSchema,
} from './types.ts';

export interface ListTokenAuthUsersResult {
  tokenAuthUsers: TokenAuthUserRecord[];
  nextPageToken?: string;
}

export interface ListAuthTokensResult {
  authTokens: AuthTokenRecord[];
  nextPageToken?: string;
}

export class TokenAuthRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    const existingTables = await this.storage.listTables();

    if (!existingTables.includes(MEMORYSTORE_TOKEN_AUTH_USERS_TABLE)) {
      await this.storage.createTable(MEMORYSTORE_TOKEN_AUTH_USERS_TABLE, tokenAuthUserTableSchema);
    }

    if (!existingTables.includes(MEMORYSTORE_AUTH_TOKENS_TABLE)) {
      await this.storage.createTable(MEMORYSTORE_AUTH_TOKENS_TABLE, authTokenTableSchema);
    }
  }

  async createTokenAuthUser(
    data: Omit<TokenAuthUserRecord, keyof BaseRecord>
  ): Promise<TokenAuthUserRecord> {
    const existing = await this.getTokenAuthUserByName(data.name);

    if (existing) {
      throw new Error(`A token auth user named "${data.name}" already exists`);
    }

    return this.storage.create<TokenAuthUserRecord>(MEMORYSTORE_TOKEN_AUTH_USERS_TABLE, data);
  }

  async getTokenAuthUserByName(name: string): Promise<TokenAuthUserRecord | null> {
    return this.storage.findFirst<TokenAuthUserRecord>(MEMORYSTORE_TOKEN_AUTH_USERS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }

  async listTokenAuthUsers(
    instance: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListTokenAuthUsersResult> {
    const offset = parseOffsetToken(pageToken);
    const limit = pageSize ?? 100;

    const result = await this.storage.find<TokenAuthUserRecord>(
      MEMORYSTORE_TOKEN_AUTH_USERS_TABLE,
      {
        filter: {
          conditions: [{ field: 'instance', operator: 'eq', value: instance }],
        },
        pagination: { limit, offset },
        sort: [{ field: 'name', direction: 'asc' }],
      }
    );

    const listResult: ListTokenAuthUsersResult = { tokenAuthUsers: result.data };

    if (result.hasMore) {
      listResult.nextPageToken = String(offset + limit);
    }

    return listResult;
  }

  async deleteTokenAuthUser(name: string): Promise<boolean> {
    const existing = await this.getTokenAuthUserByName(name);

    if (!existing) return false;

    return this.storage.deleteById(MEMORYSTORE_TOKEN_AUTH_USERS_TABLE, existing.id);
  }

  async countAuthTokensForUser(tokenAuthUser: string): Promise<number> {
    return this.storage.count(MEMORYSTORE_AUTH_TOKENS_TABLE, {
      conditions: [{ field: 'tokenAuthUser', operator: 'eq', value: tokenAuthUser }],
    });
  }

  async deleteAuthTokensForUser(tokenAuthUser: string): Promise<number> {
    return this.storage.deleteMany(MEMORYSTORE_AUTH_TOKENS_TABLE, {
      conditions: [{ field: 'tokenAuthUser', operator: 'eq', value: tokenAuthUser }],
    });
  }

  async deleteTokenAuthUsersForInstance(instance: string): Promise<TokenAuthUserRecord[]> {
    const result = await this.storage.find<TokenAuthUserRecord>(
      MEMORYSTORE_TOKEN_AUTH_USERS_TABLE,
      {
        filter: { conditions: [{ field: 'instance', operator: 'eq', value: instance }] },
      }
    );

    for (const user of result.data) {
      await this.deleteAuthTokensForUser(user.name);
      await this.storage.deleteById(MEMORYSTORE_TOKEN_AUTH_USERS_TABLE, user.id);
    }

    return result.data;
  }

  async createAuthToken(data: Omit<AuthTokenRecord, keyof BaseRecord>): Promise<AuthTokenRecord> {
    const existing = await this.getAuthTokenByName(data.name);

    if (existing) {
      throw new Error(`An auth token named "${data.name}" already exists`);
    }

    return this.storage.create<AuthTokenRecord>(MEMORYSTORE_AUTH_TOKENS_TABLE, data);
  }

  async getAuthTokenByName(name: string): Promise<AuthTokenRecord | null> {
    return this.storage.findFirst<AuthTokenRecord>(MEMORYSTORE_AUTH_TOKENS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }

  async listAuthTokens(
    tokenAuthUser: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListAuthTokensResult> {
    const offset = parseOffsetToken(pageToken);
    const limit = pageSize ?? 100;

    const result = await this.storage.find<AuthTokenRecord>(MEMORYSTORE_AUTH_TOKENS_TABLE, {
      filter: {
        conditions: [{ field: 'tokenAuthUser', operator: 'eq', value: tokenAuthUser }],
      },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    const listResult: ListAuthTokensResult = { authTokens: result.data };

    if (result.hasMore) {
      listResult.nextPageToken = String(offset + limit);
    }

    return listResult;
  }

  async deleteAuthToken(name: string): Promise<boolean> {
    const existing = await this.getAuthTokenByName(name);

    if (!existing) return false;

    return this.storage.deleteById(MEMORYSTORE_AUTH_TOKENS_TABLE, existing.id);
  }
}
