/**
 * Tests for SqlAdminService
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import type { DataPlaneLogin } from '@/shared/postgres-data-plane/data-plane-manager.ts';
import { DatabaseFlagError } from '@/shared/postgres-data-plane/data-plane-manager.ts';
import { RecordingDataPlane } from '../../../test-utils/postgres-data-plane.ts';
import { CloudSqlRepository } from './repository.ts';
import { SqlAdminError, SqlAdminService } from './service.ts';

/** Pauses the first restore of `app` so a user change can try to land mid-restart. */
class PausingDataPlane extends RecordingDataPlane {
  gate: Promise<void> = Promise.resolve();
  entered: (() => void) | undefined;

  override async upsertUser(
    project: string,
    instance: string,
    user: DataPlaneLogin
  ): Promise<void> {
    this.calls.push(`upsertUser:${project}/${instance}:${user.name}:${user.password ?? ''}`);

    if (user.name === 'app' && this.entered != null) {
      const entered = this.entered;

      this.entered = undefined;
      entered();
      await this.gate;
    }

    if (this.upsertFailure) throw this.upsertFailure;
  }
}

describe('SqlAdminService', () => {
  let repo: CloudSqlRepository;
  let service: SqlAdminService;
  let dataPlane: RecordingDataPlane;

  beforeEach(async () => {
    const storage = new StorageManager();

    await storage.initialize({ type: 'memory' });
    repo = new CloudSqlRepository(storage);
    await repo.initialize();

    dataPlane = new RecordingDataPlane();
    service = new SqlAdminService(repo, dataPlane);
  });

  describe('data plane', () => {
    test('starts an instance endpoint with its default database on create', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });

      expect(dataPlane.calls).toEqual(['start:p1/db-a:postgres', 'upsertUser:p1/db-a:postgres']);
    });

    test('deletes the instance data when the instance is deleted', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
      await service.deleteInstance('p1', 'db-a');

      expect(dataPlane.calls).toContain('drop:p1/db-a');
    });

    test('restarts the endpoint with every database the instance has', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
      await service.createDatabase('p1', 'db-a', { name: 'app' });
      dataPlane.calls.length = 0;

      await service.restartInstance('p1', 'db-a');

      expect(dataPlane.calls).toEqual([
        'restart:p1/db-a:app,postgres',
        'upsertUser:p1/db-a:postgres',
      ]);
    });

    test('restart reapplies a password saved while the server was down', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
      await service.createUser('p1', 'db-a', { name: 'app', password: 's3cret' });
      dataPlane.calls.length = 0;

      await service.restartInstance('p1', 'db-a');

      expect(dataPlane.calls).toEqual([
        'restart:p1/db-a:postgres',
        'upsertUser:p1/db-a:app',
        'upsertUser:p1/db-a:postgres',
      ]);
    });

    test('restart does not put back a password a concurrent update replaced', async () => {
      const pausing = new PausingDataPlane();
      const racing = new SqlAdminService(repo, pausing);

      await racing.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
      await racing.createUser('p1', 'db-a', { name: 'app', password: 's3cret' });
      pausing.calls.length = 0;

      let release = (): void => {};
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      let markEntered = (): void => {};
      const entered = new Promise<void>(resolve => {
        markEntered = resolve;
      });

      pausing.gate = gate;
      pausing.entered = markEntered;

      const restarting = racing.restartInstance('p1', 'db-a');

      await entered;

      const updating = racing.updateUser('p1', 'db-a', 'postgres', undefined, {
        name: 'postgres',
        password: 'next',
      });

      await Bun.sleep(20);
      expect(pausing.calls.some(call => call.endsWith('postgres:next'))).toBe(false);
      release();
      await restarting;
      await updating;
      expect(pausing.calls.at(-1)).toBe('upsertUser:p1/db-a:postgres:next');
      expect((await repo.getUser('p1', 'db-a', 'postgres'))?.password).toBe('next');
    });

    test('restart does not recreate a user deleted while roles are restored', async () => {
      const pausing = new PausingDataPlane();
      const racing = new SqlAdminService(repo, pausing);

      await racing.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
      await racing.createUser('p1', 'db-a', { name: 'app', password: 's3cret' });
      pausing.calls.length = 0;

      let release = (): void => {};
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      let markEntered = (): void => {};
      const entered = new Promise<void>(resolve => {
        markEntered = resolve;
      });

      pausing.gate = gate;
      pausing.entered = markEntered;

      const restarting = racing.restartInstance('p1', 'db-a');

      await entered;

      const deleting = racing.deleteUser('p1', 'db-a', 'postgres');

      await Bun.sleep(20);
      expect(pausing.calls).not.toContain('dropUser:p1/db-a:postgres');
      release();
      await restarting;
      await deleting;
      expect(pausing.calls.at(-1)).toBe('dropUser:p1/db-a:postgres');
      expect(await repo.getUser('p1', 'db-a', 'postgres')).toBeNull();
    });

    test('opens and drops a database alongside its control-plane record', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
      await service.createDatabase('p1', 'db-a', { name: 'app' });
      await service.deleteDatabase('p1', 'db-a', 'app');

      expect(dataPlane.calls).toContain('openDatabase:p1/db-a/app');
      expect(dataPlane.calls).toContain('dropDatabase:p1/db-a/app');
    });

    /**
     * Real Cloud SQL reports a provisioning failure on the operation, not on the
     * insert call — so this resolves, and the failure is the operation's `error`.
     */
    test('reports a data plane that fails to start on the operation and leaves no instance behind', async () => {
      dataPlane.startFailure = new Error('no free ports');

      const operation = await service.createInstance('p1', {
        name: 'db-a',
        databaseVersion: 'POSTGRES_16',
      });

      expect(operation.status).toBe('DONE');
      expect(operation.error).toEqual({
        kind: 'sql#operationErrors',
        errors: [
          {
            kind: 'sql#operationError',
            code: 'INTERNAL_ERROR',
            message: expect.stringContaining('no free ports'),
          },
        ],
      });
      expect(await repo.getInstance('p1', 'db-a')).toBeNull();
      expect(await repo.listDatabases('p1', 'db-a')).toEqual([]);
      expect(await repo.listUsers('p1', 'db-a')).toEqual([]);
    });

    test('runs without a data plane when none is injected', async () => {
      const controlPlaneOnly = new SqlAdminService(repo);
      const operation = await controlPlaneOnly.createInstance('p1', {
        name: 'db-a',
        databaseVersion: 'POSTGRES_16',
      });

      expect(operation.status).toBe('DONE');
    });
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

    test('update (PUT) replaces settings entirely, dropping keys omitted from the request', async () => {
      await service.createInstance('p1', {
        name: 'db-a',
        databaseVersion: 'POSTGRES_16',
        settings: { tier: 'db-custom-1-3840', availabilityType: 'ZONAL' },
      });

      const op = await service.updateInstance('p1', 'db-a', {
        settings: { settingsVersion: 1, tier: 'db-custom-2-8192' },
      });

      expect(op.operationType).toBe('UPDATE');

      const instance = await service.getInstance('p1', 'db-a');

      expect(instance.settings.tier).toBe('db-custom-2-8192');
      expect(instance.settings.availabilityType).toBeUndefined();
      expect(instance.settings.settingsVersion).toBe(2);
    });

    test('update (PUT) without a settings object throws INVALID_ARGUMENT', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });

      const promise = service.updateInstance('p1', 'db-a', {});

      await expect(promise).rejects.toBeInstanceOf(SqlAdminError);
      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
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

    test('patch with a mismatched settingsVersion throws FAILED_PRECONDITION', async () => {
      await service.createInstance('p1', {
        name: 'db-a',
        databaseVersion: 'POSTGRES_16',
        settings: { tier: 'db-custom-1-3840' },
      });

      const promise = service.patchInstance('p1', 'db-a', {
        settings: { settingsVersion: 99, availabilityType: 'ZONAL' },
      });

      await expect(promise).rejects.toBeInstanceOf(SqlAdminError);
      await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
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

    test('createDatabase rejects a name postgres would truncate and stores nothing', async () => {
      const name = `${'a'.repeat(63)}b`;
      dataPlane.calls.length = 0;

      const promise = service.createDatabase('p1', 'db-a', { name });

      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
      expect(await repo.getDatabase('p1', 'db-a', name)).toBeNull();
      expect(dataPlane.calls.some(call => call.includes(name))).toBe(false);
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

    test('deleteDatabase keeps the record when the data plane cannot drop it', async () => {
      await service.createDatabase('p1', 'db-a', { name: 'appdb' });
      dataPlane.dropDatabaseFailure = new Error('not running');

      const promise = service.deleteDatabase('p1', 'db-a', 'appdb');

      await expect(promise).rejects.toThrow('not running');
      await expect(promise).rejects.toHaveProperty('code', 'INTERNAL');
      expect(await repo.getDatabase('p1', 'db-a', 'appdb')).not.toBeNull();
    });
  });

  describe('users', () => {
    beforeEach(async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
    });

    test('createUser upserts the role after the user row is stored', async () => {
      await service.createUser('p1', 'db-a', { name: 'app', password: 's3cret' });

      const start = dataPlane.calls.indexOf('start:p1/db-a:postgres');
      const upsert = dataPlane.calls.indexOf('upsertUser:p1/db-a:app');

      expect(start).toBeGreaterThanOrEqual(0);
      expect(upsert).toBeGreaterThan(start);
    });

    test('updateUser upserts the role only when the password changes', async () => {
      await service.createUser('p1', 'db-a', { name: 'app', password: 's3cret' });
      dataPlane.calls.length = 0;

      await service.updateUser('p1', 'db-a', 'app', undefined, { name: 'app' });

      expect(dataPlane.calls).not.toContain('upsertUser:p1/db-a:app');

      await service.updateUser('p1', 'db-a', 'app', undefined, {
        name: 'app',
        password: 'next',
      });

      expect(dataPlane.calls).toContain('upsertUser:p1/db-a:app');
    });

    test('deleteUser drops the role after the user row is gone', async () => {
      await service.createUser('p1', 'db-a', { name: 'app', password: 's3cret' });

      await service.deleteUser('p1', 'db-a', 'app');

      const drop = dataPlane.calls.indexOf('dropUser:p1/db-a:app');

      expect(drop).toBeGreaterThanOrEqual(0);
      expect(await repo.getUser('p1', 'db-a', 'app')).toBeNull();
    });

    test('createUser rejects a name postgres would truncate and stores nothing', async () => {
      const name = `${'a'.repeat(63)}b`;
      dataPlane.calls.length = 0;

      const promise = service.createUser('p1', 'db-a', { name, password: 's3cret' });

      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
      expect(await repo.getUser('p1', 'db-a', name)).toBeNull();
      expect(dataPlane.calls.some(call => call.includes(name))).toBe(false);
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

    test('updateUser falls back to body.host when the query host is absent', async () => {
      await service.createUser('p1', 'db-a', {
        name: 'app',
        host: '10.0.0.1',
        password: 'orig-2',
      });

      await service.updateUser('p1', 'db-a', undefined, undefined, {
        name: 'app',
        host: '10.0.0.1',
        password: 'x',
      });

      expect((await repo.getUser('p1', 'db-a', 'app', '10.0.0.1'))?.password).toBe('x');
    });

    test('createUser rejects a second host for the same role name', async () => {
      await service.createUser('p1', 'db-a', { name: 'app', host: '%', password: 'orig-1' });
      dataPlane.calls.length = 0;

      await expect(
        service.createUser('p1', 'db-a', { name: 'app', host: '10.0.0.1', password: 'orig-2' })
      ).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
      expect(await repo.getUser('p1', 'db-a', 'app', '10.0.0.1')).toBeNull();
      expect(dataPlane.calls).not.toContain('upsertUser:p1/db-a:app');
    });

    test('deleteUser keeps the role while another host record still uses it', async () => {
      await service.createUser('p1', 'db-a', { name: 'app', host: '%', password: 'orig-1' });
      await repo.createUser({
        project: 'p1',
        instance: 'db-a',
        name: 'app',
        host: '10.0.0.1',
        type: 'BUILT_IN',
        password: 'orig-2',
      });
      dataPlane.calls.length = 0;

      await service.deleteUser('p1', 'db-a', 'app', '%');

      expect(dataPlane.calls).not.toContain('dropUser:p1/db-a:app');
      expect(await repo.getUser('p1', 'db-a', 'app', '10.0.0.1')).not.toBeNull();

      await service.deleteUser('p1', 'db-a', 'app', '10.0.0.1');

      expect(dataPlane.calls).toContain('dropUser:p1/db-a:app');
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

    test('createUser rejects a reserved role and stores nothing', async () => {
      const promise = service.createUser('p1', 'db-a', {
        name: 'kinglet_admin',
        password: 'x',
      });

      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
      expect(await repo.getUser('p1', 'db-a', 'kinglet_admin')).toBeNull();
    });

    test('createUser removes the row when the role cannot be created', async () => {
      dataPlane.upsertFailure = new Error('role name is reserved');

      const promise = service.createUser('p1', 'db-a', { name: 'app', password: 'x' });

      await expect(promise).rejects.toThrow('reserved');
      await expect(promise).rejects.toHaveProperty('code', 'INTERNAL');
      expect(await repo.getUser('p1', 'db-a', 'app')).toBeNull();
    });

    test('updateUser restores the previous password when the role cannot be changed', async () => {
      await service.createUser('p1', 'db-a', { name: 'app', password: 's3cret' });
      dataPlane.upsertFailure = new Error('role update failed');

      const promise = service.updateUser('p1', 'db-a', 'app', undefined, {
        name: 'app',
        password: 'next',
      });

      await expect(promise).rejects.toThrow('role update failed');
      await expect(promise).rejects.toHaveProperty('code', 'INTERNAL');
      expect((await repo.getUser('p1', 'db-a', 'app'))?.password).toBe('s3cret');
    });

    test('deleteUser restores the row when the role cannot be dropped', async () => {
      await service.createUser('p1', 'db-a', { name: 'app', password: 'x' });
      dataPlane.dropUserFailure = new Error('still logged in');

      const promise = service.deleteUser('p1', 'db-a', 'app');

      await expect(promise).rejects.toThrow('still logged in');
      await expect(promise).rejects.toHaveProperty('code', 'INTERNAL');
      expect(await repo.getUser('p1', 'db-a', 'app')).not.toBeNull();
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

  describe('databaseFlags', () => {
    test('createInstance with databaseFlags calls applyDatabaseFlags', async () => {
      await service.createInstance('p1', {
        name: 'db-a',
        databaseVersion: 'POSTGRES_16',
        settings: {
          databaseFlags: [{ name: 'work_mem', value: '4MB' }],
        },
      });

      expect(dataPlane.calls.some(c => c.startsWith('applyFlags:p1/db-a:'))).toBe(true);
    });

    test('createInstance with empty databaseFlags does not call applyDatabaseFlags', async () => {
      await service.createInstance('p1', {
        name: 'db-a',
        databaseVersion: 'POSTGRES_16',
        settings: { databaseFlags: [] },
      });

      expect(dataPlane.calls.some(c => c.startsWith('applyFlags:'))).toBe(false);
    });

    test('createInstance without databaseFlags does not call applyDatabaseFlags', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });

      expect(dataPlane.calls.some(c => c.startsWith('applyFlags:'))).toBe(false);
    });

    test('restartInstance re-applies flags from current settings', async () => {
      await service.createInstance('p1', {
        name: 'db-a',
        databaseVersion: 'POSTGRES_16',
        settings: { databaseFlags: [{ name: 'work_mem', value: '4MB' }] },
      });
      dataPlane.calls.length = 0;

      await service.restartInstance('p1', 'db-a');

      expect(dataPlane.calls.some(c => c.startsWith('applyFlags:p1/db-a:'))).toBe(true);
    });

    test('restartInstance without databaseFlags in settings does not call applyDatabaseFlags', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
      dataPlane.calls.length = 0;

      await service.restartInstance('p1', 'db-a');

      expect(dataPlane.calls.some(c => c.startsWith('applyFlags:'))).toBe(false);
    });

    test('updateInstance with databaseFlags calls applyDatabaseFlags', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
      dataPlane.calls.length = 0;

      await service.updateInstance('p1', 'db-a', {
        settings: {
          settingsVersion: 1,
          databaseFlags: [{ name: 'work_mem', value: '4MB' }],
        },
      });

      expect(dataPlane.calls.some(c => c.startsWith('applyFlags:p1/db-a:'))).toBe(true);
    });

    test('patchInstance with databaseFlags calls applyDatabaseFlags', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
      dataPlane.calls.length = 0;

      await service.patchInstance('p1', 'db-a', {
        settings: { databaseFlags: [{ name: 'work_mem', value: '4MB' }] },
      });

      expect(dataPlane.calls.some(c => c.startsWith('applyFlags:p1/db-a:'))).toBe(true);
    });

    test('patchInstance with an empty databaseFlags list clears the applied flags', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
      dataPlane.calls.length = 0;

      await service.patchInstance('p1', 'db-a', {
        settings: { databaseFlags: [] },
      });

      expect(dataPlane.calls).toContain('applyFlags:p1/db-a:');
    });

    test('updateInstance without databaseFlags clears flags a patch had set', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
      await service.patchInstance('p1', 'db-a', {
        settings: { databaseFlags: [{ name: 'work_mem', value: '4MB' }] },
      });
      dataPlane.calls.length = 0;

      await service.updateInstance('p1', 'db-a', {
        settings: { settingsVersion: 2 },
      });

      expect(dataPlane.calls).toContain('applyFlags:p1/db-a:');
    });

    test('patchInstance with a non-string flag value rejects the request', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
      await service.patchInstance('p1', 'db-a', {
        settings: { databaseFlags: [{ name: 'work_mem', value: '4MB' }] },
      });
      dataPlane.calls.length = 0;

      const promise = service.patchInstance('p1', 'db-a', {
        settings: { databaseFlags: [{ name: 'work_mem', value: 8 }] },
      });

      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
      expect(dataPlane.calls.some(call => call.startsWith('applyFlags:'))).toBe(false);

      const instance = await service.getInstance('p1', 'db-a');

      expect(instance.settings.databaseFlags).toEqual([{ name: 'work_mem', value: '4MB' }]);
    });

    test('restartInstance applies flags a patch saved while the restart waited', async () => {
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>(resolve => {
        releaseGate = resolve;
      });
      let markEntered: () => void = () => {};
      const entered = new Promise<void>(resolve => {
        markEntered = resolve;
      });
      let arm = false;
      const originalGet = repo.getInstance.bind(repo);
      const applied: string[] = [];

      repo.getInstance = async (project, name) => {
        if (arm) {
          arm = false;
          markEntered();
          await gate;
        }

        return originalGet(project, name);
      };
      dataPlane.applyDatabaseFlags = async (project, instance, flags) => {
        const rendered = flags.map(flag => `${flag.name}=${flag.value}`).join(',');

        applied.push(rendered);
        dataPlane.calls.push(`applyFlags:${project}/${instance}:${rendered}`);
      };

      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
      await service.patchInstance('p1', 'db-a', {
        settings: { databaseFlags: [{ name: 'work_mem', value: '4MB' }] },
      });
      arm = true;

      const patch = service.patchInstance('p1', 'db-a', {
        settings: { databaseFlags: [{ name: 'work_mem', value: '8MB' }] },
      });

      await entered;

      const restart = service.restartInstance('p1', 'db-a');

      releaseGate();
      await Promise.all([patch, restart]);

      expect(applied.at(-1)).toBe('work_mem=8MB');
    });

    test('patchInstance with a non-list databaseFlags rejects the request', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
      await service.patchInstance('p1', 'db-a', {
        settings: { databaseFlags: [{ name: 'work_mem', value: '4MB' }] },
      });
      dataPlane.calls.length = 0;

      const promise = service.patchInstance('p1', 'db-a', {
        settings: { databaseFlags: null },
      });

      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
      expect(dataPlane.calls.some(call => call.startsWith('applyFlags:'))).toBe(false);

      const instance = await service.getInstance('p1', 'db-a');

      expect(instance.settings.databaseFlags).toEqual([{ name: 'work_mem', value: '4MB' }]);
    });

    test('createInstance reports a rejected flag as INVALID_ARGUMENT', async () => {
      dataPlane.applyFlagsFailure = new DatabaseFlagError('unrecognized parameter "bad_flag"');

      const operation = await service.createInstance('p1', {
        name: 'db-a',
        databaseVersion: 'POSTGRES_16',
        settings: { databaseFlags: [{ name: 'bad_flag', value: 'x' }] },
      });

      expect(operation.error?.errors[0]?.code).toBe('INVALID_ARGUMENT');
      expect(await repo.getInstance('p1', 'db-a')).toBeNull();
    });

    test('patchInstance without databaseFlags key does not call applyDatabaseFlags', async () => {
      await service.createInstance('p1', {
        name: 'db-a',
        databaseVersion: 'POSTGRES_16',
        settings: { databaseFlags: [{ name: 'work_mem', value: '4MB' }] },
      });
      dataPlane.calls.length = 0;

      await service.patchInstance('p1', 'db-a', {
        settings: { tier: 'db-custom-2-8192' },
      });

      expect(dataPlane.calls.some(c => c.startsWith('applyFlags:'))).toBe(false);
    });

    test('updateInstance rolls back settings when applyDatabaseFlags throws INTERNAL', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
      dataPlane.applyFlagsFailure = new Error('restart failed');

      const promise = service.updateInstance('p1', 'db-a', {
        settings: {
          settingsVersion: 1,
          databaseFlags: [{ name: 'work_mem', value: '4MB' }],
        },
      });

      await expect(promise).rejects.toHaveProperty('code', 'INTERNAL');

      const instance = await service.getInstance('p1', 'db-a');

      expect(instance.settings.databaseFlags).toBeUndefined();
    });

    test('updateInstance throws INVALID_ARGUMENT when applyDatabaseFlags throws DatabaseFlagError', async () => {
      await service.createInstance('p1', { name: 'db-a', databaseVersion: 'POSTGRES_16' });
      dataPlane.applyFlagsFailure = new DatabaseFlagError('unrecognized parameter "bad_flag"');

      const promise = service.updateInstance('p1', 'db-a', {
        settings: {
          settingsVersion: 1,
          databaseFlags: [{ name: 'bad_flag', value: 'x' }],
        },
      });

      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');

      const instance = await service.getInstance('p1', 'db-a');

      expect(instance.settings.databaseFlags).toBeUndefined();
    });

    test('createInstance returns error operation when applyDatabaseFlags fails', async () => {
      dataPlane.applyFlagsFailure = new Error('flags not applied');

      const operation = await service.createInstance('p1', {
        name: 'db-a',
        databaseVersion: 'POSTGRES_16',
        settings: { databaseFlags: [{ name: 'work_mem', value: '4MB' }] },
      });

      expect(operation.error).toBeDefined();
      expect(await repo.getInstance('p1', 'db-a')).toBeNull();
    });
  });
});
