/**
 * Business rules for AlloyDB backups. Metadata stubs only — no bytes, WAL, or
 * scheduler. Terraform and clients can create/get/list/patch/delete so apply
 * succeeds; nothing is actually snapshotted.
 */

import type { OperationResponse, OperationsStore } from '@/core/operations/operations-store.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import type { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import type { BackupRepository } from './backup-repository.ts';
import type { ClusterRepository } from './cluster-repository.ts';
import type { BackupRecord, BackupResponse } from './types.ts';
import {
  AlloyDbError,
  BACKUP_SPEC_ENUM_FIELDS,
  backupRecordToResponse,
  backupRequestToRecord,
  buildBackupName,
  isValidBackupId,
  MUTABLE_BACKUP_FIELDS,
  normalizeSpecFieldValue,
  parseSpecJson,
} from './types.ts';
import { resolveMaskedFields } from './update-mask.ts';

const RESOURCE_TYPE = 'Backup';

export interface ValidatableOptions {
  validateOnly?: boolean | undefined;
}

export interface UpdateBackupOptions extends ValidatableOptions {
  updateMask?: string | undefined;
  allowMissing?: boolean | undefined;
}

export interface ListBackupsResponse {
  backups: BackupResponse[];
  nextPageToken?: string | undefined;
}

export class BackupService {
  private readonly backups: BackupRepository;
  private readonly clusters: ClusterRepository;
  private readonly operations: OperationsStore;
  private readonly clusterMutex: ResourceMutex;

  constructor(
    backups: BackupRepository,
    clusters: ClusterRepository,
    operations: OperationsStore,
    clusterMutex: ResourceMutex
  ) {
    this.backups = backups;
    this.clusters = clusters;
    this.operations = operations;
    this.clusterMutex = clusterMutex;
  }

  async createBackup(
    project: string,
    location: string,
    backupId: string,
    body: Record<string, unknown>,
    options: ValidatableOptions
  ): Promise<OperationResponse> {
    validateBackupId(backupId);

    const clusterName = typeof body.clusterName === 'string' ? body.clusterName : '';
    const lockKey =
      clusterName.length > 0 ? clusterName : buildBackupName(project, location, backupId);

    return this.clusterMutex.runExclusively(lockKey, () =>
      this.createBackupExclusively(project, location, backupId, body, options)
    );
  }

  private async createBackupExclusively(
    project: string,
    location: string,
    backupId: string,
    body: Record<string, unknown>,
    options: ValidatableOptions
  ): Promise<OperationResponse> {
    const name = buildBackupName(project, location, backupId);

    if (await this.backups.getByName(name)) {
      throw new AlloyDbError('ALREADY_EXISTS', `Backup ${name} already exists`, name);
    }

    const clusterName = typeof body.clusterName === 'string' ? body.clusterName : '';
    const cluster = clusterName.length > 0 ? await this.clusters.getByName(clusterName) : null;
    const clusterUid = cluster?.uid ?? '';

    const record = backupRequestToRecord(name, body, clusterUid);

    if (options.validateOnly === true) {
      return this.operations.buildUnpersistedOperation(
        project,
        location,
        name,
        'create',
        RESOURCE_TYPE,
        backupRecordToResponse(record)
      );
    }

    const created = await this.backups.create(record);

    return this.operations.createOperation(
      project,
      location,
      name,
      'create',
      RESOURCE_TYPE,
      backupRecordToResponse(created)
    );
  }

  async getBackup(project: string, location: string, backupId: string): Promise<BackupResponse> {
    return backupRecordToResponse(
      await this.getBackupOrThrow(buildBackupName(project, location, backupId))
    );
  }

  async listBackups(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListBackupsResponse> {
    const result = await this.backups.listBackups(project, location, pageSize, pageToken);

    return {
      backups: result.backups.map(backupRecordToResponse),
      nextPageToken: result.nextPageToken,
    };
  }

  async updateBackup(
    project: string,
    location: string,
    backupId: string,
    body: Record<string, unknown>,
    options: UpdateBackupOptions
  ): Promise<OperationResponse> {
    const name = buildBackupName(project, location, backupId);
    const existing = await this.backups.getByName(name);

    if (!existing) {
      if (options.allowMissing !== true) {
        throw new AlloyDbError('NOT_FOUND', `Backup ${name} not found`, name);
      }

      return this.createBackup(project, location, backupId, body, options);
    }

    const updates = buildBackupUpdates(existing, body, options.updateMask);
    const updated: BackupRecord = { ...existing, ...updates };

    if (options.validateOnly === true) {
      return this.operations.buildUnpersistedOperation(
        project,
        location,
        name,
        'update',
        RESOURCE_TYPE,
        backupRecordToResponse(updated)
      );
    }

    const applied = await this.backups.update(name, updates);

    if (!applied) {
      throw new AlloyDbError('NOT_FOUND', `Backup ${name} not found`, name);
    }

    return this.operations.createOperation(
      project,
      location,
      name,
      'update',
      RESOURCE_TYPE,
      backupRecordToResponse(applied)
    );
  }

  async deleteBackup(
    project: string,
    location: string,
    backupId: string,
    options: ValidatableOptions
  ): Promise<OperationResponse> {
    const name = buildBackupName(project, location, backupId);

    await this.getBackupOrThrow(name);

    if (options.validateOnly === true) {
      return this.operations.buildUnpersistedOperation(
        project,
        location,
        name,
        'delete',
        RESOURCE_TYPE
      );
    }

    await this.backups.delete(name);

    return this.operations.createOperation(project, location, name, 'delete', RESOURCE_TYPE);
  }

  private async getBackupOrThrow(name: string): Promise<BackupRecord> {
    const record = await this.backups.getByName(name);

    if (!record) {
      throw new AlloyDbError('NOT_FOUND', `Backup ${name} not found`, name);
    }

    return record;
  }
}

function validateBackupId(backupId: string): void {
  if (isValidBackupId(backupId)) return;

  throw new AlloyDbError(
    'INVALID_ARGUMENT',
    `Backup ID "${backupId}" must be 1-63 characters, start with a lowercase letter, contain only lowercase letters, digits and dashes, and end alphanumerically`
  );
}

function buildBackupUpdates(
  existing: BackupRecord,
  body: Record<string, unknown>,
  updateMask?: string
): Partial<Omit<BackupRecord, keyof BaseRecord>> {
  const maskedFields = resolveMaskedFields(body, MUTABLE_BACKUP_FIELDS, updateMask);
  const spec = parseSpecJson(existing.spec);
  const updates: Partial<Omit<BackupRecord, keyof BaseRecord>> = {
    updateTime: new Date().toISOString(),
  };

  for (const field of maskedFields) {
    if (field in body) {
      spec[field] = normalizeSpecFieldValue(field, body[field], BACKUP_SPEC_ENUM_FIELDS);
    } else {
      delete spec[field];
    }
  }

  updates.spec = JSON.stringify(spec);

  return updates;
}
