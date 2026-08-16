/**
 * Backup Repository - persistence layer for Memorystore backup collections and backups
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { parseOffsetToken } from '@/shared/utils/pagination.ts';
import type { BackupCollectionRecord, BackupRecord } from './types.ts';
import {
  backupCollectionTableSchema,
  backupTableSchema,
  MEMORYSTORE_BACKUP_COLLECTIONS_TABLE,
  MEMORYSTORE_BACKUPS_TABLE,
} from './types.ts';

export interface ListBackupCollectionsResult {
  backupCollections: BackupCollectionRecord[];
  nextPageToken?: string;
}

export interface ListBackupsResult {
  backups: BackupRecord[];
  nextPageToken?: string;
}

export class BackupRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    const existingTables = await this.storage.listTables();

    if (!existingTables.includes(MEMORYSTORE_BACKUP_COLLECTIONS_TABLE)) {
      await this.storage.createTable(
        MEMORYSTORE_BACKUP_COLLECTIONS_TABLE,
        backupCollectionTableSchema
      );
    }

    if (!existingTables.includes(MEMORYSTORE_BACKUPS_TABLE)) {
      await this.storage.createTable(MEMORYSTORE_BACKUPS_TABLE, backupTableSchema);
    }
  }

  /**
   * Materialise the instance's backup collection unless it is already there.
   *
   * <p>Returns whether this call is what created it. A caller rolling back a
   * failed create needs that to tell its own collection — which it must clean
   * up, since the abandoned `instanceUid` would otherwise be inherited by the
   * retry — from one that predates the create and belongs to whoever made it.
   */
  async createBackupCollectionIfMissing(
    name: string,
    instance: string,
    instanceUid: string
  ): Promise<boolean> {
    const existing = await this.getBackupCollectionByName(name);

    if (existing) return false;

    const data: Omit<BackupCollectionRecord, keyof BaseRecord> = {
      name,
      uid: crypto.randomUUID(),
      instance,
      instanceUid,
      kmsKey: null,
      totalBackupCount: 0,
      totalBackupSizeBytes: '0',
      lastBackupTime: null,
    };

    await this.storage.create<BackupCollectionRecord>(MEMORYSTORE_BACKUP_COLLECTIONS_TABLE, data);

    return true;
  }

  async deleteBackupCollection(name: string): Promise<boolean> {
    const existing = await this.getBackupCollectionByName(name);

    if (!existing) return false;

    return this.storage.deleteById(MEMORYSTORE_BACKUP_COLLECTIONS_TABLE, existing.id);
  }

  async getBackupCollectionByName(name: string): Promise<BackupCollectionRecord | null> {
    return this.storage.findFirst<BackupCollectionRecord>(MEMORYSTORE_BACKUP_COLLECTIONS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }

  async listBackupCollections(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListBackupCollectionsResult> {
    const offset = parseOffsetToken(pageToken);
    const limit = pageSize ?? 100;
    const prefix = `projects/${project}/locations/${location}/backupCollections/`;

    const result = await this.storage.find<BackupCollectionRecord>(
      MEMORYSTORE_BACKUP_COLLECTIONS_TABLE,
      {
        filter: {
          conditions: [{ field: 'name', operator: 'like', value: `${prefix}%` }],
        },
        pagination: { limit, offset },
        sort: [{ field: 'name', direction: 'asc' }],
      }
    );

    const listResult: ListBackupCollectionsResult = { backupCollections: result.data };

    if (result.hasMore) {
      listResult.nextPageToken = String(offset + limit);
    }

    return listResult;
  }

  async createBackup(data: Omit<BackupRecord, keyof BaseRecord>): Promise<BackupRecord> {
    const existing = await this.getBackupByName(data.name);

    if (existing) {
      throw new Error(`A backup named "${data.name}" already exists`);
    }

    return this.storage.create<BackupRecord>(MEMORYSTORE_BACKUPS_TABLE, data);
  }

  async getBackupByName(name: string): Promise<BackupRecord | null> {
    return this.storage.findFirst<BackupRecord>(MEMORYSTORE_BACKUPS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }

  async listBackups(
    backupCollectionName: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListBackupsResult> {
    const offset = parseOffsetToken(pageToken);
    const limit = pageSize ?? 100;

    const result = await this.storage.find<BackupRecord>(MEMORYSTORE_BACKUPS_TABLE, {
      filter: {
        conditions: [{ field: 'backupCollection', operator: 'eq', value: backupCollectionName }],
      },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    const listResult: ListBackupsResult = { backups: result.data };

    if (result.hasMore) {
      listResult.nextPageToken = String(offset + limit);
    }

    return listResult;
  }

  async deleteBackup(name: string): Promise<boolean> {
    const existing = await this.getBackupByName(name);

    if (!existing) return false;

    return this.storage.deleteById(MEMORYSTORE_BACKUPS_TABLE, existing.id);
  }
}
