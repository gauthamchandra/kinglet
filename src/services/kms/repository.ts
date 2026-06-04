/**
 * KMS persistence layer — thin wrappers over StorageManager for key rings,
 * crypto keys, and crypto key versions.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import type { CryptoKeyRecord, CryptoKeyVersionRecord, KeyRingRecord } from './types.ts';
import {
  KMS_CRYPTO_KEY_VERSIONS_TABLE,
  KMS_CRYPTO_KEYS_TABLE,
  KMS_KEY_RINGS_TABLE,
  kmsCryptoKeysTableSchema,
  kmsCryptoKeyVersionsTableSchema,
  kmsKeyRingsTableSchema,
} from './types.ts';

interface PagedResult<T> {
  items: T[];
  nextPageToken?: string | undefined;
}

function pageBounds(pageSize?: number, pageToken?: string): { offset: number; limit: number } {
  const offset = pageToken ? parseInt(pageToken, 10) : 0;
  const limit = pageSize != null && pageSize > 0 ? pageSize : 100;

  return { offset: Number.isNaN(offset) ? 0 : offset, limit };
}

export class KeyRingRepository {
  constructor(private storage: StorageManager) {}

  async initialize(): Promise<void> {
    await this.storage.createTable(KMS_KEY_RINGS_TABLE, kmsKeyRingsTableSchema);
  }

  async createKeyRing(data: Omit<KeyRingRecord, keyof BaseRecord>): Promise<KeyRingRecord> {
    const existing = await this.getKeyRingByName(data.name);

    if (existing) {
      throw new Error(`KeyRing ${data.name} already exists`);
    }

    return this.storage.create<KeyRingRecord>(KMS_KEY_RINGS_TABLE, data);
  }

  async getKeyRingByName(name: string): Promise<KeyRingRecord | null> {
    return this.storage.findFirst<KeyRingRecord>(KMS_KEY_RINGS_TABLE, {
      filter: { conditions: [{ field: 'name', operator: 'eq', value: name }] },
    });
  }

  async listKeyRings(
    parentPrefix: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<PagedResult<KeyRingRecord>> {
    const { offset, limit } = pageBounds(pageSize, pageToken);

    const result = await this.storage.find<KeyRingRecord>(KMS_KEY_RINGS_TABLE, {
      filter: { conditions: [{ field: 'name', operator: 'like', value: `${parentPrefix}%` }] },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    return {
      items: result.data,
      nextPageToken: result.hasMore ? String(offset + limit) : undefined,
    };
  }
}

export class CryptoKeyRepository {
  constructor(private storage: StorageManager) {}

  async initialize(): Promise<void> {
    await this.storage.createTable(KMS_CRYPTO_KEYS_TABLE, kmsCryptoKeysTableSchema);
  }

  async createCryptoKey(data: Omit<CryptoKeyRecord, keyof BaseRecord>): Promise<CryptoKeyRecord> {
    const existing = await this.getCryptoKeyByName(data.name);

    if (existing) {
      throw new Error(`CryptoKey ${data.name} already exists`);
    }

    return this.storage.create<CryptoKeyRecord>(KMS_CRYPTO_KEYS_TABLE, data);
  }

  async getCryptoKeyByName(name: string): Promise<CryptoKeyRecord | null> {
    return this.storage.findFirst<CryptoKeyRecord>(KMS_CRYPTO_KEYS_TABLE, {
      filter: { conditions: [{ field: 'name', operator: 'eq', value: name }] },
    });
  }

  async listCryptoKeys(
    keyRingName: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<PagedResult<CryptoKeyRecord>> {
    const { offset, limit } = pageBounds(pageSize, pageToken);
    const prefix = `${keyRingName}/cryptoKeys/`;

    const result = await this.storage.find<CryptoKeyRecord>(KMS_CRYPTO_KEYS_TABLE, {
      filter: { conditions: [{ field: 'name', operator: 'like', value: `${prefix}%` }] },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    return {
      items: result.data,
      nextPageToken: result.hasMore ? String(offset + limit) : undefined,
    };
  }

  async updateCryptoKey(
    name: string,
    data: Partial<Omit<CryptoKeyRecord, keyof BaseRecord>>
  ): Promise<CryptoKeyRecord | null> {
    const existing = await this.getCryptoKeyByName(name);

    if (!existing) {
      return null;
    }

    return this.storage.updateById<CryptoKeyRecord>(KMS_CRYPTO_KEYS_TABLE, existing.id, data);
  }
}

export class CryptoKeyVersionRepository {
  constructor(private storage: StorageManager) {}

  async initialize(): Promise<void> {
    await this.storage.createTable(KMS_CRYPTO_KEY_VERSIONS_TABLE, kmsCryptoKeyVersionsTableSchema);
  }

  async createVersion(
    data: Omit<CryptoKeyVersionRecord, keyof BaseRecord>
  ): Promise<CryptoKeyVersionRecord> {
    const existing = await this.getVersionByName(data.name);

    if (existing) {
      throw new Error(`CryptoKeyVersion ${data.name} already exists`);
    }

    return this.storage.create<CryptoKeyVersionRecord>(KMS_CRYPTO_KEY_VERSIONS_TABLE, data);
  }

  async getVersionByName(name: string): Promise<CryptoKeyVersionRecord | null> {
    return this.storage.findFirst<CryptoKeyVersionRecord>(KMS_CRYPTO_KEY_VERSIONS_TABLE, {
      filter: { conditions: [{ field: 'name', operator: 'eq', value: name }] },
    });
  }

  async listVersions(
    cryptoKeyName: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<PagedResult<CryptoKeyVersionRecord>> {
    const { offset, limit } = pageBounds(pageSize, pageToken);
    const prefix = `${cryptoKeyName}/cryptoKeyVersions/`;

    const result = await this.storage.find<CryptoKeyVersionRecord>(KMS_CRYPTO_KEY_VERSIONS_TABLE, {
      filter: { conditions: [{ field: 'name', operator: 'like', value: `${prefix}%` }] },
      pagination: { limit, offset },
      // Sort numerically so version 10 follows 9 (lexicographic 'name' would put 10 before 2).
      sort: [{ field: 'versionNumber', direction: 'asc' }],
    });

    return {
      items: result.data,
      nextPageToken: result.hasMore ? String(offset + limit) : undefined,
    };
  }

  async updateVersion(
    name: string,
    data: Partial<Omit<CryptoKeyVersionRecord, keyof BaseRecord>>
  ): Promise<CryptoKeyVersionRecord | null> {
    const existing = await this.getVersionByName(name);

    if (!existing) {
      return null;
    }

    return this.storage.updateById<CryptoKeyVersionRecord>(
      KMS_CRYPTO_KEY_VERSIONS_TABLE,
      existing.id,
      data
    );
  }
}
