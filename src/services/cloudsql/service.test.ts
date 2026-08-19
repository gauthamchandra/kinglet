/**
 * Tests for SqlAdminService
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { CloudSqlRepository } from './repository.ts';
import { SqlAdminError, SqlAdminService } from './service.ts';

describe('SqlAdminService', () => {
  let repo: CloudSqlRepository;
  let service: SqlAdminService;

  beforeEach(async () => {
    const storage = new StorageManager();

    await storage.initialize({ type: 'memory' });
    repo = new CloudSqlRepository(storage);
    await repo.initialize();

    service = new SqlAdminService(repo);
  });

  describe('createInstance', () => {
    test('returns a DONE CREATE operation', async () => {
      const op = await service.createInstance('p1', {
        name: 'db-a',
        databaseVersion: 'POSTGRES_16',
      });

      expect(op.kind).toBe('sql#operation');
      expect(op.operationType).toBe('CREATE');
      expect(op.status).toBe('DONE');
      expect(op.targetId).toBe('db-a');
      expect(op.targetProject).toBe('p1');
    });

    test('seeds the default postgres database and user records', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });

      const databases = await repo.listDatabases('p1', 'db-a');
      const users = await repo.listUsers('p1', 'db-a');

      expect(databases.map(d => d.name)).toEqual(['postgres']);
      expect(users.map(u => u.name)).toEqual(['postgres']);
    });

    test('stores the rootPassword on the seeded postgres user', async () => {
      await service.createInstance('p1', {
        name: 'db-a',
        databaseVersion: 'POSTGRES_16',
        rootPassword: 'hunter2',
      });

      const rootUser = await repo.getUser('p1', 'db-a', 'postgres');

      expect(rootUser?.password).toBe('hunter2');
    });

    test('rejects MySQL with INVALID_ARGUMENT', async () => {
      const promise = service.createInstance('p1', {
        name: 'db-a',
        databaseVersion: 'MYSQL_8_0',
      });

      await expect(promise).rejects.toBeInstanceOf(SqlAdminError);
      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
    });

    test('rejects an invalid instance name with INVALID_ARGUMENT', async () => {
      const promise = service.createInstance('p1', {
        name: '1-bad-name',
        databaseVersion: 'POSTGRES_16',
      });

      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
    });

    test('rejects a duplicate instance with ALREADY_EXISTS', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });

      const promise = service.createInstance('p1', {
        name: 'db-a',
        databaseVersion: 'POSTGRES_16',
      });

      await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
    });
  });

  describe('getInstance / listInstances', () => {
    test('getInstance returns the sql#instance resource', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });

      const instance = await service.getInstance('p1', 'db-a');

      expect(instance.kind).toBe('sql#instance');
      expect(instance.state).toBe('RUNNABLE');
      expect(instance.connectionName).toBe('p1:us-central1:db-a');
      expect(instance.settings.settingsVersion).toBe(1);
    });

    test('getInstance throws NOT_FOUND for a missing instance', async () => {
      const promise = service.getInstance('p1', 'nope');

      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });

    test('listInstances returns items and honors maxResults', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
      await service.createInstance('p1', { name: 'db-b', databaseVersion: 'POSTGRES_16' });

      const page = await service.listInstances('p1', 1);

      expect(page.items).toHaveLength(1);
      expect(page.nextPageToken).toBe('1');
    });
  });

  describe('updateInstance / patchInstance', () => {
    test('update requires a matching settings.settingsVersion', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });

      const promise = service.updateInstance('p1', 'db-a', {
        settings: { settingsVersion: 99, tier: 'db-custom-2-8192' },
      });

      await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
    });

    test('update with the correct settingsVersion bumps it and returns UPDATE op', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });

      const op = await service.updateInstance('p1', 'db-a', {
        settings: { settingsVersion: 1, tier: 'db-custom-2-8192' },
      });

      expect(op.operationType).toBe('UPDATE');

      const instance = await service.getInstance('p1', 'db-a');

      expect(instance.settings.settingsVersion).toBe(2);
      expect(instance.settings.tier).toBe('db-custom-2-8192');
    });

    test('patch merges settings without requiring settingsVersion', async () => {
      await service.createInstance('p1', {
        name: 'db-a',
        databaseVersion: 'POSTGRES_16',
        settings: { tier: 'db-custom-1-3840' },
      });

      await service.patchInstance('p1', 'db-a', {
        settings: { availabilityType: 'ZONAL' },
      });

      const instance = await service.getInstance('p1', 'db-a');

      expect(instance.settings.tier).toBe('db-custom-1-3840');
      expect(instance.settings.availabilityType).toBe('ZONAL');
      expect(instance.settings.settingsVersion).toBe(2);
    });
  });

  describe('deleteInstance / restartInstance', () => {
    test('delete removes the instance and returns DELETE op', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });

      const op = await service.deleteInstance('p1', 'db-a');

      expect(op.operationType).toBe('DELETE');
      expect(await repo.getInstance('p1', 'db-a')).toBeNull();
    });

    test('delete of a missing instance throws NOT_FOUND', async () => {
      await expect(service.deleteInstance('p1', 'nope')).rejects.toHaveProperty(
        'code',
        'NOT_FOUND'
      );
    });

    test('restart validates existence and returns RESTART op', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });

      const op = await service.restartInstance('p1', 'db-a');

      expect(op.operationType).toBe('RESTART');
      expect(op.status).toBe('DONE');
    });

    test('restart of a missing instance throws NOT_FOUND', async () => {
      await expect(service.restartInstance('p1', 'nope')).rejects.toHaveProperty(
        'code',
        'NOT_FOUND'
      );
    });
  });

  describe('operations', () => {
    test('getOperation returns a recorded operation by name', async () => {
      const created = await service.createInstance('p1', {
        name: 'db-a',
        databaseVersion: 'POSTGRES_16',
      });

      const fetched = await service.getOperation('p1', created.name);

      expect(fetched.name).toBe(created.name);
      expect(fetched.status).toBe('DONE');
    });

    test('getOperation throws NOT_FOUND for an unknown name', async () => {
      await expect(service.getOperation('p1', 'nope')).rejects.toHaveProperty('code', 'NOT_FOUND');
    });

    test('listOperations filters by instance', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
      await service.createInstance('p1', { name: 'db-b', databaseVersion: 'POSTGRES_16' });

      const filtered = await service.listOperations('p1', 'db-a');

      expect(filtered.items).toHaveLength(1);
      expect(filtered.items[0]?.targetId).toBe('db-a');
    });
  });

  describe('createInstance fix', () => {
    test('strips kind and settingsVersion from initial settings', async () => {
      await service.createInstance('p1', {
        name: 'db-a',
        databaseVersion: 'POSTGRES_16',
        settings: { kind: 'sql#settings', settingsVersion: 999, tier: 'db-custom-1-3840' },
      });

      const instance = await service.getInstance('p1', 'db-a');

      expect(instance.settings.settingsVersion).toBe(1);
      expect(instance.settings.tier).toBe('db-custom-1-3840');
    });
  });

  describe('databases', () => {
    beforeEach(async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
    });

    test('createDatabase returns CREATE_DATABASE op and record is listable', async () => {
      const op = await service.createDatabase('p1', 'db-a', { name: 'appdb' });

      expect(op.operationType).toBe('CREATE_DATABASE');
      expect(op.status).toBe('DONE');

      const list = await service.listDatabases('p1', 'db-a');

      expect(list.items.map(d => d.name)).toEqual(['appdb', 'postgres']);
      expect(Object.keys(list)).not.toContain('nextPageToken');
    });

    test('createDatabase on a missing instance throws NOT_FOUND', async () => {
      const promise = service.createDatabase('p1', 'nope', { name: 'appdb' });

      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });

    test('duplicate database throws ALREADY_EXISTS', async () => {
      await service.createDatabase('p1', 'db-a', { name: 'appdb' });

      const promise = service.createDatabase('p1', 'db-a', { name: 'appdb' });

      await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
    });

    test('getDatabase returns the sql#database resource', async () => {
      await service.createDatabase('p1', 'db-a', { name: 'appdb', charset: 'UTF8' });

      const database = await service.getDatabase('p1', 'db-a', 'appdb');

      expect(database.kind).toBe('sql#database');
      expect(database.charset).toBe('UTF8');
    });

    test('updateDatabase changes collation and returns UPDATE_DATABASE op', async () => {
      await service.createDatabase('p1', 'db-a', { name: 'appdb' });

      const op = await service.updateDatabase('p1', 'db-a', 'appdb', { collation: 'C' });

      expect(op.operationType).toBe('UPDATE_DATABASE');

      const database = await service.getDatabase('p1', 'db-a', 'appdb');

      expect(database.collation).toBe('C');
    });

    test('deleteDatabase removes the record and returns DELETE_DATABASE op', async () => {
      await service.createDatabase('p1', 'db-a', { name: 'appdb' });

      const op = await service.deleteDatabase('p1', 'db-a', 'appdb');

      expect(op.operationType).toBe('DELETE_DATABASE');
      await expect(service.getDatabase('p1', 'db-a', 'appdb')).rejects.toHaveProperty(
        'code',
        'NOT_FOUND'
      );
    });
  });

  describe('users', () => {
    beforeEach(async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
    });

    test('createUser returns CREATE_USER op and user appears without password', async () => {
      const op = await service.createUser('p1', 'db-a', { name: 'app', password: 's3cret' });

      expect(op.operationType).toBe('CREATE_USER');

      const list = await service.listUsers('p1', 'db-a');
      const created = list.items.find(u => u.name === 'app');

      expect(created?.kind).toBe('sql#user');
      expect(JSON.stringify(list)).not.toContain('s3cret');
    });

    test('updateUser resolves the user from body.name when query name is absent', async () => {
      await service.createUser('p1', 'db-a', { name: 'app' });

      const op = await service.updateUser('p1', 'db-a', undefined, undefined, {
        name: 'app',
        password: 'newpass',
      });

      expect(op.operationType).toBe('UPDATE_USER');
    });

    test('updateUser with neither query nor body name throws INVALID_ARGUMENT', async () => {
      const promise = service.updateUser('p1', 'db-a', undefined, undefined, {
        password: 'x',
      });

      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
    });

    test('deleteUser removes the user and returns DELETE_USER op', async () => {
      await service.createUser('p1', 'db-a', { name: 'app' });

      const op = await service.deleteUser('p1', 'db-a', 'app');

      expect(op.operationType).toBe('DELETE_USER');

      const list = await service.listUsers('p1', 'db-a');

      expect(list.items.find(u => u.name === 'app')).toBeUndefined();
    });

    test('deleteUser without a name throws INVALID_ARGUMENT', async () => {
      await expect(service.deleteUser('p1', 'db-a', undefined)).rejects.toHaveProperty(
        'code',
        'INVALID_ARGUMENT'
      );
    });

    test('getUser throws NOT_FOUND for a missing user', async () => {
      await expect(service.getUser('p1', 'db-a', 'ghost')).rejects.toHaveProperty(
        'code',
        'NOT_FOUND'
      );
    });
  });
});
