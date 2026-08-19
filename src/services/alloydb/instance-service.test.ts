import { beforeEach, describe, expect, test } from 'bun:test';
import { OperationsStore } from '@/core/operations/operations-store.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { ClusterRepository } from './cluster-repository.ts';
import { InstanceRepository } from './instance-repository.ts';
import { InstanceService } from './instance-service.ts';
import {
  ALLOYDB_OPERATIONS_TABLE,
  AlloyDbError,
  buildClusterName,
  buildInstanceName,
  clusterRequestToRecord,
  InstanceState,
  InstanceType,
} from './types.ts';

const PROJECT = 'p';
const LOCATION = 'us-central1';
const CLUSTER_ID = 'c1';
const INSTANCE_ID = 'i1';
const INSTANCE_NAME = buildInstanceName(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID);

let storage: StorageManager;
let clusters: ClusterRepository;
let instances: InstanceRepository;
let service: InstanceService;

function instanceFromOperation(operation: { response?: Record<string, unknown> }) {
  return operation.response as Record<string, unknown>;
}

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  clusters = new ClusterRepository(storage);
  instances = new InstanceRepository(storage);

  const operations = new OperationsStore(storage, {
    tableName: ALLOYDB_OPERATIONS_TABLE,
    apiTypePrefix: 'google.cloud.alloydb.v1',
  });

  await Promise.all([clusters.initialize(), instances.initialize(), operations.initialize()]);

  service = new InstanceService(instances, clusters, operations);

  await clusters.create(
    clusterRequestToRecord(buildClusterName(PROJECT, LOCATION, CLUSTER_ID), {
      initialUser: { user: 'postgres' },
    })
  );
});

describe('createInstance', () => {
  test('createInstance_returnsACompletedOperationCarryingTheNewInstance', async () => {
    const operation = await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      { instanceType: 'PRIMARY' },
      {}
    );

    expect(operation.done).toBe(true);
    expect(operation.metadata.verb).toBe('create');

    const instance = instanceFromOperation(operation);

    expect(instance.name).toBe(INSTANCE_NAME);
    expect(instance.state).toBe(InstanceState.READY);
    expect(instance.instanceType).toBe(InstanceType.PRIMARY);
    expect(instance['@type']).toBe('type.googleapis.com/google.cloud.alloydb.v1.Instance');
  });

  test('createInstance_reportsTheLoopbackAddressPlaceholder', async () => {
    const operation = await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      {},
      {}
    );

    expect(instanceFromOperation(operation).ipAddress).toBe('127.0.0.1');
  });

  /**
   * An instance's name nests inside its cluster's, so creating one beneath a
   * cluster that does not exist must 404 on the *cluster* rather than inventing
   * an orphan whose parent can never be fetched.
   */
  test('createInstance_underAMissingCluster_reportsNotFoundForTheCluster', async () => {
    const promise = service.createInstance(PROJECT, LOCATION, 'missing', INSTANCE_ID, {}, {});

    await expect(promise).rejects.toBeInstanceOf(AlloyDbError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    await expect(promise).rejects.toThrow(/Cluster/);
  });

  test('createInstance_givenADuplicateId_reportsAlreadyExists', async () => {
    await service.createInstance(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID, {}, {});

    const promise = service.createInstance(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID, {}, {});

    await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
  });

  /**
   * Instance ids are stricter than cluster ids — they must start with a letter
   * and end alphanumeric — so `0-9` is legal for a cluster but not here.
   */
  test.each([
    '0-9',
    '1abc',
    'abc-',
    'MyInstance',
    '',
    'a'.repeat(64),
  ])('createInstance_givenTheMalformedInstanceId_%p_reportsInvalidArgument', async instanceId => {
    const promise = service.createInstance(PROJECT, LOCATION, CLUSTER_ID, instanceId, {}, {});

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('createInstance_givenAnUnknownInstanceType_reportsInvalidArgument', async () => {
    const promise = service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      { instanceType: 'NOT_A_TYPE' },
      {}
    );

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test.each([
    'PRIMARY',
    'READ_POOL',
    'SECONDARY',
  ])('createInstance_acceptsTheDocumentedInstanceType_%s', async instanceType => {
    const operation = await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'i1',
      { instanceType },
      {}
    );

    expect(instanceFromOperation(operation).instanceType).toBe(instanceType);
  });

  test('createInstance_withValidateOnly_persistsNothing', async () => {
    await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      {},
      {
        validateOnly: true,
      }
    );

    await expect(
      service.getInstance(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID)
    ).rejects.toHaveProperty('code', 'NOT_FOUND');
    expect(await storage.count(ALLOYDB_OPERATIONS_TABLE)).toBe(0);
  });
});

describe('getInstance', () => {
  test('getInstance_returnsTheInstanceResponse', async () => {
    await service.createInstance(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID, {}, {});

    const instance = await service.getInstance(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID);

    expect(instance.name).toBe(INSTANCE_NAME);
    expect(instance.reconciling).toBe(false);
  });

  test('getInstance_givenAnUnknownInstance_reportsNotFound', async () => {
    const promise = service.getInstance(PROJECT, LOCATION, CLUSTER_ID, 'missing');

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });
});

describe('listInstances', () => {
  test('listInstances_returnsTheClustersInstances', async () => {
    await service.createInstance(PROJECT, LOCATION, CLUSTER_ID, 'i1', {}, {});
    await service.createInstance(PROJECT, LOCATION, CLUSTER_ID, 'i2', {}, {});

    const result = await service.listInstances(PROJECT, LOCATION, CLUSTER_ID);

    expect(result.instances.map(instance => instance.name)).toEqual([
      buildInstanceName(PROJECT, LOCATION, CLUSTER_ID, 'i1'),
      buildInstanceName(PROJECT, LOCATION, CLUSTER_ID, 'i2'),
    ]);
  });

  test('listInstances_givenAClusterWithNoInstances_returnsAnEmptyList', async () => {
    expect((await service.listInstances(PROJECT, LOCATION, CLUSTER_ID)).instances).toEqual([]);
  });

  /**
   * The discovery document does not say whether listing under a missing parent
   * 404s or returns empty. NOT_FOUND is chosen so the mistake surfaces locally
   * and loudly rather than looking like a cluster that simply has no instances.
   * Flagged in the PR as inferred behaviour.
   */
  test('listInstances_underAMissingCluster_reportsNotFound', async () => {
    const promise = service.listInstances(PROJECT, LOCATION, 'missing');

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('listInstances_propagatesPagination', async () => {
    await service.createInstance(PROJECT, LOCATION, CLUSTER_ID, 'i1', {}, {});
    await service.createInstance(PROJECT, LOCATION, CLUSTER_ID, 'i2', {}, {});

    const result = await service.listInstances(PROJECT, LOCATION, CLUSTER_ID, 1);

    expect(result.instances).toHaveLength(1);
    expect(result.nextPageToken).toBe('1');
  });
});

describe('updateInstance', () => {
  beforeEach(async () => {
    await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      { instanceType: 'PRIMARY' },
      {}
    );
  });

  test('updateInstance_appliesTheMaskedFieldAndReturnsAnOperation', async () => {
    const operation = await service.updateInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      { displayName: 'renamed' },
      { updateMask: 'displayName' }
    );

    expect(operation.metadata.verb).toBe('update');
    expect(instanceFromOperation(operation).displayName).toBe('renamed');
  });

  // `instanceType` is writable but lives in a column rather than the spec blob.
  test('updateInstance_canChangeTheInstanceType', async () => {
    await service.updateInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      { instanceType: 'READ_POOL' },
      { updateMask: 'instanceType' }
    );

    expect(
      (await service.getInstance(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID)).instanceType
    ).toBe(InstanceType.READ_POOL);
  });

  test('updateInstance_givenAnUnknownInstanceTypeInTheMask_reportsInvalidArgument', async () => {
    const promise = service.updateInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      { instanceType: 'NOT_A_TYPE' },
      { updateMask: 'instanceType' }
    );

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('updateInstance_givenAMaskNamingAnOutputOnlyField_reportsInvalidArgument', async () => {
    const promise = service.updateInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      { ipAddress: '10.0.0.1' },
      { updateMask: 'ipAddress' }
    );

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('updateInstance_givenTheWildcardMask_reportsInvalidArgument', async () => {
    const promise = service.updateInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      {},
      { updateMask: '*' }
    );

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('updateInstance_givenAnUnknownInstance_reportsNotFound', async () => {
    const promise = service.updateInstance(PROJECT, LOCATION, CLUSTER_ID, 'missing', {}, {});

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('updateInstance_givenAnUnknownInstanceAndAllowMissing_createsIt', async () => {
    const operation = await service.updateInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'fresh',
      { instanceType: 'READ_POOL' },
      { allowMissing: true }
    );

    expect(instanceFromOperation(operation).name).toBe(
      buildInstanceName(PROJECT, LOCATION, CLUSTER_ID, 'fresh')
    );
    expect((await service.getInstance(PROJECT, LOCATION, CLUSTER_ID, 'fresh')).state).toBe(
      InstanceState.READY
    );
  });

  test('updateInstance_withValidateOnly_persistsNothing', async () => {
    await service.updateInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      { displayName: 'not-applied' },
      { updateMask: 'displayName', validateOnly: true }
    );

    expect(
      await service.getInstance(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID)
    ).not.toHaveProperty('displayName');
  });

  test('updateInstance_advancesUpdateTimeButNotCreateTime', async () => {
    const before = await service.getInstance(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID);

    await Bun.sleep(2);
    await service.updateInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      { displayName: 'x' },
      {}
    );

    const after = await service.getInstance(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID);

    expect(after.createTime).toBe(before.createTime);
    expect(Date.parse(after.updateTime)).toBeGreaterThan(Date.parse(before.updateTime));
  });
});

describe('deleteInstance', () => {
  beforeEach(async () => {
    await service.createInstance(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID, {}, {});
  });

  test('deleteInstance_removesTheInstanceAndReturnsAnOperation', async () => {
    const operation = await service.deleteInstance(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID, {});

    expect(operation.metadata.verb).toBe('delete');
    expect(operation).not.toHaveProperty('response');
    await expect(
      service.getInstance(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID)
    ).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('deleteInstance_givenAnUnknownInstance_reportsNotFound', async () => {
    const promise = service.deleteInstance(PROJECT, LOCATION, CLUSTER_ID, 'missing', {});

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('deleteInstance_withValidateOnly_leavesTheInstanceInPlace', async () => {
    await service.deleteInstance(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID, {
      validateOnly: true,
    });

    expect((await service.getInstance(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID)).name).toBe(
      INSTANCE_NAME
    );
  });
});

describe('getConnectionInfo', () => {
  test('getConnectionInfo_returnsTheSingletonSubresourceForTheInstance', async () => {
    const operation = await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      {},
      {}
    );

    const connectionInfo = await service.getConnectionInfo(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID
    );

    const createdUid = instanceFromOperation(operation).uid;

    expect(createdUid).toBeTypeOf('string');
    expect(connectionInfo.name).toBe(`${INSTANCE_NAME}/connectionInfo`);
    expect(connectionInfo.ipAddress).toBe('127.0.0.1');
    expect(connectionInfo.instanceUid).toBe(createdUid as string);
  });

  test('getConnectionInfo_givenAnUnknownInstance_reportsNotFound', async () => {
    const promise = service.getConnectionInfo(PROJECT, LOCATION, CLUSTER_ID, 'missing');

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });
});
