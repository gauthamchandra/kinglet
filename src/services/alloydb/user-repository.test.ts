import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { ALLOYDB_USERS_TABLE, buildUserName, userRequestToRecord } from './types.ts';
import { buildUserListPrefix, UserRepository } from './user-repository.ts';

let storage: StorageManager;
let repository: UserRepository;

function userData(clusterId: string, userId: string, location = 'us-central1') {
  return userRequestToRecord(buildUserName('p', location, clusterId, userId), {});
}

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  repository = new UserRepository(storage);
  await repository.initialize();
});

test('initialize_createsTheUsersTable', async () => {
  expect(await storage.listTables()).toContain(ALLOYDB_USERS_TABLE);
});

test('buildUserListPrefix_nestsUnderTheClusterAndEndsWithASeparator', () => {
  expect(buildUserListPrefix('p', 'us-central1', 'c1')).toBe(
    'projects/p/locations/us-central1/clusters/c1/users/'
  );
});

describe('listUsers', () => {
  test('listUsers_returnsTheClustersUsersSortedByName', async () => {
    for (const userId of ['reader', 'admin']) {
      await repository.create(userData('c1', userId));
    }

    const result = await repository.listUsers('p', 'us-central1', 'c1');

    expect(result.users.map(user => user.name)).toEqual([
      buildUserName('p', 'us-central1', 'c1', 'admin'),
      buildUserName('p', 'us-central1', 'c1', 'reader'),
    ]);
  });

  test('listUsers_scopesToItsOwnClusterEvenWhenASiblingIdSharesAPrefix', async () => {
    await repository.create(userData('c1', 'admin'));
    await repository.create(userData('c10', 'admin'));

    const result = await repository.listUsers('p', 'us-central1', 'c1');

    expect(result.users.map(user => user.name)).toEqual([
      buildUserName('p', 'us-central1', 'c1', 'admin'),
    ]);
  });

  test('listUsers_propagatesPaginationToTheCaller', async () => {
    for (const userId of ['a', 'b', 'c']) {
      await repository.create(userData('c1', userId));
    }

    const firstPage = await repository.listUsers('p', 'us-central1', 'c1', 2);

    expect(firstPage.users).toHaveLength(2);
    expect(firstPage.nextPageToken).toBe('2');
  });

  test('listUsers_givenNoUsers_returnsAnEmptyList', async () => {
    expect((await repository.listUsers('p', 'us-central1', 'c1')).users).toEqual([]);
  });
});
