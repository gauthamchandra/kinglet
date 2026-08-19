import { beforeEach, describe, expect, test } from 'bun:test';
import { OperationsStore } from '@/core/operations/operations-store.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { ClusterRepository } from './cluster-repository.ts';
import { ClusterService } from './cluster-service.ts';
import { InstanceRepository } from './instance-repository.ts';
import {
  ALLOYDB_OPERATIONS_TABLE,
  AlloyDbError,
  buildClusterName,
  buildInstanceName,
  buildUserName,
  ClusterState,
  ClusterType,
  instanceRequestToRecord,
  userRequestToRecord,
} from './types.ts';
import { UserRepository } from './user-repository.ts';

const PROJECT = 'p';
const LOCATION = 'us-central1';
const CLUSTER_ID = 'c1';
const CLUSTER_NAME = buildClusterName(PROJECT, LOCATION, CLUSTER_ID);

const VALID_BODY = {
  initialUser: { user: 'postgres', password: 'hunter2' },
  networkConfig: { network: 'projects/p/global/networks/default' },
};

let storage: StorageManager;
let clusters: ClusterRepository;
let instances: InstanceRepository;
let users: UserRepository;
let service: ClusterService;

function clusterFromOperation(operation: { response?: Record<string, unknown> }) {
  return operation.response as Record<string, unknown>;
}

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  clusters = new ClusterRepository(storage);
  instances = new InstanceRepository(storage);
  users = new UserRepository(storage);

  const operations = new OperationsStore(storage, {
    tableName: ALLOYDB_OPERATIONS_TABLE,
    apiTypePrefix: 'google.cloud.alloydb.v1',
  });

  await Promise.all([
    clusters.initialize(),
    instances.initialize(),
    users.initialize(),
    operations.initialize(),
  ]);

  service = new ClusterService(clusters, instances, users, operations);
});

describe('createCluster', () => {
  test('createCluster_returnsACompletedOperationCarryingTheNewCluster', async () => {
    const operation = await service.createCluster(PROJECT, LOCATION, CLUSTER_ID, VALID_BODY, {});

    expect(operation.done).toBe(true);
    expect(operation.metadata.verb).toBe('create');
    expect(operation.metadata.target).toBe(CLUSTER_NAME);

    const cluster = clusterFromOperation(operation);

    expect(cluster.name).toBe(CLUSTER_NAME);
    expect(cluster.state).toBe(ClusterState.READY);
    expect(cluster.clusterType).toBe(ClusterType.PRIMARY);
    expect(cluster['@type']).toBe('type.googleapis.com/google.cloud.alloydb.v1.Cluster');
  });

  test('createCluster_persistsTheCluster', async () => {
    await service.createCluster(PROJECT, LOCATION, CLUSTER_ID, VALID_BODY, {});

    expect((await service.getCluster(PROJECT, LOCATION, CLUSTER_ID)).name).toBe(CLUSTER_NAME);
  });

  /**
   * `Cluster.initialUser` is documented "Input only… Required", so omitting it
   * must fail rather than quietly produce a cluster with no way in.
   */
  test('createCluster_withoutAnInitialUser_reportsInvalidArgument', async () => {
    const promise = service.createCluster(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      { networkConfig: { network: 'projects/p/global/networks/default' } },
      {}
    );

    await expect(promise).rejects.toBeInstanceOf(AlloyDbError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
    await expect(promise).rejects.toThrow(/initialUser/);
  });

  test('createCluster_withAnInitialUserMissingItsUsername_reportsInvalidArgument', async () => {
    const promise = service.createCluster(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      {
        initialUser: { password: 'hunter2' },
        networkConfig: { network: 'projects/p/global/networks/default' },
      },
      {}
    );

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test.each([
    'MyCluster',
    'c_1',
    '',
    'a'.repeat(64),
  ])('createCluster_givenTheMalformedClusterId_%p_reportsInvalidArgument', async clusterId => {
    const promise = service.createCluster(PROJECT, LOCATION, clusterId, VALID_BODY, {});

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('createCluster_givenADuplicateId_reportsAlreadyExists', async () => {
    await service.createCluster(PROJECT, LOCATION, CLUSTER_ID, VALID_BODY, {});

    const promise = service.createCluster(PROJECT, LOCATION, CLUSTER_ID, VALID_BODY, {});

    await expect(promise).rejects.toBeInstanceOf(AlloyDbError);
    await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
  });

  /**
   * Silently ignoring `validateOnly` would make a dry-run call create a real
   * cluster — a fidelity bug that actively damages the caller's state rather
   * than merely omitting a feature.
   */
  test('createCluster_withValidateOnly_persistsNothing', async () => {
    const operation = await service.createCluster(PROJECT, LOCATION, CLUSTER_ID, VALID_BODY, {
      validateOnly: true,
    });

    expect(operation.done).toBe(true);
    await expect(service.getCluster(PROJECT, LOCATION, CLUSTER_ID)).rejects.toHaveProperty(
      'code',
      'NOT_FOUND'
    );
  });

  test('createCluster_withValidateOnly_stillRejectsAnInvalidRequest', async () => {
    const promise = service.createCluster(PROJECT, LOCATION, 'BadId', VALID_BODY, {
      validateOnly: true,
    });

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('createCluster_withValidateOnly_doesNotRecordAnOperationEither', async () => {
    await service.createCluster(PROJECT, LOCATION, CLUSTER_ID, VALID_BODY, { validateOnly: true });

    expect(await storage.count(ALLOYDB_OPERATIONS_TABLE)).toBe(0);
  });

  test('createCluster_neverEchoesTheInitialUserPassword', async () => {
    const operation = await service.createCluster(PROJECT, LOCATION, CLUSTER_ID, VALID_BODY, {});

    expect(JSON.stringify(operation)).not.toContain('hunter2');
  });
});

describe('getCluster', () => {
  test('getCluster_returnsTheClusterResponse', async () => {
    await service.createCluster(PROJECT, LOCATION, CLUSTER_ID, VALID_BODY, {});

    const cluster = await service.getCluster(PROJECT, LOCATION, CLUSTER_ID);

    expect(cluster.name).toBe(CLUSTER_NAME);
    expect(cluster.reconciling).toBe(false);
  });

  test('getCluster_givenAnUnknownCluster_reportsNotFound', async () => {
    const promise = service.getCluster(PROJECT, LOCATION, 'missing');

    await expect(promise).rejects.toBeInstanceOf(AlloyDbError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });
});

describe('listClusters', () => {
  test('listClusters_returnsClusterResponsesForTheLocation', async () => {
    await service.createCluster(PROJECT, LOCATION, 'c1', VALID_BODY, {});
    await service.createCluster(PROJECT, LOCATION, 'c2', VALID_BODY, {});

    const result = await service.listClusters(PROJECT, LOCATION);

    expect(result.clusters.map(cluster => cluster.name)).toEqual([
      buildClusterName(PROJECT, LOCATION, 'c1'),
      buildClusterName(PROJECT, LOCATION, 'c2'),
    ]);
    expect(result.nextPageToken).toBeUndefined();
  });

  test('listClusters_propagatesPagination', async () => {
    await service.createCluster(PROJECT, LOCATION, 'c1', VALID_BODY, {});
    await service.createCluster(PROJECT, LOCATION, 'c2', VALID_BODY, {});

    const result = await service.listClusters(PROJECT, LOCATION, 1);

    expect(result.clusters).toHaveLength(1);
    expect(result.nextPageToken).toBe('1');
  });

  test('listClusters_neverEchoesInitialUserPasswords', async () => {
    await service.createCluster(PROJECT, LOCATION, 'c1', VALID_BODY, {});

    expect(JSON.stringify(await service.listClusters(PROJECT, LOCATION))).not.toContain('hunter2');
  });
});

describe('updateCluster', () => {
  beforeEach(async () => {
    await service.createCluster(PROJECT, LOCATION, CLUSTER_ID, VALID_BODY, {});
  });

  test('updateCluster_appliesTheMaskedFieldAndReturnsAnOperation', async () => {
    const operation = await service.updateCluster(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      { displayName: 'renamed' },
      { updateMask: 'displayName' }
    );

    expect(operation.metadata.verb).toBe('update');
    expect(clusterFromOperation(operation).displayName).toBe('renamed');
    expect((await service.getCluster(PROJECT, LOCATION, CLUSTER_ID)).displayName).toBe('renamed');
  });

  test('updateCluster_leavesFieldsOutsideTheMaskUntouched', async () => {
    await service.updateCluster(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      { displayName: 'first', labels: { keep: 'me' } },
      {}
    );

    await service.updateCluster(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      { displayName: 'second', labels: { ignored: 'yes' } },
      { updateMask: 'displayName' }
    );

    const cluster = await service.getCluster(PROJECT, LOCATION, CLUSTER_ID);

    expect(cluster.displayName).toBe('second');
    expect(cluster.labels).toEqual({ keep: 'me' });
  });

  /**
   * FieldMask semantics (AIP-134): a field named in the mask but absent from the
   * body is cleared, not ignored.
   */
  test('updateCluster_givenAMaskedFieldAbsentFromTheBody_clearsIt', async () => {
    await service.updateCluster(PROJECT, LOCATION, CLUSTER_ID, { displayName: 'named' }, {});
    await service.updateCluster(PROJECT, LOCATION, CLUSTER_ID, {}, { updateMask: 'displayName' });

    expect(await service.getCluster(PROJECT, LOCATION, CLUSTER_ID)).not.toHaveProperty(
      'displayName'
    );
  });

  test('updateCluster_givenAMaskNamingAnOutputOnlyField_reportsInvalidArgument', async () => {
    const promise = service.updateCluster(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      { state: 'FAILED' },
      { updateMask: 'state' }
    );

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('updateCluster_givenTheWildcardMask_reportsInvalidArgument', async () => {
    const promise = service.updateCluster(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      { displayName: 'x' },
      { updateMask: '*' }
    );

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('updateCluster_withoutAMask_ignoresOutputOnlyFieldsInTheBody', async () => {
    await service.updateCluster(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      { displayName: 'renamed', state: 'FAILED', uid: 'spoofed' },
      {}
    );

    const cluster = await service.getCluster(PROJECT, LOCATION, CLUSTER_ID);

    expect(cluster.displayName).toBe('renamed');
    expect(cluster.state).toBe(ClusterState.READY);
    expect(cluster.uid).not.toBe('spoofed');
  });

  test('updateCluster_advancesUpdateTimeButNotCreateTime', async () => {
    const before = await service.getCluster(PROJECT, LOCATION, CLUSTER_ID);

    await Bun.sleep(2);
    await service.updateCluster(PROJECT, LOCATION, CLUSTER_ID, { displayName: 'x' }, {});

    const after = await service.getCluster(PROJECT, LOCATION, CLUSTER_ID);

    expect(after.createTime).toBe(before.createTime);
    expect(Date.parse(after.updateTime)).toBeGreaterThan(Date.parse(before.updateTime));
  });

  test('updateCluster_givenAnUnknownCluster_reportsNotFound', async () => {
    const promise = service.updateCluster(PROJECT, LOCATION, 'missing', { displayName: 'x' }, {});

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // `allowMissing` is documented as "update succeeds even if cluster is not
  // found. In that case, a new cluster is created."
  test('updateCluster_givenAnUnknownClusterAndAllowMissing_createsIt', async () => {
    const operation = await service.updateCluster(PROJECT, LOCATION, 'fresh', VALID_BODY, {
      allowMissing: true,
    });

    expect(clusterFromOperation(operation).name).toBe(buildClusterName(PROJECT, LOCATION, 'fresh'));
    expect((await service.getCluster(PROJECT, LOCATION, 'fresh')).state).toBe(ClusterState.READY);
  });

  test('updateCluster_withValidateOnly_persistsNothing', async () => {
    await service.updateCluster(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      { displayName: 'not-applied' },
      { updateMask: 'displayName', validateOnly: true }
    );

    expect(await service.getCluster(PROJECT, LOCATION, CLUSTER_ID)).not.toHaveProperty(
      'displayName'
    );
  });
});

describe('deleteCluster', () => {
  beforeEach(async () => {
    await service.createCluster(PROJECT, LOCATION, CLUSTER_ID, VALID_BODY, {});
  });

  test('deleteCluster_removesTheClusterAndReturnsAnOperation', async () => {
    const operation = await service.deleteCluster(PROJECT, LOCATION, CLUSTER_ID, {});

    expect(operation.metadata.verb).toBe('delete');
    expect(operation.done).toBe(true);
    // A delete LRO has no resource to hand back.
    expect(operation).not.toHaveProperty('response');
    await expect(service.getCluster(PROJECT, LOCATION, CLUSTER_ID)).rejects.toHaveProperty(
      'code',
      'NOT_FOUND'
    );
  });

  test('deleteCluster_givenAnUnknownCluster_reportsNotFound', async () => {
    const promise = service.deleteCluster(PROJECT, LOCATION, 'missing', {});

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  /**
   * `force` is documented as "Whether to cascade delete child instances for given
   * cluster", so without it a cluster that still has instances must be refused
   * rather than silently orphaning them.
   */
  test('deleteCluster_withChildInstancesAndNoForce_reportsFailedPrecondition', async () => {
    await instances.create(
      instanceRequestToRecord(buildInstanceName(PROJECT, LOCATION, CLUSTER_ID, 'i1'), {})
    );

    const promise = service.deleteCluster(PROJECT, LOCATION, CLUSTER_ID, {});

    await expect(promise).rejects.toBeInstanceOf(AlloyDbError);
    await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
    expect((await service.getCluster(PROJECT, LOCATION, CLUSTER_ID)).name).toBe(CLUSTER_NAME);
  });

  test('deleteCluster_withForce_cascadesToChildInstancesAndUsers', async () => {
    await instances.create(
      instanceRequestToRecord(buildInstanceName(PROJECT, LOCATION, CLUSTER_ID, 'i1'), {})
    );
    await users.create(
      userRequestToRecord(buildUserName(PROJECT, LOCATION, CLUSTER_ID, 'admin'), {})
    );

    await service.deleteCluster(PROJECT, LOCATION, CLUSTER_ID, { force: true });

    expect((await instances.listInstances(PROJECT, LOCATION, CLUSTER_ID)).instances).toEqual([]);
    expect((await users.listUsers(PROJECT, LOCATION, CLUSTER_ID)).users).toEqual([]);
  });

  /**
   * A cluster's users cannot outlive it, so they are removed even without
   * `force` — `force` only governs whether child *instances* block the delete.
   */
  test('deleteCluster_withoutForceButWithUsersOnly_succeedsAndRemovesThoseUsers', async () => {
    await users.create(
      userRequestToRecord(buildUserName(PROJECT, LOCATION, CLUSTER_ID, 'admin'), {})
    );

    await service.deleteCluster(PROJECT, LOCATION, CLUSTER_ID, {});

    expect((await users.listUsers(PROJECT, LOCATION, CLUSTER_ID)).users).toEqual([]);
  });

  test('deleteCluster_doesNotTouchAnotherClustersChildren', async () => {
    await service.createCluster(PROJECT, LOCATION, 'c2', VALID_BODY, {});
    await instances.create(
      instanceRequestToRecord(buildInstanceName(PROJECT, LOCATION, 'c2', 'i1'), {})
    );

    await service.deleteCluster(PROJECT, LOCATION, CLUSTER_ID, { force: true });

    expect((await instances.listInstances(PROJECT, LOCATION, 'c2')).instances).toHaveLength(1);
  });

  test('deleteCluster_withValidateOnly_leavesTheClusterInPlace', async () => {
    await service.deleteCluster(PROJECT, LOCATION, CLUSTER_ID, { validateOnly: true });

    expect((await service.getCluster(PROJECT, LOCATION, CLUSTER_ID)).name).toBe(CLUSTER_NAME);
  });

  test('deleteCluster_withValidateOnlyAndChildInstances_stillReportsFailedPrecondition', async () => {
    await instances.create(
      instanceRequestToRecord(buildInstanceName(PROJECT, LOCATION, CLUSTER_ID, 'i1'), {})
    );

    const promise = service.deleteCluster(PROJECT, LOCATION, CLUSTER_ID, { validateOnly: true });

    await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
  });
});

describe('rotating the initial user', () => {
  beforeEach(async () => {
    await service.createCluster(PROJECT, LOCATION, CLUSTER_ID, VALID_BODY, {});
  });

  /**
   * `initialUser` is writable, so it can be PATCHed — but it is still input-only
   * on the way out, so neither the new username nor either password may appear in
   * a response.
   */
  test('updateCluster_patchingInitialUser_neverLeaksTheNewOrOldPassword', async () => {
    const operation = await service.updateCluster(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      { initialUser: { user: 'rotated', password: 'brand-new-secret' } },
      { updateMask: 'initialUser' }
    );

    expect(JSON.stringify(operation)).not.toContain('brand-new-secret');
    expect(JSON.stringify(operation)).not.toContain('hunter2');
    expect(clusterFromOperation(operation)).not.toHaveProperty('initialUser');

    const cluster = await service.getCluster(PROJECT, LOCATION, CLUSTER_ID);

    expect(cluster).not.toHaveProperty('initialUser');
    expect(JSON.stringify(cluster)).not.toContain('brand-new-secret');
  });

  test('updateCluster_patchingInitialUserWithoutAUsername_clearsTheStoredUsername', async () => {
    await service.updateCluster(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      { initialUser: { password: 'no-username-here' } },
      { updateMask: 'initialUser' }
    );

    const stored = await clusters.getByName(CLUSTER_NAME);

    expect(stored?.initialUserName).toBeNull();
  });

  test('updateCluster_patchingInitialUser_recordsTheNewUsernameForTheDataPlane', async () => {
    await service.updateCluster(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      { initialUser: { user: 'rotated', password: 'x' } },
      { updateMask: 'initialUser' }
    );

    const stored = await clusters.getByName(CLUSTER_NAME);

    expect(stored?.initialUserName).toBe('rotated');
  });
});

describe('network configuration validation', () => {
  /**
   * `Cluster.network` is documented "Required… This is required to create a
   * cluster. Deprecated, use network_config.network instead." Requiring the
   * deprecated field alone would reject valid modern requests, so any one of the
   * three legitimate shapes is accepted and only a cluster with no networking at
   * all is refused. Flagged in the PR as inferred from the field descriptions
   * rather than stated outright.
   */
  test('createCluster_withoutAnyNetworkConfiguration_reportsInvalidArgument', async () => {
    const promise = service.createCluster(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      { initialUser: { user: 'postgres' } },
      {}
    );

    await expect(promise).rejects.toBeInstanceOf(AlloyDbError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
    await expect(promise).rejects.toThrow(/network/i);
  });

  test('createCluster_withTheDeprecatedNetworkField_isAccepted', async () => {
    const operation = await service.createCluster(
      PROJECT,
      LOCATION,
      'legacy-network',
      { initialUser: { user: 'postgres' }, network: 'projects/p/global/networks/default' },
      {}
    );

    expect(operation.done).toBe(true);
  });

  test('createCluster_withNetworkConfigNetwork_isAccepted', async () => {
    const operation = await service.createCluster(
      PROJECT,
      LOCATION,
      'modern-network',
      {
        initialUser: { user: 'postgres' },
        networkConfig: { network: 'projects/p/global/networks/default' },
      },
      {}
    );

    expect(operation.done).toBe(true);
  });

  // A PSC-only cluster reaches clients through Private Service Connect and has
  // no VPC network of its own.
  test('createCluster_withPscConfigAndNoNetwork_isAccepted', async () => {
    const operation = await service.createCluster(
      PROJECT,
      LOCATION,
      'psc-only',
      { initialUser: { user: 'postgres' }, pscConfig: { pscEnabled: true } },
      {}
    );

    expect(operation.done).toBe(true);
  });
});
