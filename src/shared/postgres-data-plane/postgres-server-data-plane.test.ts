import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import { Logger } from '@/shared/utils/logger.ts';
import { isPortListening } from '@/shared/utils/port-allocator.ts';
import { isRealPostgresAvailable } from '../../../test-utils/postgres.ts';
import { CLOUDSQL_DATA_PLANE_PRODUCT } from './host.ts';
import { PostgresProcessManager } from './postgres-process-manager.ts';
import type { PostgresSupervisor } from './postgres-server-data-plane.ts';
import {
  PostgresServerDataPlane,
  quoteIdentifier,
  quoteLiteral,
} from './postgres-server-data-plane.ts';

const logger = new Logger('postgres-server-test', 'error');

function unavailableSupervisor(): PostgresSupervisor {
  return {
    isPostgresAvailable: () => false,
    ensureInitialized: async () => {},
    start: async () => {
      throw new Error('started');
    },
    stop: async () => {},
    openAdminConnection: () => {
      throw new Error('connected');
    },
  };
}

describe('quoteIdentifier', () => {
  test('doubles a quote inside the name', () => {
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  });
});

describe('quoteLiteral', () => {
  test('doubles a quote inside the literal', () => {
    expect(quoteLiteral("o'brien")).toBe("'o''brien'");
  });
});

describe('PostgresServerDataPlane without binaries', () => {
  test('returns a null port and warns once', async () => {
    const planeLogger = new Logger('postgres-server-test', 'warn');
    const warn = spyOn(planeLogger, 'warn');
    const plane = new PostgresServerDataPlane(planeLogger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: null,
      portRangeStart: 47900,
      portRangeEnd: 47900,
      processManager: unavailableSupervisor(),
    });

    expect(await plane.startInstance('p', 'a', ['postgres'])).toBeNull();
    expect(await plane.startInstance('p', 'b', ['postgres'])).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockRestore();
  });

  test('releases the port when the server fails to start', async () => {
    const start = mock(async () => {
      throw new Error('boom');
    });
    const plane = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: null,
      portRangeStart: 47910,
      portRangeEnd: 47910,
      processManager: {
        ...unavailableSupervisor(),
        isPostgresAvailable: () => true,
        start,
      },
    });

    await expect(plane.startInstance('p', 'a', ['postgres'])).rejects.toThrow('boom');
    await expect(plane.startInstance('p', 'b', ['postgres'])).rejects.toThrow('boom');
    expect(start).toHaveBeenCalledTimes(2);
  });

  test('tries the next port when the chosen one cannot be bound', async () => {
    const starts: number[] = [];
    const plane = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: null,
      portRangeStart: 47980,
      portRangeEnd: 47982,
      processManager: {
        ...unavailableSupervisor(),
        isPostgresAvailable: () => true,
        start: async (_dataDir, port) => {
          starts.push(port);

          if (starts.length === 1) throw new Error('Address already in use');
        },
      },
    });

    await expect(plane.startInstance('p', 'a', ['postgres'])).rejects.toThrow('connected');
    expect(starts).toEqual([47980, 47981]);
  });

  test('a restart reuses the port it already holds', async () => {
    const ports: number[] = [];
    const sql = Object.assign(async () => [{ one: 1 }], {
      unsafe: async () => {},
      close: async () => {},
    });
    const plane = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: null,
      portRangeStart: 47990,
      portRangeEnd: 47990,
      processManager: {
        ...unavailableSupervisor(),
        isPostgresAvailable: () => true,
        start: async (_dataDir, port) => {
          ports.push(port);
        },
        openAdminConnection: () => sql as unknown as SQL,
      },
    });

    const first = await plane.startInstance('p', 'a', ['postgres']);
    const second = await plane.startInstance('p', 'a', ['postgres']);

    expect(second).toBe(first);
    expect(ports).toEqual([47990, 47990]);
    await plane.stopAll();
  });
});

describe('PostgresServerDataPlane directory safety', () => {
  test('refuses to replace a PGlite directory with an empty cluster', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-pglite-'));
    const kept = join(root, 'cloudsql', 'p', 'inst', 'postgres', 'PG_VERSION');

    await mkdir(join(root, 'cloudsql', 'p', 'inst', 'postgres'), { recursive: true });
    await Bun.write(kept, '16\n');
    const ensureInitialized = mock(async () => {});
    const started = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: root,
      portRangeStart: 47940,
      portRangeEnd: 47940,
      processManager: {
        ...unavailableSupervisor(),
        isPostgresAvailable: () => true,
        ensureInitialized,
        start: async () => {},
      },
    });

    try {
      await expect(started.startInstance('p', 'inst', ['postgres'])).rejects.toThrow(/PGlite/);
      expect(ensureInitialized).not.toHaveBeenCalled();
      expect(await Bun.file(kept).text()).toBe('16\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses to drop a database whose cluster is on disk but not running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-stopped-'));
    const version = join(root, 'cloudsql', 'p', 'inst', 'PG_VERSION');

    await mkdir(join(root, 'cloudsql', 'p', 'inst'), { recursive: true });
    await Bun.write(version, '18\n');
    const started = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: root,
      portRangeStart: 47950,
      portRangeEnd: 47950,
      processManager: {
        ...unavailableSupervisor(),
        isPostgresAvailable: () => true,
      },
    });

    try {
      await expect(started.dropDatabase('p', 'inst', 'app')).rejects.toThrow(/not running/);
      await expect(started.dropUser('p', 'inst', 'app')).rejects.toThrow(/not running/);
      expect(await Bun.file(version).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('concurrent memory creates share one temp root', async () => {
    const dirs: string[] = [];
    const realMkdir = fsPromises.mkdtemp;
    const delayed = spyOn(fsPromises, 'mkdtemp').mockImplementation(((prefix: string) =>
      Bun.sleep(40).then(() => realMkdir(prefix))) as typeof fsPromises.mkdtemp);
    const started = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: null,
      portRangeStart: 47960,
      portRangeEnd: 47970,
      processManager: {
        ...unavailableSupervisor(),
        isPostgresAvailable: () => true,
        ensureInitialized: async (dir: string) => {
          dirs.push(dir);
        },
        start: async () => {
          throw new Error('stop after the directory is chosen');
        },
      },
    });

    try {
      const results = await Promise.allSettled([
        started.startInstance('p', 'a', ['postgres']),
        started.startInstance('p', 'b', ['postgres']),
      ]);

      expect(delayed).toHaveBeenCalled();
      expect(results.every(result => result.status === 'rejected')).toBe(true);
      expect(dirs).toHaveLength(2);
      expect(dirs[0]?.split('/cloudsql/')[0]).toBe(dirs[1]?.split('/cloudsql/')[0]);
    } finally {
      delayed.mockRestore();
      await started.stopAll();
    }
  });
});

describe.skipIf(!isRealPostgresAvailable)('PostgresServerDataPlane', () => {
  const roots: string[] = [];
  const planes: PostgresServerDataPlane[] = [];
  let range = 48100;

  function nextRange(): { portRangeStart: number; portRangeEnd: number } {
    const portRangeStart = range;

    range += 5;

    return { portRangeStart, portRangeEnd: portRangeStart + 4 };
  }

  async function plane(storage: 'memory' | 'sqlite'): Promise<{
    plane: PostgresServerDataPlane;
    root: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-pg-server-'));

    roots.push(root);

    const started = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: storage === 'memory' ? null : root,
      ...nextRange(),
      processManager: new PostgresProcessManager(logger),
    });

    planes.push(started);

    return { plane: started, root };
  }

  afterEach(async () => {
    for (const started of planes.splice(0)) await started.stopAll();

    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  test('starts, serves a quoted database name, and drops the directory', async () => {
    const { plane: started, root } = await plane('sqlite');
    const database = 'we"ird';
    const port = await started.startInstance('p/1', 'inst', ['postgres', database]);

    expect(port).toBeTypeOf('number');

    const admin = new PostgresProcessManager(logger).openAdminConnection(
      join(root, 'cloudsql', 'p%2F1', 'inst'),
      port ?? 0,
      database
    );

    try {
      expect((await admin`select current_database() as name`)[0].name).toBe(database);
    } finally {
      await admin.close({ timeout: 0 });
    }

    await started.dropDatabase('p/1', 'inst', database);
    await started.dropDatabase('p/1', 'inst', 'postgres');
    await started.dropInstance('p/1', 'inst');

    expect(await Bun.file(join(root, 'cloudsql', 'p%2F1', 'inst', 'PG_VERSION')).exists()).toBe(
      false
    );
    expect(await isPortListening(port ?? 0)).toBe(false);
  });

  test('logs a user in with a password that contains a quote, then rejects the old one', async () => {
    const { plane: started } = await plane('sqlite');
    const port = await started.startInstance('p', 'inst', ['postgres']);
    const password = "o'brien";

    await started.upsertUser('p', 'inst', {
      name: 'app',
      password,
      memberOf: ['cloudsqlsuperuser'],
    });

    const client = new SQL({
      url: `postgres://app:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`,
      tls: false,
      max: 1,
    });

    try {
      expect((await client`select current_user as name`)[0].name).toBe('app');
      await client`create table kept (id int)`;
      await client`insert into kept values (1)`;
    } finally {
      await client.close({ timeout: 0 });
    }

    await started.upsertUser('p', 'inst', {
      name: 'app',
      password: 'next',
      memberOf: ['cloudsqlsuperuser'],
    });

    const stale = new SQL({
      url: `postgres://app:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`,
      tls: false,
      max: 1,
      connectionTimeout: 1,
    });

    await expect(Promise.resolve(stale`select 1`)).rejects.toThrow();
    await stale.close({ timeout: 0 });

    await started.stopInstance('p', 'inst');
    await started.startInstance('p', 'inst', ['postgres']);

    const again = new SQL({
      url: `postgres://app:next@127.0.0.1:${started.getPort('p', 'inst')}/postgres`,
      tls: false,
      max: 1,
    });

    try {
      expect((await again`select id from kept`)[0].id).toBe(1);
    } finally {
      await again.close({ timeout: 0 });
    }
  });

  test('drops the default database and a role that still has a session', async () => {
    const { plane: started, root } = await plane('sqlite');
    const port = await started.startInstance('p', 'inst', ['postgres']);
    const dataDir = join(root, 'cloudsql', 'p', 'inst');

    await started.upsertUser('p', 'inst', {
      name: 'app',
      password: 'secret',
      memberOf: ['cloudsqlsuperuser'],
    });
    await expect(
      started.upsertUser('p', 'inst', {
        name: 'kinglet_admin',
        password: 'taken',
        memberOf: [],
      })
    ).rejects.toThrow(/reserved/);

    const held = new SQL({
      url: `postgres://app:secret@127.0.0.1:${port}/postgres`,
      tls: false,
      max: 1,
    });

    expect((await held<{ value: number }[]>`select 1 as value`)[0]?.value).toBe(1);
    await started.dropUser('p', 'inst', 'app');
    await expect(Promise.resolve(held`select 1`)).rejects.toThrow();
    await held.close({ timeout: 0 });
    await started.dropDatabase('p', 'inst', 'postgres');

    const manager = new PostgresProcessManager(logger);
    const dropped = manager.openAdminConnection(dataDir, port ?? 0, 'postgres');
    const maintenance = manager.openAdminConnection(dataDir, port ?? 0, 'template1');

    try {
      await expect(Promise.resolve(dropped`select 1`)).rejects.toThrow();
      expect((await maintenance<{ value: number }[]>`select 1 as value`)[0]?.value).toBe(1);
    } finally {
      await dropped.close({ timeout: 0 });
      await maintenance.close({ timeout: 0 });
    }

    await started.upsertUser('p', 'inst', {
      name: 'next',
      password: 'secret',
      memberOf: ['cloudsqlsuperuser'],
    });
    await started.openDatabase('p', 'inst', 'appdb');
    expect(await started.startInstance('p', 'inst', ['postgres', 'appdb'])).toBe(port);

    const ready = new PostgresProcessManager(logger).openAdminConnection(dataDir, port ?? 0);

    try {
      expect((await ready<{ value: number }[]>`select 1 as value`)[0]?.value).toBe(1);
    } finally {
      await ready.close({ timeout: 0 });
    }
  });

  test('drops a user and discards memory-storage data on stop', async () => {
    const { plane: started } = await plane('memory');
    const port = await started.startInstance('p', 'inst', ['postgres']);

    await started.upsertUser('p', 'inst', {
      name: 'app',
      password: 'secret',
      memberOf: ['cloudsqlsuperuser'],
    });

    const client = new SQL({
      url: `postgres://app:secret@127.0.0.1:${port}/postgres`,
      tls: false,
      max: 1,
    });

    try {
      await client`create table kept (id int)`;
      await client`insert into kept values (7)`;
    } finally {
      await client.close({ timeout: 0 });
    }

    await started.dropUser('p', 'inst', 'app');

    const gone = new SQL({
      url: `postgres://app:secret@127.0.0.1:${port}/postgres`,
      tls: false,
      max: 1,
      connectionTimeout: 1,
    });

    await expect(Promise.resolve(gone`select 1`)).rejects.toThrow();
    await gone.close({ timeout: 0 });
    await started.stopAll();

    const revivedPort = await started.startInstance('p', 'inst', ['postgres']);

    await started.upsertUser('p', 'inst', {
      name: 'app',
      password: 'secret',
      memberOf: ['cloudsqlsuperuser'],
    });

    const revived = new SQL({
      url: `postgres://app:secret@127.0.0.1:${revivedPort}/postgres`,
      tls: false,
      max: 1,
    });

    try {
      await expect(Promise.resolve(revived`select id from kept`)).rejects.toThrow(/kept/);
    } finally {
      await revived.close({ timeout: 0 });
    }
  });
});
