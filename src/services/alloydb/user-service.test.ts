import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { ClusterRepository } from './cluster-repository.ts';
import {
  ALLOYDB_USERS_TABLE,
  AlloyDbError,
  buildClusterName,
  buildUserName,
  clusterRequestToRecord,
  UserType,
} from './types.ts';
import { UserRepository } from './user-repository.ts';
import { UserService } from './user-service.ts';

const PROJECT = 'p';
const LOCATION = 'us-central1';
const CLUSTER_ID = 'c1';
const USER_ID = 'admin';
const USER_NAME = buildUserName(PROJECT, LOCATION, CLUSTER_ID, USER_ID);

let storage: StorageManager;
let clusters: ClusterRepository;
let users: UserRepository;
let service: UserService;

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  clusters = new ClusterRepository(storage);
  users = new UserRepository(storage);

  await Promise.all([clusters.initialize(), users.initialize()]);

  service = new UserService(users, clusters);

  await clusters.create(
    clusterRequestToRecord(buildClusterName(PROJECT, LOCATION, CLUSTER_ID), {
      initialUser: { user: 'postgres' },
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

  // `User.password` is input-only in the discovery document.
  test('createUser_neverEchoesThePasswordItWasGiven', async () => {
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
    expect(JSON.stringify(await storage.find(ALLOYDB_USERS_TABLE, {}))).not.toContain('hunter2');
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

  test('updateUser_neverEchoesAPasswordSuppliedInThePatch', async () => {
    const user = await service.updateUser(
      PROJECT,
      LOCATION,
      CLUSTER_ID,
      USER_ID,
      { password: 'hunter2' },
      { updateMask: 'password' }
    );

    expect(JSON.stringify(user)).not.toContain('hunter2');
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
});
