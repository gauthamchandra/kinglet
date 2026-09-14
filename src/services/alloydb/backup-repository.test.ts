import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { BackupRepository, buildBackupListPrefix } from './backup-repository.ts';
import { ALLOYDB_BACKUPS_TABLE, backupRequestToRecord, buildBackupName } from './types.ts';

let storage: StorageManager;
let repository: BackupRepository;

function backupData(backupId: string, location = 'us-central1', project = 'p') {
  return backupRequestToRecord(
    buildBackupName(project, location, backupId),
    { clusterName: `projects/${project}/locations/${location}/clusters/c1` },
    'cluster-uid'
  );
}

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  repository = new BackupRepository(storage);
  await repository.initialize();
});

test('initialize_createsTheBackupsTable', async () => {
  expect(await storage.listTables()).toContain(ALLOYDB_BACKUPS_TABLE);
});

test('buildBackupListPrefix_endsWithASeparatorSoSiblingIdsStayIsolated', () => {
  expect(buildBackupListPrefix('p', 'us-central1')).toBe(
    'projects/p/locations/us-central1/backups/'
  );
});

describe('listBackups', () => {
  test('listBackups_returnsTheLocationsBackupsSortedByName', async () => {
    for (const backupId of ['b3', 'b1', 'b2']) {
      await repository.create(backupData(backupId));
    }

    const result = await repository.listBackups('p', 'us-central1');

    expect(result.backups.map(backup => backup.name)).toEqual([
      buildBackupName('p', 'us-central1', 'b1'),
      buildBackupName('p', 'us-central1', 'b2'),
      buildBackupName('p', 'us-central1', 'b3'),
    ]);
    expect(result.nextPageToken).toBeUndefined();
  });

  test('listBackups_scopesToTheRequestedProjectAndLocation', async () => {
    await repository.create(backupData('b1'));
    await repository.create(backupData('b1', 'europe-west1'));
    await repository.create(backupData('b1', 'us-central1', 'other'));

    const result = await repository.listBackups('p', 'us-central1');

    expect(result.backups).toHaveLength(1);
    expect(result.backups[0]?.name).toBe(buildBackupName('p', 'us-central1', 'b1'));
  });

  test('listBackups_propagatesPaginationToTheCaller', async () => {
    for (const backupId of ['b1', 'b2', 'b3']) {
      await repository.create(backupData(backupId));
    }

    const firstPage = await repository.listBackups('p', 'us-central1', 2);

    expect(firstPage.backups).toHaveLength(2);
    expect(firstPage.nextPageToken).toBe('2');

    const secondPage = await repository.listBackups('p', 'us-central1', 2, firstPage.nextPageToken);

    expect(secondPage.backups.map(backup => backup.name)).toEqual([
      buildBackupName('p', 'us-central1', 'b3'),
    ]);
  });

  test('listBackups_givenNoBackups_returnsAnEmptyList', async () => {
    expect((await repository.listBackups('p', 'us-central1')).backups).toEqual([]);
  });
});
