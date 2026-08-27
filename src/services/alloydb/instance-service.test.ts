import { beforeEach, describe, expect, test } from 'bun:test';
import { OperationsStore } from '@/core/operations/operations-store.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
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

  service = new InstanceService(instances, clusters, operations, new ResourceMutex());

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
      { instanceType: 'PRIMARY' },
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
    const promise = service.createInstance(
      PROJECT,
      LOCATION,
      'missing',
      INSTANCE_ID,
      { instanceType: 'PRIMARY' },
      {}
    );

    await expect(promise).rejects.toBeInstanceOf(AlloyDbError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    await expect(promise).rejects.toThrow(/Cluster/);
  });

  test('createInstance_givenADuplicateId_reportsAlreadyExists', async () => {
    await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      { instanceType: 'PRIMARY' },
      {}
    );

    const promise = service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      { instanceType: 'PRIMARY' },
      {}
    );

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

  // AlloyDB requires instanceType at creation, so an omitted value must fail loudly
  // rather than defaulting to PRIMARY and passing locally but failing against GCP.
  test('createInstance_withoutAnInstanceType_reportsInvalidArgument', async () => {
    const promise = service.createInstance(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID, {}, {});

    await expect(promise).rejects.toBeInstanceOf(AlloyDbError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
    await expect(promise).rejects.toThrow(/instanceType is required/);
  });

  test('createInstance_acceptsAPrimaryAsTheFirstInstanceInACluster', async () => {
    const operation = await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'i1',
      { instanceType: 'PRIMARY' },
      {}
    );

    expect(instanceFromOperation(operation).instanceType).toBe(InstanceType.PRIMARY);
  });

  test('createInstance_acceptsAReadPoolOnceAPrimaryExists', async () => {
    await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'i1',
      { instanceType: 'PRIMARY' },
      {}
    );

    const operation = await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'pool1',
      { instanceType: 'READ_POOL', readPoolConfig: { nodeCount: 1 } },
      {}
    );

    expect(instanceFromOperation(operation).instanceType).toBe(InstanceType.READ_POOL);
  });

  test('createInstance_givenAReadPoolWithoutANodeCount_reportsInvalidArgument', async () => {
    await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'i1',
      { instanceType: 'PRIMARY' },
      {}
    );

    const promise = service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'pool1',
      { instanceType: 'READ_POOL' },
      {}
    );

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
    await expect(promise).rejects.toThrow(/nodeCount/);
  });

  test('createInstance_givenAReadPoolWithAZeroNodeCount_reportsInvalidArgument', async () => {
    await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'i1',
      { instanceType: 'PRIMARY' },
      {}
    );

    const promise = service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'pool1',
      { instanceType: 'READ_POOL', readPoolConfig: { nodeCount: 0 } },
      {}
    );

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('createInstance_givenASecondPrimaryInACluster_reportsFailedPrecondition', async () => {
    await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'i1',
      { instanceType: 'PRIMARY' },
      {}
    );

    const promise = service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'i2',
      { instanceType: 'PRIMARY' },
      {}
    );

    await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
    await expect(promise).rejects.toThrow(/already has a primary/);
  });

  test('createInstance_givenAReadPoolWithoutAPrimary_reportsFailedPrecondition', async () => {
    const promise = service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'pool1',
      { instanceType: 'READ_POOL', readPoolConfig: { nodeCount: 1 } },
      {}
    );

    await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
    await expect(promise).rejects.toThrow(/no primary instance/);
  });

  test('createInstance_givenASecondaryThroughTheNormalCreatePath_reportsInvalidArgument', async () => {
    const promise = service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'sec1',
      { instanceType: 'SECONDARY' },
      {}
    );

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
    await expect(promise).rejects.toThrow(/createsecondary/);
  });

  test('createInstance_withValidateOnly_persistsNothing', async () => {
    await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      { instanceType: 'PRIMARY' },
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
    await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      { instanceType: 'PRIMARY' },
      {}
    );

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
    await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'i1',
      { instanceType: 'PRIMARY' },
      {}
    );
    await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'i2',
      { instanceType: 'READ_POOL', readPoolConfig: { nodeCount: 1 } },
      {}
    );

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
    await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'i1',
      { instanceType: 'PRIMARY' },
      {}
    );
    await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'i2',
      { instanceType: 'READ_POOL', readPoolConfig: { nodeCount: 1 } },
      {}
    );

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

  // `instanceType` lives in a column rather than the spec blob, and a type-changing
  // PATCH runs the same placement rules as create — so the only legal "changes" are
  // topology-preserving, exactly as real AlloyDB treats the field.
  test('updateInstance_convertingTheOnlyPrimaryToAReadPool_reportsFailedPrecondition', async () => {
    const promise = service.updateInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      { instanceType: 'READ_POOL', readPoolConfig: { nodeCount: 1 } },
      { updateMask: 'instanceType' }
    );

    await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
    await expect(promise).rejects.toThrow(/no primary instance/);
  });

  test('updateInstance_promotingAReadPoolWhileAPrimaryExists_reportsFailedPrecondition', async () => {
    await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'pool1',
      { instanceType: 'READ_POOL', readPoolConfig: { nodeCount: 1 } },
      {}
    );

    const promise = service.updateInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'pool1',
      { instanceType: 'PRIMARY' },
      { updateMask: 'instanceType' }
    );

    await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
    await expect(promise).rejects.toThrow(/already has a primary/);
  });

  test('updateInstance_changingTheTypeToSecondary_reportsInvalidArgument', async () => {
    const promise = service.updateInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      { instanceType: 'SECONDARY' },
      { updateMask: 'instanceType' }
    );

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
    await expect(promise).rejects.toThrow(/createsecondary/);
  });

  test('updateInstance_maskingInstanceTypeWithoutABodyValue_preservesTheExistingType', async () => {
    await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'pool1',
      { instanceType: 'READ_POOL', readPoolConfig: { nodeCount: 1 } },
      {}
    );

    await service.updateInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'pool1',
      {},
      { updateMask: 'instanceType' }
    );

    expect((await service.getInstance(PROJECT, LOCATION, CLUSTER_ID, 'pool1')).instanceType).toBe(
      InstanceType.READ_POOL
    );
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
      { instanceType: 'READ_POOL', readPoolConfig: { nodeCount: 1 } },
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

  // Each PATCH rewrites the whole spec, so reading the snapshot before the lock
  // would let the second overwrite the first's unrelated field. Reading inside
  // the lock serializes them and preserves both.
  test('updateInstance_givenConcurrentPatchesToDifferentFields_preservesBoth', async () => {
    const results = await Promise.allSettled([
      service.updateInstance(
        PROJECT,
        LOCATION,
        CLUSTER_ID,
        INSTANCE_ID,
        { displayName: 'renamed' },
        { updateMask: 'displayName' }
      ),
      service.updateInstance(
        PROJECT,
        LOCATION,
        CLUSTER_ID,
        INSTANCE_ID,
        { annotations: { team: 'payments' } },
        { updateMask: 'annotations' }
      ),
    ]);

    expect(results.every(result => result.status === 'fulfilled')).toBe(true);

    const instance = await service.getInstance(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID);

    expect(instance.displayName).toBe('renamed');
    expect(instance.annotations).toEqual({ team: 'payments' });
  });
});

describe('deleteInstance', () => {
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

  // The delete counterpart of the create/update rule that a read pool needs a
  // primary: removing the primary while read pools remain would strand them.
  test('deleteInstance_ofThePrimaryWhileAReadPoolDependsOnIt_reportsFailedPrecondition', async () => {
    await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'pool1',
      { instanceType: 'READ_POOL', readPoolConfig: { nodeCount: 1 } },
      {}
    );

    const promise = service.deleteInstance(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID, {});

    await expect(promise).rejects.toBeInstanceOf(AlloyDbError);
    await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
    await expect(promise).rejects.toThrow(/read pool/);

    expect((await service.getInstance(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID)).name).toBe(
      INSTANCE_NAME
    );
  });

  test('deleteInstance_ofAReadPool_leavesThePrimaryDeletable', async () => {
    await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'pool1',
      { instanceType: 'READ_POOL', readPoolConfig: { nodeCount: 1 } },
      {}
    );

    await service.deleteInstance(PROJECT, LOCATION, CLUSTER_ID, 'pool1', {});
    const operation = await service.deleteInstance(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID, {});

    expect(operation.metadata.verb).toBe('delete');
  });
});

describe('getConnectionInfo', () => {
  test('getConnectionInfo_returnsTheSingletonSubresourceForTheInstance', async () => {
    const operation = await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      INSTANCE_ID,
      { instanceType: 'PRIMARY' },
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

describe('concurrent placement enforcement', () => {
  // Both creates race: without serialization each reads an empty topology before
  // either writes, so both would persist a PRIMARY. The cluster mutex forces the
  // second to observe the first's primary and fail.
  test('createInstance_givenTwoOverlappingPrimaryCreates_persistsOnlyOne', async () => {
    const results = await Promise.allSettled([
      service.createInstance(PROJECT, LOCATION, CLUSTER_ID, 'i1', { instanceType: 'PRIMARY' }, {}),
      service.createInstance(PROJECT, LOCATION, CLUSTER_ID, 'i2', { instanceType: 'PRIMARY' }, {}),
    ]);

    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toHaveProperty(
      'code',
      'FAILED_PRECONDITION'
    );

    const { instances: persisted } = await service.listInstances(PROJECT, LOCATION, CLUSTER_ID);

    expect(
      persisted.filter(instance => instance.instanceType === InstanceType.PRIMARY)
    ).toHaveLength(1);
  });

  // A read pool must never outlive the primary it reads from. Deleting the primary
  // while a read-pool create is mid-check would otherwise interleave into an orphan;
  // the shared cluster mutex serializes them, so the create sees no primary and fails.
  test('deleteInstance_racingAReadPoolCreate_neverLeavesAnOrphanReadPool', async () => {
    await service.createInstance(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'primary',
      { instanceType: 'PRIMARY' },
      {}
    );

    const [deletion, creation] = await Promise.allSettled([
      service.deleteInstance(PROJECT, LOCATION, CLUSTER_ID, 'primary', {}),
      service.createInstance(
        PROJECT,
        LOCATION,
        CLUSTER_ID,
        'pool1',
        { instanceType: 'READ_POOL', readPoolConfig: { nodeCount: 1 } },
        {}
      ),
    ]);

    expect(deletion.status).toBe('fulfilled');
    expect(creation.status).toBe('rejected');
    expect((creation as PromiseRejectedResult).reason).toHaveProperty(
      'code',
      'FAILED_PRECONDITION'
    );

    expect((await service.listInstances(PROJECT, LOCATION, CLUSTER_ID)).instances).toHaveLength(0);
  });
});
