/**
 * Unit tests for BackupRepository
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { BackupRepository } from './backup-repository.ts';
import type { BackupRecord } from './types.ts';

function backupData(
  overrides: Partial<Omit<BackupRecord, 'id' | 'createdAt' | 'updatedAt'>> = {}
): Omit<BackupRecord, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: 'projects/p/locations/us-central1/backupCollections/i/backups/20260101000000_abcd',
    backupCollection: 'projects/p/locations/us-central1/backupCollections/i',
    uid: crypto.randomUUID(),
    instance: 'projects/p/locations/us-central1/instances/i',
    instanceUid: crypto.randomUUID(),
    state: 'ACTIVE',
    backupType: 'ON_DEMAND',
    engineVersion: 'VALKEY_7_2',
    replicaCount: 0,
    shardCount: 1,
    nodeType: 'NODE_TYPE_UNSPECIFIED',
    totalSizeBytes: '0',
    backupFiles: JSON.stringify([{ fileName: 'backup-1.rdb', sizeBytes: '0' }]),
    expireTime: null,
    encryptionInfo: null,
    ...overrides,
  };
}

describe('BackupRepository', () => {
  let storage: StorageManager;
  let repo: BackupRepository;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new BackupRepository(storage);
    await repo.initialize();
  });

  describe('backup collections', () => {
    test('createBackupCollectionIfMissing_givenNoExistingCollection_createsIt', async () => {
      await repo.createBackupCollectionIfMissing(
        'projects/p/locations/us-central1/backupCollections/i',
        'projects/p/locations/us-central1/instances/i',
        'uid-instance'
      );

      const found = await repo.getBackupCollectionByName(
        'projects/p/locations/us-central1/backupCollections/i'
      );

      expect(found).not.toBeNull();
      expect(found?.instance).toBe('projects/p/locations/us-central1/instances/i');
    });

    test('createBackupCollectionIfMissing_calledTwiceForTheSameInstance_doesNotCreateASecondRow', async () => {
      await repo.createBackupCollectionIfMissing(
        'projects/p/locations/us-central1/backupCollections/i',
        'projects/p/locations/us-central1/instances/i',
        'uid-instance'
      );
      await repo.createBackupCollectionIfMissing(
        'projects/p/locations/us-central1/backupCollections/i',
        'projects/p/locations/us-central1/instances/i',
        'uid-instance'
      );

      const page = await repo.listBackupCollections('p', 'us-central1');

      expect(page.backupCollections).toHaveLength(1);
    });

    test('createBackupCollectionIfMissing_givenNoExistingCollection_reportsThatThisCallCreatedIt', async () => {
      const wasCreated = await repo.createBackupCollectionIfMissing(
        'projects/p/locations/us-central1/backupCollections/i',
        'projects/p/locations/us-central1/instances/i',
        'uid-instance'
      );

      expect(wasCreated).toBe(true);
    });

    test('createBackupCollectionIfMissing_givenACollectionThatAlreadyExists_reportsThatItCreatedNothing', async () => {
      await repo.createBackupCollectionIfMissing(
        'projects/p/locations/us-central1/backupCollections/i',
        'projects/p/locations/us-central1/instances/i',
        'uid-instance'
      );

      // A caller rolling back a failed create leans on this to avoid deleting a
      // collection that predates it.
      const wasCreated = await repo.createBackupCollectionIfMissing(
        'projects/p/locations/us-central1/backupCollections/i',
        'projects/p/locations/us-central1/instances/i',
        'uid-instance-2'
      );

      expect(wasCreated).toBe(false);
    });

    test('deleteBackupCollection_givenAnExistingCollection_removesIt', async () => {
      await repo.createBackupCollectionIfMissing(
        'projects/p/locations/us-central1/backupCollections/i',
        'projects/p/locations/us-central1/instances/i',
        'uid-instance'
      );

      const wasDeleted = await repo.deleteBackupCollection(
        'projects/p/locations/us-central1/backupCollections/i'
      );

      expect(wasDeleted).toBe(true);
      expect(
        await repo.getBackupCollectionByName('projects/p/locations/us-central1/backupCollections/i')
      ).toBeNull();
    });

    test('deleteBackupCollection_givenAnUnknownName_reportsThatNothingWasDeleted', async () => {
      expect(
        await repo.deleteBackupCollection('projects/p/locations/us-central1/backupCollections/gone')
      ).toBe(false);
    });

    test('listBackupCollections_scopesToProjectViaLikePrefix_andDoesNotLeakOtherProjects', async () => {
      await repo.createBackupCollectionIfMissing(
        'projects/p1/locations/us-central1/backupCollections/a',
        'projects/p1/locations/us-central1/instances/a',
        'uid-instance'
      );
      await repo.createBackupCollectionIfMissing(
        'projects/p2/locations/us-central1/backupCollections/b',
        'projects/p2/locations/us-central1/instances/b',
        'uid-instance'
      );

      const result = await repo.listBackupCollections('p1', 'us-central1');

      expect(result.backupCollections).toHaveLength(1);
      expect(result.backupCollections[0]?.name.startsWith('projects/p1/')).toBe(true);
    });

    test('listBackupCollections_scopesToLocation_andDoesNotLeakCollectionsFromOtherRegionsInTheSameProject', async () => {
      await repo.createBackupCollectionIfMissing(
        'projects/p/locations/us-central1/backupCollections/a',
        'projects/p/locations/us-central1/instances/a',
        'uid-instance'
      );
      await repo.createBackupCollectionIfMissing(
        'projects/p/locations/europe-west1/backupCollections/b',
        'projects/p/locations/europe-west1/instances/b',
        'uid-instance'
      );

      const result = await repo.listBackupCollections('p', 'us-central1');

      expect(result.backupCollections).toHaveLength(1);
      expect(result.backupCollections[0]?.name).toBe(
        'projects/p/locations/us-central1/backupCollections/a'
      );
    });

    test('getBackupCollectionByName_givenMissingCollection_returnsNull', async () => {
      const found = await repo.getBackupCollectionByName(
        'projects/p/locations/us-central1/backupCollections/missing'
      );

      expect(found).toBeNull();
    });
  });

  describe('backups', () => {
    beforeEach(async () => {
      await repo.createBackupCollectionIfMissing(
        'projects/p/locations/us-central1/backupCollections/i',
        'projects/p/locations/us-central1/instances/i',
        'uid-instance'
      );
    });

    test('createBackup_persistsRecord_andRoundTripsTheBackupFilesJsonColumn', async () => {
      await repo.createBackup(backupData());

      const persisted = await repo.getBackupByName(
        'projects/p/locations/us-central1/backupCollections/i/backups/20260101000000_abcd'
      );

      expect(persisted).not.toBeNull();
      expect(JSON.parse(persisted?.backupFiles as string)).toEqual([
        { fileName: 'backup-1.rdb', sizeBytes: '0' },
      ]);
    });

    test('createBackup_givenDuplicateName_rejectsAndLeavesTheOriginalRowIntact', async () => {
      await repo.createBackup(backupData({ totalSizeBytes: '1024' }));

      const promise = repo.createBackup(backupData({ totalSizeBytes: '2048' }));

      await expect(promise).rejects.toThrow(/name|unique|exists/i);

      const page = await repo.listBackups('projects/p/locations/us-central1/backupCollections/i');

      expect(page.backups).toHaveLength(1);
      expect(page.backups[0]?.totalSizeBytes).toBe('1024');
    });

    test('listBackups_scopesToTheBackupCollection_andDoesNotLeakOtherCollections', async () => {
      await repo.createBackupCollectionIfMissing(
        'projects/p/locations/us-central1/backupCollections/other',
        'projects/p/locations/us-central1/instances/other',
        'uid-instance'
      );
      await repo.createBackup(backupData());
      await repo.createBackup(
        backupData({
          name: 'projects/p/locations/us-central1/backupCollections/other/backups/20260101000000_efgh',
          backupCollection: 'projects/p/locations/us-central1/backupCollections/other',
        })
      );

      const result = await repo.listBackups('projects/p/locations/us-central1/backupCollections/i');

      expect(result.backups).toHaveLength(1);
      expect(result.backups[0]?.backupCollection).toBe(
        'projects/p/locations/us-central1/backupCollections/i'
      );
    });

    test('listBackups_paginatesWithStringifiedOffsetTokens', async () => {
      await repo.createBackup(
        backupData({
          name: 'projects/p/locations/us-central1/backupCollections/i/backups/a',
        })
      );
      await repo.createBackup(
        backupData({
          name: 'projects/p/locations/us-central1/backupCollections/i/backups/b',
        })
      );

      const page1 = await repo.listBackups(
        'projects/p/locations/us-central1/backupCollections/i',
        1
      );

      expect(page1.backups).toHaveLength(1);
      expect(page1.nextPageToken).toBe('1');

      const page2 = await repo.listBackups(
        'projects/p/locations/us-central1/backupCollections/i',
        1,
        page1.nextPageToken
      );

      expect(page2.backups).toHaveLength(1);
      expect(page2.backups[0]?.name).not.toBe(page1.backups[0]?.name);
    });

    test('deleteBackup_removesTheBackup_andReturnsTrue', async () => {
      await repo.createBackup(backupData());

      const deleted = await repo.deleteBackup(
        'projects/p/locations/us-central1/backupCollections/i/backups/20260101000000_abcd'
      );

      expect(deleted).toBe(true);

      const found = await repo.getBackupByName(
        'projects/p/locations/us-central1/backupCollections/i/backups/20260101000000_abcd'
      );

      expect(found).toBeNull();
    });

    test('deleteBackup_givenMissingBackup_returnsFalse', async () => {
      const deleted = await repo.deleteBackup(
        'projects/p/locations/us-central1/backupCollections/i/backups/missing'
      );

      expect(deleted).toBe(false);
    });
  });

  describe('backup collection statistics', () => {
    beforeEach(async () => {
      await repo.createBackupCollectionIfMissing(
        'projects/p/locations/us-central1/backupCollections/i',
        'projects/p/locations/us-central1/instances/i',
        'uid-instance'
      );
    });

    test('createBackup_updatesTheParentCollectionsCountSizeAndLastBackupTime', async () => {
      await repo.createBackup(backupData({ totalSizeBytes: '1024' }));

      const collection = await repo.getBackupCollectionByName(
        'projects/p/locations/us-central1/backupCollections/i'
      );

      expect(collection?.totalBackupCount).toBe(1);
      expect(collection?.totalBackupSizeBytes).toBe('1024');
      expect(collection?.lastBackupTime).toBeTypeOf('string');
    });

    test('createBackup_calledASecondTime_accumulatesTheCountAndTheSummedSize', async () => {
      await repo.createBackup(backupData({ totalSizeBytes: '1024' }));
      await repo.createBackup(
        backupData({
          name: 'projects/p/locations/us-central1/backupCollections/i/backups/20260102000000_efgh',
          totalSizeBytes: '2048',
        })
      );

      const collection = await repo.getBackupCollectionByName(
        'projects/p/locations/us-central1/backupCollections/i'
      );

      expect(collection?.totalBackupCount).toBe(2);
      expect(collection?.totalBackupSizeBytes).toBe('3072');
    });

    test('deleteBackup_removingTheOnlyBackup_returnsTheCollectionToEmptyWithNoLastBackupTime', async () => {
      await repo.createBackup(backupData({ totalSizeBytes: '1024' }));

      await repo.deleteBackup(
        'projects/p/locations/us-central1/backupCollections/i/backups/20260101000000_abcd'
      );

      const collection = await repo.getBackupCollectionByName(
        'projects/p/locations/us-central1/backupCollections/i'
      );

      expect(collection?.totalBackupCount).toBe(0);
      expect(collection?.totalBackupSizeBytes).toBe('0');
      expect(collection?.lastBackupTime).toBeNull();
    });

    test('createBackup_leavesADifferentCollectionsStatisticsAlone', async () => {
      await repo.createBackupCollectionIfMissing(
        'projects/p/locations/us-central1/backupCollections/other',
        'projects/p/locations/us-central1/instances/other',
        'uid-instance-other'
      );

      await repo.createBackup(backupData({ totalSizeBytes: '1024' }));

      const otherCollection = await repo.getBackupCollectionByName(
        'projects/p/locations/us-central1/backupCollections/other'
      );

      expect(otherCollection?.totalBackupCount).toBe(0);
      expect(otherCollection?.lastBackupTime).toBeNull();
    });
  });
});
