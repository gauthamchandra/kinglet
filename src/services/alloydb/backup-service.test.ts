import { beforeEach, describe, expect, test } from 'bun:test';
import { OperationsStore } from '@/core/operations/operations-store.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import { createMockLogger } from '../../../test-utils/mock-logger.ts';
import { BackupRepository } from './backup-repository.ts';
import { BackupService } from './backup-service.ts';
import { ClusterRepository } from './cluster-repository.ts';
import { ClusterService } from './cluster-service.ts';
import { InstanceRepository } from './instance-repository.ts';
import {
  ALLOYDB_OPERATIONS_TABLE,
  AlloyDbError,
  BackupState,
  BackupType,
  buildBackupName,
  buildClusterName,
  clusterRequestToRecord,
} from './types.ts';
import { UserRepository } from './user-repository.ts';

const PROJECT = 'p';
const LOCATION = 'us-central1';
const CLUSTER_ID = 'c1';
const BACKUP_ID = 'b1';
const CLUSTER_NAME = buildClusterName(PROJECT, LOCATION, CLUSTER_ID);
const BACKUP_NAME = buildBackupName(PROJECT, LOCATION, BACKUP_ID);

let storage: StorageManager;
let clusters: ClusterRepository;
let backups: BackupRepository;
let clusterMutex: ResourceMutex;
let operations: OperationsStore;
let service: BackupService;
let clusterService: ClusterService;

function backupFromOperation(operation: { response?: Record<string, unknown> }) {
  return operation.response as Record<string, unknown>;
}

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  clusters = new ClusterRepository(storage);
  backups = new BackupRepository(storage);
  const instances = new InstanceRepository(storage);
  const users = new UserRepository(storage);

  operations = new OperationsStore(storage, {
    tableName: ALLOYDB_OPERATIONS_TABLE,
    apiTypePrefix: 'google.cloud.alloydb.v1',
  });

  await Promise.all([
    clusters.initialize(),
    backups.initialize(),
    instances.initialize(),
    users.initialize(),
    operations.initialize(),
  ]);

  clusterMutex = new ResourceMutex();
  service = new BackupService(backups, clusters, operations, clusterMutex);
  clusterService = new ClusterService(
    clusters,
    instances,
    users,
    operations,
    clusterMutex,
    createMockLogger()
  );

  await clusters.create(
    clusterRequestToRecord(CLUSTER_NAME, {
      networkConfig: { network: 'projects/p/global/networks/default' },
    })
  );
});

describe('createBackup', () => {
  test('createBackup_returnsACompletedOperationCarryingTheNewBackup', async () => {
    const operation = await service.createBackup(
      PROJECT,
      LOCATION,
      BACKUP_ID,
      { clusterName: CLUSTER_NAME, type: 'ON_DEMAND' },
      {}
    );

    expect(operation.done).toBe(true);
    expect(operation.metadata.verb).toBe('create');
    expect(operation.metadata.target).toBe(BACKUP_NAME);

    const backup = backupFromOperation(operation);

    expect(backup.name).toBe(BACKUP_NAME);
    expect(backup.state).toBe(BackupState.READY);
    expect(backup.type).toBe(BackupType.ON_DEMAND);
    expect(backup.sizeBytes).toBe('0');
    expect(backup.clusterName).toBe(CLUSTER_NAME);
    expect(backup.clusterUid).toBeTypeOf('string');
    expect((backup.clusterUid as string).length).toBeGreaterThan(0);
  });

  test('createBackup_defaultsTypeToOnDemandAndSizeBytesToTheStringZero', async () => {
    await service.createBackup(PROJECT, LOCATION, BACKUP_ID, { clusterName: CLUSTER_NAME }, {});

    const backup = await service.getBackup(PROJECT, LOCATION, BACKUP_ID);

    expect(backup.type).toBe(BackupType.ON_DEMAND);
    expect(backup.sizeBytes).toBe('0');
    expect(backup.reconciling).toBe(false);
  });

  test('createBackup_withoutAParentCluster_stillSucceedsWithAnEmptyClusterUid', async () => {
    const operation = await service.createBackup(
      PROJECT,
      LOCATION,
      BACKUP_ID,
      { clusterName: 'projects/p/locations/us-central1/clusters/missing' },
      {}
    );

    expect(backupFromOperation(operation).clusterUid).toBe('');
  });

  test('createBackup_givenADuplicate_reportsAlreadyExists', async () => {
    await service.createBackup(PROJECT, LOCATION, BACKUP_ID, { clusterName: CLUSTER_NAME }, {});

    const promise = service.createBackup(
      PROJECT,
      LOCATION,
      BACKUP_ID,
      { clusterName: CLUSTER_NAME },
      {}
    );

    await expect(promise).rejects.toBeInstanceOf(AlloyDbError);
    await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
  });

  test('createBackup_givenAMalformedId_reportsInvalidArgument', async () => {
    const promise = service.createBackup(
      PROJECT,
      LOCATION,
      '1bad',
      { clusterName: CLUSTER_NAME },
      {}
    );

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('createBackup_withValidateOnly_persistsNothing', async () => {
    await service.createBackup(
      PROJECT,
      LOCATION,
      BACKUP_ID,
      { clusterName: CLUSTER_NAME },
      { validateOnly: true }
    );

    await expect(service.getBackup(PROJECT, LOCATION, BACKUP_ID)).rejects.toHaveProperty(
      'code',
      'NOT_FOUND'
    );
  });
});

describe('getBackup and listBackups', () => {
  test('getBackup_givenAnUnknownBackup_reportsNotFound', async () => {
    await expect(service.getBackup(PROJECT, LOCATION, 'missing')).rejects.toHaveProperty(
      'code',
      'NOT_FOUND'
    );
  });

  test('listBackups_keysTheResultOnBackups', async () => {
    await service.createBackup(PROJECT, LOCATION, BACKUP_ID, { clusterName: CLUSTER_NAME }, {});

    const result = await service.listBackups(PROJECT, LOCATION);

    expect(result.backups.map(backup => backup.name)).toEqual([BACKUP_NAME]);
  });
});

describe('updateBackup and deleteBackup', () => {
  test('updateBackup_echoesLabels', async () => {
    await service.createBackup(PROJECT, LOCATION, BACKUP_ID, { clusterName: CLUSTER_NAME }, {});

    const operation = await service.updateBackup(
      PROJECT,
      LOCATION,
      BACKUP_ID,
      { labels: { env: 'dev' } },
      { updateMask: 'labels' }
    );

    expect(backupFromOperation(operation).labels).toEqual({ env: 'dev' });
    expect((await service.getBackup(PROJECT, LOCATION, BACKUP_ID)).labels).toEqual({ env: 'dev' });
  });

  test('deleteBackup_removesTheBackup', async () => {
    await service.createBackup(PROJECT, LOCATION, BACKUP_ID, { clusterName: CLUSTER_NAME }, {});
    await service.deleteBackup(PROJECT, LOCATION, BACKUP_ID, {});

    await expect(service.getBackup(PROJECT, LOCATION, BACKUP_ID)).rejects.toHaveProperty(
      'code',
      'NOT_FOUND'
    );
  });
});

describe('cluster delete does not cascade backups', () => {
  test('deleteCluster_leavesOnDemandBackupsInPlace', async () => {
    await service.createBackup(PROJECT, LOCATION, BACKUP_ID, { clusterName: CLUSTER_NAME }, {});
    await clusterService.deleteCluster(PROJECT, LOCATION, CLUSTER_ID, { force: true });

    const backup = await service.getBackup(PROJECT, LOCATION, BACKUP_ID);

    expect(backup.name).toBe(BACKUP_NAME);
    expect(backup.clusterName).toBe(CLUSTER_NAME);
  });
});
