import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
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
