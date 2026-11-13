/**
 * Persistence for Secret Manager. Equality lookups only. No LIKE.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { TableSchema } from '@/core/storage/types.ts';
import type { SecretSpec, SecretVersionState } from './types.ts';
import { SECRETS_TABLE, VERSIONS_TABLE } from './types.ts';

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

const versionsTableSchema: TableSchema = {
  name: VERSIONS_TABLE,
  columns: [
    { name: 'secretName', type: 'string' },
    { name: 'number', type: 'number' },
    { name: 'state', type: 'string' },
    { name: 'createTime', type: 'string' },
    { name: 'destroyTime', type: 'string', nullable: true },
    { name: 'generation', type: 'number' },
    { name: 'payloadData', type: 'string', nullable: true },
    { name: 'payloadCrc32c', type: 'string', nullable: true },
    { name: 'clientSpecifiedPayloadChecksum', type: 'number' },
  ],
  indexes: [
    {
      name: 'idx_secretmanager_versions_secret_number',
      columns: ['secretName', 'number'],
      unique: true,
    },
    { name: 'idx_secretmanager_versions_secret', columns: ['secretName'] },
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
    await this.storage.createTable(VERSIONS_TABLE, versionsTableSchema);
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

  async insertVersion(version: StoredVersion): Promise<StoredVersion> {
    const created = await this.storage.create<VersionRow>(VERSIONS_TABLE, {
      secretName: version.secretName,
      number: version.number,
      state: version.state,
      createTime: version.createTime,
      destroyTime: version.destroyTime,
      generation: version.generation,
      payloadData: version.payloadData,
      payloadCrc32c: version.payloadCrc32c,
      clientSpecifiedPayloadChecksum: version.clientSpecifiedPayloadChecksum ? 1 : 0,
    });

    return toVersion(created);
  }

  async findVersion(secretName: string, number: number): Promise<StoredVersion | null> {
    const row = await this.storage.findFirst<VersionRow>(VERSIONS_TABLE, {
      filter: {
        conditions: [
          { field: 'secretName', operator: 'eq', value: secretName },
          { field: 'number', operator: 'eq', value: number },
        ],
      },
    });

    return row == null ? null : toVersion(row);
  }

  async findNewestVersion(secretName: string): Promise<StoredVersion | null> {
    const page = await this.listVersions(secretName, 1, 0);

    return page.versions[0] ?? null;
  }

  async listVersions(
    secretName: string,
    limit: number,
    offset: number
  ): Promise<{ versions: StoredVersion[]; total: number }> {
    const result = await this.storage.find<VersionRow>(VERSIONS_TABLE, {
      filter: { conditions: [{ field: 'secretName', operator: 'eq', value: secretName }] },
      sort: [{ field: 'number', direction: 'desc' }],
      pagination: { limit, offset },
    });

    return { versions: result.data.map(toVersion), total: result.total };
  }

  async updateVersion(secretName: string, number: number, patch: VersionPatch): Promise<void> {
    await this.storage.updateMany<VersionRow>(
      VERSIONS_TABLE,
      {
        conditions: [
          { field: 'secretName', operator: 'eq', value: secretName },
          { field: 'number', operator: 'eq', value: number },
        ],
      },
      patch
    );
  }
}

type VersionPatch = Pick<StoredVersion, 'state' | 'generation'> &
  Partial<Pick<StoredVersion, 'destroyTime' | 'payloadData' | 'payloadCrc32c'>>;

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

export interface StoredVersion {
  readonly secretName: string;
  readonly number: number;
  readonly state: SecretVersionState;
  readonly createTime: string;
  readonly destroyTime: string | null;
  readonly generation: number;
  readonly payloadData: string | null;
  readonly payloadCrc32c: string | null;
  readonly clientSpecifiedPayloadChecksum: boolean;
}

interface VersionRow {
  readonly id: string;
  readonly secretName: string;
  readonly number: number;
  readonly state: StoredVersion['state'];
  readonly createTime: string;
  readonly destroyTime: string | null;
  readonly generation: number;
  readonly payloadData: string | null;
  readonly payloadCrc32c: string | null;
  readonly clientSpecifiedPayloadChecksum: number | boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toVersion(row: VersionRow): StoredVersion {
  return {
    secretName: row.secretName,
    number: Number(row.number),
    state: row.state,
    createTime: row.createTime,
    destroyTime: row.destroyTime,
    generation: Number(row.generation),
    payloadData: row.payloadData,
    payloadCrc32c: row.payloadCrc32c,
    clientSpecifiedPayloadChecksum:
      row.clientSpecifiedPayloadChecksum === true || row.clientSpecifiedPayloadChecksum === 1,
  };
}
