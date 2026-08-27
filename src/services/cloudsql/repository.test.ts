/**
 * Tests for CloudSqlRepository
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { CloudSqlRepository } from './repository.ts';
import type { SqlInstanceRecord } from './types.ts';

function makeInstanceData(
  overrides: Partial<Omit<SqlInstanceRecord, keyof BaseRecord>> = {}
): Omit<SqlInstanceRecord, keyof BaseRecord> {
  return {
    project: 'test-project',
    name: 'my-instance',
    region: 'us-central1',
    databaseVersion: 'POSTGRES_16',
    state: 'RUNNABLE',
    settings: JSON.stringify({}),
    settingsVersion: 1,
    createTime: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('CloudSqlRepository', () => {
  let storage: StorageManager;
  let repo: CloudSqlRepository;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new CloudSqlRepository(storage);
    await repo.initialize();
  });

  describe('instances', () => {
    test('createInstance then getInstance round-trips', async () => {
      await repo.createInstance(makeInstanceData());

      const found = await repo.getInstance('test-project', 'my-instance');

      expect(found).not.toBeNull();
      expect(found?.databaseVersion).toBe('POSTGRES_16');
      expect(found?.state).toBe('RUNNABLE');
    });

    test('createInstance rejects a duplicate project+name', async () => {
      await repo.createInstance(makeInstanceData());

      const promise = repo.createInstance(makeInstanceData());

      await expect(promise).rejects.toBeInstanceOf(Error);
    });

    test('same instance name in another project is allowed', async () => {
      await repo.createInstance(makeInstanceData());

      const other = await repo.createInstance(makeInstanceData({ project: 'other-project' }));

      expect(other.project).toBe('other-project');
    });

    test('listInstances paginates with integer-offset tokens', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.createInstance(makeInstanceData({ name: `inst-${i}` }));
      }

      const page1 = await repo.listInstances('test-project', 2);

      expect(page1.instances).toHaveLength(2);
      expect(page1.nextPageToken).toBe('2');

      const page2 = await repo.listInstances('test-project', 2, page1.nextPageToken);

      expect(page2.instances).toHaveLength(2);
      expect(page2.instances[0]?.name).not.toBe(page1.instances[0]?.name);
    });

    test('listInstances resets to the first page for a malformed or negative token', async () => {
      for (let i = 0; i < 3; i++) {
        await repo.createInstance(makeInstanceData({ name: `inst-${i}` }));
      }

      const firstPage = await repo.listInstances('test-project', 2);

      for (const token of ['not-a-number', '-5']) {
        const page = await repo.listInstances('test-project', 2, token);

        expect(page.instances.map(i => i.name)).toEqual(firstPage.instances.map(i => i.name));
      }
    });

    test('deleteInstance cascades database and user records', async () => {
      await repo.createInstance(makeInstanceData());
      await repo.createDatabase({
        project: 'test-project',
        instance: 'my-instance',
        name: 'appdb',
        charset: 'UTF8',
        collation: 'en_US.UTF8',
      });
      await repo.createUser({
        project: 'test-project',
        instance: 'my-instance',
        name: 'app-user',
        host: '',
        type: 'BUILT_IN',
        password: '',
      });

      const deleted = await repo.deleteInstance('test-project', 'my-instance');

      expect(deleted).toBe(true);
      expect(await repo.listDatabases('test-project', 'my-instance')).toHaveLength(0);
      expect(await repo.listUsers('test-project', 'my-instance')).toHaveLength(0);
    });

    test('deleteInstance returns false for a missing instance', async () => {
      expect(await repo.deleteInstance('test-project', 'nope')).toBe(false);
    });

    test('updateInstance updates and returns the modified record', async () => {
      const created = await repo.createInstance(makeInstanceData());

      const updated = await repo.updateInstance('test-project', 'my-instance', {
        settingsVersion: 2,
        settings: JSON.stringify({ backup: true }),
      });

      expect(updated).not.toBeNull();
      expect(updated?.settingsVersion).toBe(2);
      expect(updated?.settings).toBe(JSON.stringify({ backup: true }));
      expect(updated?.id).toBe(created.id);
    });

    test('updateInstance returns null for a missing instance', async () => {
      const updated = await repo.updateInstance('test-project', 'nope', {
        settingsVersion: 2,
      });

      expect(updated).toBeNull();
    });
  });

  describe('databases', () => {
    test('createDatabase rejects a duplicate identity', async () => {
      const data = {
        project: 'test-project',
        instance: 'my-instance',
        name: 'appdb',
        charset: 'UTF8',
        collation: 'en_US.UTF8',
      };

      await repo.createDatabase(data);

      await expect(repo.createDatabase(data)).rejects.toBeInstanceOf(Error);
    });

    test('updateDatabase updates and returns the modified record', async () => {
      const created = await repo.createDatabase({
        project: 'test-project',
        instance: 'my-instance',
        name: 'appdb',
        charset: 'UTF8',
        collation: 'en_US.UTF8',
      });

      const updated = await repo.updateDatabase('test-project', 'my-instance', 'appdb', {
        collation: 'en_US.UTF16',
      });

      expect(updated).not.toBeNull();
      expect(updated?.collation).toBe('en_US.UTF16');
      expect(updated?.id).toBe(created.id);
    });

    test('updateDatabase returns null for a missing database', async () => {
      const updated = await repo.updateDatabase('test-project', 'my-instance', 'nope', {
        collation: 'en_US.UTF16',
      });

      expect(updated).toBeNull();
    });

    test('deleteDatabase returns true and removes the record', async () => {
      await repo.createDatabase({
        project: 'test-project',
        instance: 'my-instance',
        name: 'appdb',
        charset: 'UTF8',
        collation: 'en_US.UTF8',
      });

      const deleted = await repo.deleteDatabase('test-project', 'my-instance', 'appdb');

      expect(deleted).toBe(true);
      const found = await repo.getDatabase('test-project', 'my-instance', 'appdb');
      expect(found).toBeNull();
    });

    test('deleteDatabase returns false for a missing database', async () => {
      const deleted = await repo.deleteDatabase('test-project', 'my-instance', 'nope');

      expect(deleted).toBe(false);
    });
  });

  describe('users', () => {
    test('getUser without host matches by name', async () => {
      await repo.createUser({
        project: 'test-project',
        instance: 'my-instance',
        name: 'app-user',
        host: '%',
        type: 'BUILT_IN',
        password: '',
      });

      const found = await repo.getUser('test-project', 'my-instance', 'app-user');

      expect(found?.host).toBe('%');
    });

    test('updateUser updates and returns the modified record', async () => {
      const created = await repo.createUser({
        project: 'test-project',
        instance: 'my-instance',
        name: 'app-user',
        host: '%',
        type: 'BUILT_IN',
        password: 'secret',
      });

      const updated = await repo.updateUser('test-project', 'my-instance', 'app-user', '%', {
        password: 'newsecret',
      });

      expect(updated).not.toBeNull();
      expect(updated?.password).toBe('newsecret');
      expect(updated?.id).toBe(created.id);
    });

    test('updateUser returns null for a missing user', async () => {
      const updated = await repo.updateUser('test-project', 'my-instance', 'nope', '%', {
        password: 'newsecret',
      });

      expect(updated).toBeNull();
    });

    test('deleteUser returns true and removes the record', async () => {
      await repo.createUser({
        project: 'test-project',
        instance: 'my-instance',
        name: 'app-user',
        host: '%',
        type: 'BUILT_IN',
        password: 'secret',
      });

      const deleted = await repo.deleteUser('test-project', 'my-instance', 'app-user', '%');

      expect(deleted).toBe(true);
      const found = await repo.getUser('test-project', 'my-instance', 'app-user', '%');
      expect(found).toBeNull();
    });

    test('deleteUser returns false for a missing user', async () => {
      const deleted = await repo.deleteUser('test-project', 'my-instance', 'nope', '%');

      expect(deleted).toBe(false);
    });

    test('host-disambiguation: multiple users with same name but different hosts', async () => {
      // Create two users with the same name but different hosts
      await repo.createUser({
        project: 'test-project',
        instance: 'my-instance',
        name: 'shared-user',
        host: '%',
        type: 'BUILT_IN',
        password: 'pass1',
      });

      await repo.createUser({
        project: 'test-project',
        instance: 'my-instance',
        name: 'shared-user',
        host: '10.0.0.1',
        type: 'BUILT_IN',
        password: 'pass2',
      });

      // getUser with explicit host returns exactly that user
      const found1 = await repo.getUser('test-project', 'my-instance', 'shared-user', '%');
      expect(found1?.host).toBe('%');
      expect(found1?.password).toBe('pass1');

      const found2 = await repo.getUser('test-project', 'my-instance', 'shared-user', '10.0.0.1');
      expect(found2?.host).toBe('10.0.0.1');
      expect(found2?.password).toBe('pass2');

      // updateUser with explicit host updates only that user
      await repo.updateUser('test-project', 'my-instance', 'shared-user', '%', {
        password: 'updated1',
      });

      const afterUpdate1 = await repo.getUser('test-project', 'my-instance', 'shared-user', '%');
      expect(afterUpdate1?.password).toBe('updated1');

      const afterUpdate2 = await repo.getUser(
        'test-project',
        'my-instance',
        'shared-user',
        '10.0.0.1'
      );
      expect(afterUpdate2?.password).toBe('pass2');

      // deleteUser with explicit host deletes only that user
      const deleted = await repo.deleteUser('test-project', 'my-instance', 'shared-user', '%');
      expect(deleted).toBe(true);

      const stillExists = await repo.getUser(
        'test-project',
        'my-instance',
        'shared-user',
        '10.0.0.1'
      );
      expect(stillExists?.host).toBe('10.0.0.1');

      const doesNotExist = await repo.getUser('test-project', 'my-instance', 'shared-user', '%');
      expect(doesNotExist).toBeNull();
    });
  });

  describe('operations', () => {
    test('listOperations filters by instance and paginates', async () => {
      for (let i = 0; i < 3; i++) {
        await repo.createOperation({
          project: 'test-project',
          name: `op-${i}`,
          operationType: 'CREATE',
          status: 'DONE',
          targetId: i === 0 ? 'other-instance' : 'my-instance',
          insertTime: '2026-08-18T00:00:00.000Z',
          startTime: '2026-08-18T00:00:00.000Z',
          endTime: '2026-08-18T00:00:00.000Z',
        });
      }

      const filtered = await repo.listOperations('test-project', 'my-instance');

      expect(filtered.operations).toHaveLength(2);

      const paged = await repo.listOperations('test-project', undefined, 2);

      expect(paged.operations).toHaveLength(2);
      expect(paged.nextPageToken).toBe('2');
    });

    test('getOperation round-trips: found and returns null for unknown', async () => {
      const created = await repo.createOperation({
        project: 'test-project',
        name: 'op-test',
        operationType: 'CREATE',
        status: 'DONE',
        targetId: 'my-instance',
        insertTime: '2026-08-18T00:00:00.000Z',
        startTime: '2026-08-18T00:00:00.000Z',
        endTime: '2026-08-18T00:00:00.000Z',
      });

      const found = await repo.getOperation('test-project', 'op-test');

      expect(found).not.toBeNull();
      expect(found?.name).toBe('op-test');
      expect(found?.operationType).toBe('CREATE');
      expect(found?.id).toBe(created.id);

      const notFound = await repo.getOperation('test-project', 'nonexistent');

      expect(notFound).toBeNull();
    });
  });
});
