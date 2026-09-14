/**
 * Persistence for AlloyDB backups. CRUD lives in {@link ResourceRepository}.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import { ResourceRepository } from '@/core/storage/resource-repository.ts';
import type { BackupRecord } from './types.ts';
import { ALLOYDB_BACKUPS_TABLE, backupTableSchema } from './types.ts';

export interface ListBackupsResult {
  backups: BackupRecord[];
  nextPageToken?: string | undefined;
}

export function buildBackupListPrefix(project: string, location: string): string {
  return `projects/${project}/locations/${location}/backups/`;
}

export class BackupRepository extends ResourceRepository<BackupRecord> {
  constructor(storage: StorageManager) {
    super(storage, ALLOYDB_BACKUPS_TABLE, backupTableSchema, 'backup');
  }

  async listBackups(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListBackupsResult> {
    const { records, nextPageToken } = await this.listByPrefix(
      buildBackupListPrefix(project, location),
      pageSize,
      pageToken
    );

    return { backups: records, nextPageToken };
  }
}
