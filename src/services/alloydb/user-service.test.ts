import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { RoleAlreadyExistsError } from '@/shared/postgres-data-plane/data-plane-manager.ts';
import { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import { RecordingDataPlane } from '../../../test-utils/postgres-data-plane.ts';
import { ClusterRepository } from './cluster-repository.ts';
import { InstanceRepository } from './instance-repository.ts';
import {
  AlloyDbError,
  buildClusterName,
  buildDataPlaneInstanceKey,
  buildInstanceName,
  buildUserName,
  clusterRequestToRecord,
  instanceRequestToRecord,
  UserType,
} from './types.ts';
import { UserRepository } from './user-repository.ts';
import { UserService } from './user-service.ts';

const PROJECT = 'p';
const LOCATION = 'us-central1';
const CLUSTER_ID = 'c1';
const INSTANCE_ID = 'i1';
const USER_ID = 'admin';
const USER_NAME = buildUserName(PROJECT, LOCATION, CLUSTER_ID, USER_ID);
const INSTANCE_KEY = buildDataPlaneInstanceKey(LOCATION, CLUSTER_ID, INSTANCE_ID);

async function addAnotherInstance(): Promise<void> {
  await instances.create(
    instanceRequestToRecord(buildInstanceName(PROJECT, LOCATION, CLUSTER_ID, 'i2'), {
      instanceType: 'PRIMARY',
    })
  );
}

function failUpsertOnCall(which: number): void {
  let seen = 0;

  dataPlane.upsertUser = async (project, instance, user) => {
    dataPlane.calls.push(`upsertUser:${project}/${instance}:${user.name}`);
    seen += 1;

    if (seen === which) throw new Error('read pool down');
  };
}

function failDropOnCall(which: number): void {
  let seen = 0;

  dataPlane.dropUser = async (project, instance, userName) => {
    dataPlane.calls.push(`dropUser:${project}/${instance}:${userName}`);
    seen += 1;

    if (seen === which) throw new Error('read pool down');
  };
}

let storage: StorageManager;
let clusters: ClusterRepository;
let instances: InstanceRepository;
let users: UserRepository;
let service: UserService;
let dataPlane: RecordingDataPlane;

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  clusters = new ClusterRepository(storage);
  instances = new InstanceRepository(storage);
  users = new UserRepository(storage);

  await Promise.all([clusters.initialize(), instances.initialize(), users.initialize()]);

  dataPlane = new RecordingDataPlane({ port: 5540 });
  service = new UserService(users, clusters, new ResourceMutex(), dataPlane, instances);

  await clusters.create(
    clusterRequestToRecord(buildClusterName(PROJECT, LOCATION, CLUSTER_ID), {
      initialUser: { user: 'postgres' },
    })
  );

  await instances.create(
    instanceRequestToRecord(buildInstanceName(PROJECT, LOCATION, CLUSTER_ID, INSTANCE_ID), {
      instanceType: 'PRIMARY',
    })
  );
});

describe('createUser', () => {
  /**
   * <b>IMPORTANT:</b> unlike every cluster and instance mutation, `users.create`
   * declares `User` as its response, not `Operation`. Wrapping it in an LRO would
   * break any real client, so this is asserted explicitly.
   */
  test('createUser_returnsTheUserItselfRatherThanALongRunningOperation', async () => {
    const user = await service.createUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID, {}, {});

    expect(user.name).toBe(USER_NAME);
    expect(user.userType).toBe(UserType.ALLOYDB_BUILT_IN);
    expect(user).not.toHaveProperty('metadata');
    expect(user).not.toHaveProperty('done');
  });

  test('createUser_retainsDatabaseRolesAndUserType', async () => {
    const user = await service.createUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { databaseRoles: ['pg_read_all_data'], userType: 'ALLOYDB_IAM_USER' },
      {}
    );

    expect(user.databaseRoles).toEqual(['pg_read_all_data']);
    expect(user.userType).toBe(UserType.ALLOYDB_IAM_USER);
  });

  test('createUser_returnsDatabaseRolesSortedAlphabetically', async () => {
    const user = await service.createUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { databaseRoles: ['pg_write_all_data', 'alloydbsuperuser', 'pg_read_all_data'] },
      {}
    );

    expect(user.databaseRoles).toEqual([
      'alloydbsuperuser',
      'pg_read_all_data',
      'pg_write_all_data',
    ]);
    expect((await service.getUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID)).databaseRoles).toEqual([
      'alloydbsuperuser',
      'pg_read_all_data',
      'pg_write_all_data',
    ]);
  });

  // `User.password` is input-only in the discovery document: stored for
  // data-plane auth, never returned.
  test('createUser_storesThePasswordWithoutEchoingIt', async () => {
    const user = await service.createUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { password: 'hunter2' },
      {}
    );

    expect(user).not.toHaveProperty('password');
    expect(JSON.stringify(user)).not.toContain('hunter2');

    const stored = await users.getByName(buildUserName(PROJECT, LOCATION, CLUSTER_ID, USER_ID));

    expect(stored?.password).toBe('hunter2');
  });

  test('createUser_underAMissingCluster_reportsNotFoundForTheCluster', async () => {
    const promise = service.createUser(PROJECT, LOCATION, 'missing', USER_ID, {}, {});

    await expect(promise).rejects.toBeInstanceOf(AlloyDbError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    await expect(promise).rejects.toThrow(/Cluster/);
  });

  test('createUser_givenADuplicateId_reportsAlreadyExists', async () => {
    await service.createUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID, {}, {});

    const promise = service.createUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID, {}, {});

    await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
  });

  test.each([
    '',
    'has/slash',
    'a'.repeat(64),
    `${'a'.repeat(62)}é`,
    'kinglet_admin',
    'cloudsqlsuperuser',
    'pg_monitor',
  ])('createUser_givenTheUnusableUserId_%p_reportsInvalidArgument', async userId => {
    const promise = service.createUser(PROJECT, LOCATION, CLUSTER_ID, userId, {}, {});

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('createUser_givenAnUnknownUserType_reportsInvalidArgument', async () => {
    const promise = service.createUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { userType: 'NOT_A_TYPE' },
      {}
    );

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('createUser_withValidateOnly_persistsNothing', async () => {
    const user = await service.createUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      {},
      {
        validateOnly: true,
      }
    );

    expect(user.name).toBe(USER_NAME);
    await expect(service.getUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID)).rejects.toHaveProperty(
      'code',
      'NOT_FOUND'
    );
  });

  test('createUser_callsUpsertUserForEachRunningInstance', async () => {
    await service.createUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID, { password: 'hunter2' }, {});

    expect(dataPlane.calls).toContain(`upsertUser:${PROJECT}/${INSTANCE_KEY}:${USER_ID}`);
  });

  test('createUser_withValidateOnly_doesNotCallDataPlane', async () => {
    await service.createUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { password: 'hunter2' },
      { validateOnly: true }
    );

    expect(dataPlane.calls).toHaveLength(0);
  });

  test('createUser_whenUpsertFails_rollsBackTheRow', async () => {
    dataPlane.upsertFailure = new Error('data plane unavailable');

    const promise = service.createUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { password: 'hunter2' },
      {}
    );

    await expect(promise).rejects.toBeInstanceOf(AlloyDbError);
    await expect(service.getUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID)).rejects.toHaveProperty(
      'code',
      'NOT_FOUND'
    );
  });

  test('createUser_whenALaterInstanceFails_dropsTheRoleItAlreadyCreated', async () => {
    await addAnotherInstance();
    failUpsertOnCall(2);

    const promise = service.createUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { password: 'hunter2' },
      {}
    );

    await expect(promise).rejects.toBeInstanceOf(AlloyDbError);
    await expect(service.getUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID)).rejects.toHaveProperty(
      'code',
      'NOT_FOUND'
    );

    const created = dataPlane.calls.find(call => call.startsWith('upsertUser:')) ?? '';

    expect(created.startsWith('upsertUser:')).toBe(true);
    expect(dataPlane.calls).toContain(created.replace('upsertUser:', 'dropUser:'));
  });

  test('createUser_whenASqlRoleAlreadyExists_doesNotDropThatRole', async () => {
    await addAnotherInstance();

    let seen = 0;

    dataPlane.upsertUser = async (project, instance, user) => {
      dataPlane.calls.push(`upsertUser:${project}/${instance}:${user.name}`);
      seen += 1;

      if (seen === 2) throw new RoleAlreadyExistsError(user.name);
    };

    const promise = service.createUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { password: 'hunter2' },
      {}
    );

    await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
    await expect(service.getUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID)).rejects.toHaveProperty(
      'code',
      'NOT_FOUND'
    );

    const upserts = dataPlane.calls.filter(call => call.startsWith('upsertUser:'));
    const drops = dataPlane.calls.filter(call => call.startsWith('dropUser:'));
    const created = upserts[0] ?? '';

    expect(upserts).toHaveLength(2);
    expect(created.startsWith('upsertUser:')).toBe(true);
    expect(drops).toEqual([created.replace('upsertUser:', 'dropUser:')]);
  });
});

describe('getUser', () => {
  test('getUser_returnsTheUser', async () => {
    await service.createUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID, {}, {});

    expect((await service.getUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID)).name).toBe(USER_NAME);
  });

  test('getUser_givenAnUnknownUser_reportsNotFound', async () => {
    const promise = service.getUser(PROJECT, LOCATION, CLUSTER_ID, 'missing');

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });
});

describe('listUsers', () => {
  test('listUsers_returnsTheClustersUsers', async () => {
    await service.createUser(PROJECT, LOCATION, CLUSTER_ID, 'admin', {}, {});
    await service.createUser(PROJECT, LOCATION, CLUSTER_ID, 'reader', {}, {});

    const result = await service.listUsers(PROJECT, LOCATION, CLUSTER_ID);

    expect(result.users.map(user => user.name)).toEqual([
      buildUserName(PROJECT, LOCATION, CLUSTER_ID, 'admin'),
      buildUserName(PROJECT, LOCATION, CLUSTER_ID, 'reader'),
    ]);
  });

  test('listUsers_underAMissingCluster_reportsNotFound', async () => {
    const promise = service.listUsers(PROJECT, LOCATION, 'missing');

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('listUsers_propagatesPagination', async () => {
    await service.createUser(PROJECT, LOCATION, CLUSTER_ID, 'a', {}, {});
    await service.createUser(PROJECT, LOCATION, CLUSTER_ID, 'b', {}, {});

    const result = await service.listUsers(PROJECT, LOCATION, CLUSTER_ID, 1);

    expect(result.users).toHaveLength(1);
    expect(result.nextPageToken).toBe('1');
  });

  test('listUsers_neverEchoesPasswords', async () => {
    await service.createUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID, { password: 'hunter2' }, {});

    expect(JSON.stringify(await service.listUsers(PROJECT, LOCATION, CLUSTER_ID))).not.toContain(
      'hunter2'
    );
  });
});

describe('updateUser', () => {
  beforeEach(async () => {
    await service.createUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { databaseRoles: ['original'] },
      {}
    );
  });

  test('updateUser_returnsTheUpdatedUserRatherThanAnOperation', async () => {
    const user = await service.updateUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { databaseRoles: ['pg_monitor'] },
      { updateMask: 'databaseRoles' }
    );

    expect(user.databaseRoles).toEqual(['pg_monitor']);
    expect(user).not.toHaveProperty('done');
  });

  test('updateUser_canChangeTheUserType', async () => {
    const user = await service.updateUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { userType: 'ALLOYDB_IAM_USER' },
      { updateMask: 'userType' }
    );

    expect(user.userType).toBe(UserType.ALLOYDB_IAM_USER);
  });

  test('updateUser_maskingUserTypeWithoutABodyValue_preservesTheExistingType', async () => {
    await service.updateUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { userType: 'ALLOYDB_IAM_USER' },
      { updateMask: 'userType' }
    );

    const user = await service.updateUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      {},
      { updateMask: 'userType' }
    );

    expect(user.userType).toBe(UserType.ALLOYDB_IAM_USER);
  });

  test('updateUser_givenAMaskNamingTheOutputOnlyName_reportsInvalidArgument', async () => {
    const promise = service.updateUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { name: 'spoofed' },
      { updateMask: 'name' }
    );

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('updateUser_givenAnUnknownUser_reportsNotFound', async () => {
    const promise = service.updateUser(PROJECT, LOCATION, CLUSTER_ID, 'missing', {}, {});

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('updateUser_givenAnUnknownUserAndAllowMissing_createsIt', async () => {
    const user = await service.updateUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      'fresh',
      {},
      {
        allowMissing: true,
      }
    );

    expect(user.name).toBe(buildUserName(PROJECT, LOCATION, CLUSTER_ID, 'fresh'));
    expect((await service.getUser(PROJECT, LOCATION, CLUSTER_ID, 'fresh')).name).toBe(user.name);
  });

  test('updateUser_withValidateOnly_persistsNothing', async () => {
    await service.updateUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { databaseRoles: ['not-applied'] },
      { updateMask: 'databaseRoles', validateOnly: true }
    );

    expect((await service.getUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID)).databaseRoles).toEqual([
      'original',
    ]);
  });

  /**
   * An empty stored password makes the wire server accept the user without one,
   * so a mask that names `password` without supplying one must leave the secret
   * alone rather than clear it — otherwise a metadata PATCH turns an
   * authenticated instance into an open one.
   */
  test('updateUser_maskingPasswordWithoutSupplyingOne_leavesTheStoredSecretIntact', async () => {
    await service.updateUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { password: 'hunter2' },
      { updateMask: 'password' }
    );

    await service.updateUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { databaseRoles: ['pg_read_all_data'] },
      { updateMask: 'password,databaseRoles' }
    );

    expect(
      (await users.getByName(buildUserName(PROJECT, LOCATION, CLUSTER_ID, USER_ID)))?.password
    ).toBe('hunter2');
  });

  test('updateUser_storesAPasswordSuppliedInThePatchWithoutEchoingIt', async () => {
    const user = await service.updateUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { password: 'hunter2' },
      { updateMask: 'password' }
    );

    expect(JSON.stringify(user)).not.toContain('hunter2');
    expect(
      (await users.getByName(buildUserName(PROJECT, LOCATION, CLUSTER_ID, USER_ID)))?.password
    ).toBe('hunter2');
  });

  test('updateUser_whenPasswordChanges_callsUpsertUserOnEachInstance', async () => {
    dataPlane.calls.length = 0;

    await service.updateUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { password: 'new-pass' },
      { updateMask: 'password' }
    );

    expect(dataPlane.calls).toContain(`upsertUser:${PROJECT}/${INSTANCE_KEY}:${USER_ID}`);
  });

  test('updateUser_whenUpsertFails_restoresPasswordAndOtherFields', async () => {
    await addAnotherInstance();
    dataPlane.calls.length = 0;
    failUpsertOnCall(2);

    const promise = service.updateUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { password: 'new-pass', databaseRoles: ['pg_read_all_data'] },
      { updateMask: 'password,databaseRoles' }
    );

    await expect(promise).rejects.toBeInstanceOf(AlloyDbError);

    const stored = await users.getByName(USER_NAME);

    expect(stored?.password).toBe('');
    expect((await service.getUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID)).databaseRoles).toEqual([
      'original',
    ]);

    const applied = dataPlane.calls.filter(call => call.startsWith('upsertUser:'));

    expect(applied.length).toBeGreaterThanOrEqual(3);
    expect(applied[0]).toBe(applied[2]);
  });

  test('updateUser_withValidateOnly_doesNotCallDataPlane', async () => {
    dataPlane.calls.length = 0;

    await service.updateUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { password: 'new-pass' },
      { updateMask: 'password', validateOnly: true }
    );

    expect(dataPlane.calls).toHaveLength(0);
  });
});

describe('deleteUser', () => {
  beforeEach(async () => {
    await service.createUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID, {}, {});
  });

  test('deleteUser_removesTheUser', async () => {
    await service.deleteUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID, {});

    await expect(service.getUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID)).rejects.toHaveProperty(
      'code',
      'NOT_FOUND'
    );
  });

  test('deleteUser_givenAnUnknownUser_reportsNotFound', async () => {
    const promise = service.deleteUser(PROJECT, LOCATION, CLUSTER_ID, 'missing', {});

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('deleteUser_withValidateOnly_leavesTheUserInPlace', async () => {
    await service.deleteUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID, { validateOnly: true });

    expect((await service.getUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID)).name).toBe(USER_NAME);
  });

  test('deleteUser_callsDropUserOnEachInstance', async () => {
    dataPlane.calls.length = 0;

    await service.deleteUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID, {});

    expect(dataPlane.calls).toContain(`dropUser:${PROJECT}/${INSTANCE_KEY}:${USER_ID}`);
  });

  test('deleteUser_whenDropFails_restoresTheRowAndTheRoleAlreadyDropped', async () => {
    await addAnotherInstance();
    dataPlane.calls.length = 0;
    failDropOnCall(2);

    const promise = service.deleteUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID, {});

    await expect(promise).rejects.toBeInstanceOf(AlloyDbError);
    expect((await service.getUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID)).name).toBe(USER_NAME);

    const dropped = dataPlane.calls.find(call => call.startsWith('dropUser:')) ?? '';

    expect(dropped.startsWith('dropUser:')).toBe(true);
    expect(dataPlane.calls).toContain(dropped.replace('dropUser:', 'upsertUser:'));
  });

  test('deleteUser_whenDropFails_restoredRowCanStillBeUpdated', async () => {
    failDropOnCall(1);

    const promise = service.deleteUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID, {});

    await expect(promise).rejects.toBeInstanceOf(AlloyDbError);

    await service.updateUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { password: 'after-rollback' },
      { updateMask: 'password' }
    );

    expect((await users.getByName(USER_NAME))?.password).toBe('after-rollback');
  });

  test('deleteUser_withValidateOnly_doesNotCallDataPlane', async () => {
    dataPlane.calls.length = 0;

    await service.deleteUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID, { validateOnly: true });

    expect(dataPlane.calls).toHaveLength(0);
  });
});

describe('READ_POOL instances are skipped when applying users', () => {
  const READ_POOL_ID = 'pool-1';
  const READ_POOL_KEY = buildDataPlaneInstanceKey(LOCATION, CLUSTER_ID, READ_POOL_ID);

  beforeEach(async () => {
    await instances.create(
      instanceRequestToRecord(buildInstanceName(PROJECT, LOCATION, CLUSTER_ID, READ_POOL_ID), {
        instanceType: 'READ_POOL',
        readPoolConfig: { nodeCount: 1 },
      })
    );

    await service.createUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID, { password: 'pw' }, {});

    dataPlane.calls.length = 0;
  });

  test('createUser_doesNotCallUpsertUserOnReadPoolInstances', async () => {
    await service.createUser(PROJECT, LOCATION, CLUSTER_ID, 'newuser', { password: 'pw' }, {});

    expect(dataPlane.calls.some(c => c.startsWith(`upsertUser:${PROJECT}/${READ_POOL_KEY}`))).toBe(
      false
    );
    expect(dataPlane.calls.some(c => c.startsWith(`upsertUser:${PROJECT}/${INSTANCE_KEY}`))).toBe(
      true
    );
  });

  test('deleteUser_doesNotCallDropUserOnReadPoolInstances', async () => {
    await service.deleteUser(PROJECT, LOCATION, CLUSTER_ID, USER_ID, {});

    expect(dataPlane.calls.some(c => c.startsWith(`dropUser:${PROJECT}/${READ_POOL_KEY}`))).toBe(
      false
    );
    expect(dataPlane.calls.some(c => c.startsWith(`dropUser:${PROJECT}/${INSTANCE_KEY}`))).toBe(
      true
    );
  });
});
