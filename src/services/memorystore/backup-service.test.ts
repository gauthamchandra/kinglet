/**
 * Unit tests for BackupService
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { BackupRepository } from './backup-repository.ts';
import { BackupService } from './backup-service.ts';
import type { OperationsStore } from './operations.ts';
import { MemoryStoreError } from './types.ts';

function makeBackupCollectionRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    name: 'projects/p/locations/us-central1/backupCollections/i',
    uid: 'collection-uid-1',
    instance: 'projects/p/locations/us-central1/instances/i',
    instanceUid: 'instance-uid-1',
    kmsKey: null,
    totalBackupCount: 1,
    totalBackupSizeBytes: '1024',
    lastBackupTime: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeBackupRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    name: 'projects/p/locations/us-central1/backupCollections/i/backups/20260101000000_abcd',
    backupCollection: 'projects/p/locations/us-central1/backupCollections/i',
    uid: 'backup-uid-1',
    instance: 'projects/p/locations/us-central1/instances/i',
    instanceUid: 'instance-uid-1',
    state: 'ACTIVE',
    backupType: 'ON_DEMAND',
    engineVersion: 'VALKEY_7_2',
    replicaCount: 0,
    shardCount: 1,
    nodeType: 'NODE_TYPE_UNSPECIFIED',
    totalSizeBytes: '1024',
    backupFiles: JSON.stringify([{ fileName: 'backup-1.rdb', sizeBytes: '1024' }]),
    expireTime: null,
    encryptionInfo: null,
    ...overrides,
  };
}

describe('BackupService', () => {
  let repo: BackupRepository;
  let operationsStore: OperationsStore;
  let service: BackupService;

  beforeEach(() => {
    repo = {
      listBackupCollections: mock(() =>
        Promise.resolve({ backupCollections: [makeBackupCollectionRecord()], nextPageToken: '1' })
      ),
      getBackupCollectionByName: mock(() => Promise.resolve(null)),
      listBackups: mock(() =>
        Promise.resolve({ backups: [makeBackupRecord()], nextPageToken: '1' })
      ),
      getBackupByName: mock(() => Promise.resolve(null)),
      deleteBackup: mock(() => Promise.resolve(true)),
    } as unknown as BackupRepository;

    operationsStore = {
      createOperation: mock(
        (
          _p: string,
          _l: string,
          target: string,
          verb: string,
          _resourceType: string,
          response?: Record<string, unknown>
        ) =>
          Promise.resolve({
            name: 'projects/p/locations/us-central1/operations/op-1',
            metadata: {
              '@type': 'type.googleapis.com/google.cloud.memorystore.v1.OperationMetadata',
              createTime: '2026-01-01T00:00:00.000Z',
              endTime: '2026-01-01T00:00:00.000Z',
              target,
              verb,
              apiVersion: 'v1',
            },
            done: true,
            ...(response ? { response } : {}),
          })
      ),
    } as unknown as OperationsStore;

    service = new BackupService(repo, operationsStore);
  });

  test('listBackupCollections_mapsRecordsToTheBackupCollectionsEnvelopeKey', async () => {
    const result = await service.listBackupCollections('p', 'us-central1', 10, '0');

    expect(repo.listBackupCollections).toHaveBeenCalledWith('p', 'us-central1', 10, '0');
    expect(result.backupCollections[0]?.name).toBe(
      'projects/p/locations/us-central1/backupCollections/i'
    );
    expect(result.backupCollections[0]?.totalBackupCount).toBe(1);
    expect(result.nextPageToken).toBe('1');
  });

  test('getBackupCollection_givenExistingCollection_returnsBackupCollectionResponse', async () => {
    (repo.getBackupCollectionByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeBackupCollectionRecord())
    );

    const result = await service.getBackupCollection(
      'projects/p/locations/us-central1/backupCollections/i'
    );

    expect(result.name).toBe('projects/p/locations/us-central1/backupCollections/i');
  });

  test('getBackupCollection_givenMissingCollection_throwsNotFound', async () => {
    const promise = service.getBackupCollection(
      'projects/p/locations/us-central1/backupCollections/missing'
    );

    await expect(promise).rejects.toBeInstanceOf(MemoryStoreError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('listBackups_mapsRecordsToTheBackupsEnvelopeKeyAndParsesTheBackupFilesJsonColumn', async () => {
    const result = await service.listBackups(
      'projects/p/locations/us-central1/backupCollections/i',
      10,
      '0'
    );

    expect(repo.listBackups).toHaveBeenCalledWith(
      'projects/p/locations/us-central1/backupCollections/i',
      10,
      '0'
    );
    expect(result.backups[0]?.backupFiles).toEqual([
      { fileName: 'backup-1.rdb', sizeBytes: '1024' },
    ]);
    expect(result.nextPageToken).toBe('1');
  });

  test('getBackup_givenExistingBackup_returnsBackupResponse', async () => {
    (repo.getBackupByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeBackupRecord())
    );

    const result = await service.getBackup(
      'projects/p/locations/us-central1/backupCollections/i/backups/20260101000000_abcd'
    );

    expect(result.name).toBe(
      'projects/p/locations/us-central1/backupCollections/i/backups/20260101000000_abcd'
    );
  });

  test('getBackup_givenMissingBackup_throwsNotFound', async () => {
    const promise = service.getBackup(
      'projects/p/locations/us-central1/backupCollections/i/backups/missing'
    );

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('deleteBackup_givenExistingBackup_removesItAndReturnsADoneOperation', async () => {
    (repo.getBackupByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeBackupRecord())
    );

    const op = await service.deleteBackup(
      'projects/p/locations/us-central1/backupCollections/i/backups/20260101000000_abcd'
    );

    expect(repo.deleteBackup).toHaveBeenCalledWith(
      'projects/p/locations/us-central1/backupCollections/i/backups/20260101000000_abcd'
    );
    expect(op.done).toBe(true);
    expect(op.metadata.verb).toBe('delete');
  });

  test('deleteBackup_givenMissingBackup_throwsNotFound', async () => {
    const promise = service.deleteBackup(
      'projects/p/locations/us-central1/backupCollections/i/backups/missing'
    );

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('exportBackup_givenExistingBackup_returnsADoneOperationWithExportVerb', async () => {
    (repo.getBackupByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeBackupRecord())
    );

    const op = await service.exportBackup(
      'projects/p/locations/us-central1/backupCollections/i/backups/20260101000000_abcd',
      { gcsBucket: 'gs://my-bucket' }
    );

    expect(op.done).toBe(true);
    expect(op.metadata.verb).toBe('export');
  });

  test('exportBackup_returnsTheExportedBackupAsTheOperationResponse', async () => {
    (repo.getBackupByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeBackupRecord())
    );

    const op = await service.exportBackup(
      'projects/p/locations/us-central1/backupCollections/i/backups/20260101000000_abcd',
      { gcsBucket: 'gs://my-bucket' }
    );

    expect(op.response?.name).toBe(
      'projects/p/locations/us-central1/backupCollections/i/backups/20260101000000_abcd'
    );
    expect(op.response?.state).toBe('ACTIVE');
  });

  test('exportBackup_givenMissingBackup_throwsNotFound', async () => {
    const promise = service.exportBackup(
      'projects/p/locations/us-central1/backupCollections/i/backups/missing',
      {}
    );

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });
});
