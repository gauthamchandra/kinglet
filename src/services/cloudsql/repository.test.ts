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
  });
});
