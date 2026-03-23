/**
 * Secret Repository - persistence layer wrapping StorageManager
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import type { SecretRecord, SecretVersionRecord } from './types.ts';
import {
  SECRET_VERSIONS_TABLE,
  SECRETS_TABLE,
  SecretVersionState,
  secretsTableSchema,
  secretVersionsTableSchema,
} from './types.ts';

export interface ListSecretsResult {
  secrets: SecretRecord[];
  nextPageToken?: string | undefined;
  totalCount: number;
}

export interface ListSecretVersionsResult {
  versions: SecretVersionRecord[];
  nextPageToken?: string | undefined;
  totalCount: number;
}

export class SecretRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(SECRETS_TABLE, secretsTableSchema);
    await this.storage.createTable(SECRET_VERSIONS_TABLE, secretVersionsTableSchema);
  }

  // ── Secret CRUD ──

  async createSecret(data: Omit<SecretRecord, keyof BaseRecord>): Promise<SecretRecord> {
    const existing = await this.getSecretByName(data.name);

    if (existing) {
      throw new Error(`Secret ${data.name} already exists`);
    }

    return this.storage.create<SecretRecord>(SECRETS_TABLE, data);
  }

  async getSecretByName(name: string): Promise<SecretRecord | null> {
    return this.storage.findFirst<SecretRecord>(SECRETS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }

  async listSecrets(
    project: string,
    location?: string | null,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListSecretsResult> {
    const prefix = location
      ? `projects/${project}/locations/${location}/secrets/`
      : `projects/${project}/secrets/`;

    const offset = pageToken ? parseInt(pageToken, 10) : 0;
    const limit = pageSize ?? 100;

    const result = await this.storage.find<SecretRecord>(SECRETS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'like', value: `${prefix}%` }],
      },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    const nextPageToken = result.hasMore ? String(offset + limit) : undefined;

    return {
      secrets: result.data,
      nextPageToken,
      totalCount: result.total,
    };
  }

  async updateSecret(
    name: string,
    data: Partial<Omit<SecretRecord, keyof BaseRecord>>
  ): Promise<SecretRecord | null> {
    const existing = await this.getSecretByName(name);

    if (!existing) {
      return null;
    }

    return this.storage.updateById<SecretRecord>(SECRETS_TABLE, existing.id, data);
  }

  async deleteSecret(name: string): Promise<boolean> {
    const existing = await this.getSecretByName(name);

    if (!existing) {
      return false;
    }

    return this.storage.deleteById(SECRETS_TABLE, existing.id);
  }

  async incrementVersionNumber(name: string): Promise<number> {
    const existing = await this.getSecretByName(name);

    if (!existing) {
      throw new Error(`Secret ${name} not found`);
    }

    const nextVersion = existing.nextVersionNumber;

    await this.storage.updateById<SecretRecord>(SECRETS_TABLE, existing.id, {
      nextVersionNumber: nextVersion + 1,
    });

    return nextVersion;
  }

  // ── Version CRUD ──

  async createSecretVersion(
    data: Omit<SecretVersionRecord, keyof BaseRecord>
  ): Promise<SecretVersionRecord> {
    return this.storage.create<SecretVersionRecord>(SECRET_VERSIONS_TABLE, data);
  }

  async getSecretVersionByName(name: string): Promise<SecretVersionRecord | null> {
    return this.storage.findFirst<SecretVersionRecord>(SECRET_VERSIONS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }

  async getLatestEnabledVersion(secretName: string): Promise<SecretVersionRecord | null> {
    const result = await this.storage.find<SecretVersionRecord>(SECRET_VERSIONS_TABLE, {
      filter: {
        conditions: [
          { field: 'secretName', operator: 'eq', value: secretName },
          { field: 'state', operator: 'eq', value: SecretVersionState.ENABLED },
        ],
        operator: 'and',
      },
      sort: [{ field: 'versionNumber', direction: 'desc' }],
      pagination: { limit: 1 },
    });

    return result.data[0] ?? null;
  }

  async listSecretVersions(
    secretName: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListSecretVersionsResult> {
    const offset = pageToken ? parseInt(pageToken, 10) : 0;
    const limit = pageSize ?? 100;

    const result = await this.storage.find<SecretVersionRecord>(SECRET_VERSIONS_TABLE, {
      filter: {
        conditions: [{ field: 'secretName', operator: 'eq', value: secretName }],
      },
      pagination: { limit, offset },
      sort: [{ field: 'versionNumber', direction: 'asc' }],
    });

    const nextPageToken = result.hasMore ? String(offset + limit) : undefined;

    return {
      versions: result.data,
      nextPageToken,
      totalCount: result.total,
    };
  }

  async updateSecretVersion(
    name: string,
    data: Partial<Omit<SecretVersionRecord, keyof BaseRecord>>
  ): Promise<SecretVersionRecord | null> {
    const existing = await this.getSecretVersionByName(name);

    if (!existing) {
      return null;
    }

    return this.storage.updateById<SecretVersionRecord>(SECRET_VERSIONS_TABLE, existing.id, data);
  }

  async deleteSecretVersionsBySecretName(secretName: string): Promise<number> {
    return this.storage.deleteMany(SECRET_VERSIONS_TABLE, {
      conditions: [{ field: 'secretName', operator: 'eq', value: secretName }],
    });
  }
}
