/**
 * Persistence for Secret Manager. Equality lookups only. No LIKE.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { TableSchema } from '@/core/storage/types.ts';
import type { SecretSpec } from './types.ts';
import { SECRETS_TABLE } from './types.ts';

export interface StoredSecret {
  readonly name: string;
  readonly parent: string;
  readonly generation: number;
  readonly createTime: string;
  readonly spec: SecretSpec;
}

interface SecretRow {
  readonly id: string;
  readonly name: string;
  readonly parent: string;
  readonly generation: number;
  readonly createTime: string;
  readonly spec: SecretSpec | string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const secretsTableSchema: TableSchema = {
  name: SECRETS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'parent', type: 'string' },
    { name: 'generation', type: 'number' },
    { name: 'createTime', type: 'string' },
    { name: 'spec', type: 'json' },
  ],
  indexes: [
    { name: 'idx_secretmanager_secrets_name', columns: ['name'], unique: true },
    { name: 'idx_secretmanager_secrets_parent', columns: ['parent'] },
  ],
  timestamps: true,
};

export class SecretRepository {
  private readonly storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(SECRETS_TABLE, secretsTableSchema);
  }

  async getByName(name: string): Promise<StoredSecret | null> {
    const row = await this.storage.findFirst<SecretRow>(SECRETS_TABLE, {
      filter: { conditions: [{ field: 'name', operator: 'eq', value: name }] },
    });

    return row == null ? null : toStored(row);
  }

  async insert(secret: StoredSecret): Promise<StoredSecret> {
    const existing = await this.getByName(secret.name);

    if (existing) {
      throw new Error(`Secret ${secret.name} already exists`);
    }

    const created = await this.storage.create<SecretRow>(SECRETS_TABLE, {
      name: secret.name,
      parent: secret.parent,
      generation: secret.generation,
      createTime: secret.createTime,
      spec: secret.spec,
    });

    return toStored(created);
  }
}

function toStored(row: SecretRow): StoredSecret {
  return {
    name: row.name,
    parent: row.parent,
    generation: Number(row.generation),
    createTime: row.createTime,
    spec: readSpec(row.spec),
  };
}

function readSpec(spec: SecretSpec | string): SecretSpec {
  if (typeof spec === 'string') {
    return JSON.parse(spec) as SecretSpec;
  }

  return spec;
}
