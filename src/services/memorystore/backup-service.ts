/**
 * Backup Service - business logic for Memorystore backup collections and backups
 */

import type { BackupRepository } from './backup-repository.ts';
import type { OperationsStore } from './operations.ts';
import {
  type BackupCollectionResponse,
  type BackupResponse,
  backupCollectionRecordToResponse,
  backupRecordToResponse,
  MemoryStoreError,
  type OperationResponse,
  parseBackupName,
} from './types.ts';

export interface ListBackupCollectionsResponse {
  backupCollections: BackupCollectionResponse[];
  nextPageToken?: string;
}

export interface ListBackupsResponse {
  backups: BackupResponse[];
  nextPageToken?: string;
}

export class BackupService {
  private repo: BackupRepository;
  private operationsStore: OperationsStore;

  constructor(repo: BackupRepository, operationsStore: OperationsStore) {
    this.repo = repo;
    this.operationsStore = operationsStore;
  }

  async listBackupCollections(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListBackupCollectionsResponse> {
    const result = await this.repo.listBackupCollections(project, location, pageSize, pageToken);

    const response: ListBackupCollectionsResponse = {
      backupCollections: result.backupCollections.map(backupCollectionRecordToResponse),
    };

    if (result.nextPageToken) response.nextPageToken = result.nextPageToken;

    return response;
  }

  async getBackupCollection(name: string): Promise<BackupCollectionResponse> {
    const record = await this.repo.getBackupCollectionByName(name);

    if (!record) {
      throw new MemoryStoreError('NOT_FOUND', `BackupCollection ${name} not found`, name);
    }

    return backupCollectionRecordToResponse(record);
  }

  async listBackups(
    backupCollectionName: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListBackupsResponse> {
    const result = await this.repo.listBackups(backupCollectionName, pageSize, pageToken);

    const response: ListBackupsResponse = {
      backups: result.backups.map(backupRecordToResponse),
    };

    if (result.nextPageToken) response.nextPageToken = result.nextPageToken;

    return response;
  }

  async getBackup(name: string): Promise<BackupResponse> {
    const record = await this.repo.getBackupByName(name);

    if (!record) {
      throw new MemoryStoreError('NOT_FOUND', `Backup ${name} not found`, name);
    }

    return backupRecordToResponse(record);
  }

  async deleteBackup(name: string): Promise<OperationResponse> {
    const existing = await this.repo.getBackupByName(name);

    if (!existing) {
      throw new MemoryStoreError('NOT_FOUND', `Backup ${name} not found`, name);
    }

    await this.repo.deleteBackup(name);

    const { project, location } = parseBackupName(name);

    return this.operationsStore.createOperation(project, location, name, 'delete', 'Backup');
  }

  async exportBackup(name: string, _body: { gcsBucket?: string }): Promise<OperationResponse> {
    const existing = await this.repo.getBackupByName(name);

    if (!existing) {
      throw new MemoryStoreError('NOT_FOUND', `Backup ${name} not found`, name);
    }

    const { project, location } = parseBackupName(name);

    return this.operationsStore.createOperation(
      project,
      location,
      name,
      'export',
      'Backup',
      backupRecordToResponse(existing) as unknown as Record<string, unknown>
    );
  }
}
