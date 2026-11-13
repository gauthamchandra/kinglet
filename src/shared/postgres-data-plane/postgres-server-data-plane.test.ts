import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import {
  DatabaseFlagError,
  RoleAlreadyExistsError,
} from '@/shared/postgres-data-plane/data-plane-manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { isPortListening } from '@/shared/utils/port-allocator.ts';
import { isRealPostgresAvailable } from '../../../test-utils/postgres.ts';
import { CLOUDSQL_DATA_PLANE_PRODUCT } from './host.ts';
import { PostgresProcessManager, replicationSlotName } from './postgres-process-manager.ts';
import type { PostgresSupervisor } from './postgres-server-data-plane.ts';
import {
  encodePathSegment,
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
    basebackup: async () => {
      throw new Error('basebackup called on unavailable supervisor');
    },
    stopStaleServer: async () => {},
    refreshReplicaConninfo: async () => {
      throw new Error('refresh called on unavailable supervisor');
    },
    releaseReplicationSlot: async () => {},
  };
}

describe('encodePathSegment', () => {
  test('leaves an ordinary name readable', () => {
    expect(encodePathSegment('postgres')).toBe('postgres');
    expect(encodePathSegment('my-app_db1')).toBe('my-app_db1');
  });

  test('defuses traversal and separators', () => {
    expect(encodePathSegment('..')).toBe('%2E%2E');
    expect(encodePathSegment('a/b')).toBe('a%2Fb');
    expect(encodePathSegment('../../etc')).toBe('%2E%2E%2F%2E%2E%2Fetc');
  });
});

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

  test('applyDatabaseFlags restores auto.conf when reload fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-reload-'));
    const autoPath = join(root, 'cloudsql', 'p', 'inst', 'postgresql.auto.conf');
    const previous = "work_mem = '8MB'\n";
    const sql = Object.assign(
      async (strings: TemplateStringsArray) => {
        if (strings.join('').includes('pg_reload_conf')) throw new Error('reload failed');

        return [{ one: 1 }];
      },
      {
        unsafe: async (statement: string) => {
          if (statement.startsWith('ALTER SYSTEM')) {
            await Bun.write(autoPath, `${previous}${statement}\n`);
          }
        },
        close: async () => {},
      }
    );
    const plane = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: root,
      portRangeStart: 47971,
      portRangeEnd: 47971,
      processManager: {
        ...unavailableSupervisor(),
        isPostgresAvailable: () => true,
        ensureInitialized: async dataDir => {
          await mkdir(dataDir, { recursive: true });
          await Bun.write(join(dataDir, 'PG_VERSION'), '18\n');
          await Bun.write(join(dataDir, 'postgresql.auto.conf'), previous);
        },
        start: async () => {},
        openAdminConnection: () => sql as unknown as SQL,
      },
    });

    await plane.startInstance('p', 'inst', ['postgres']);
    const applied = plane.applyDatabaseFlags(
      'p',
      'inst',
      [{ name: 'work_mem', value: '16MB' }],
      ['postgres']
    );

    await expect(applied).rejects.toThrow('reload failed');
    expect(await Bun.file(autoPath).text()).toBe(previous);
    await plane.stopAll();
    await rm(root, { recursive: true, force: true });
  });

  test('applyDatabaseFlags restarts after the reload is observed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-reload-seen-'));
    const starts: number[] = [];
    let reloads = 0;
    let loadReads = 0;
    const stale = '2020-01-01 00:00:00.000100';
    const fresh = '2020-01-01 00:00:00.000900';
    const sql = Object.assign(
      async (strings: TemplateStringsArray) => {
        const text = strings.join('');

        if (text.includes('pg_conf_load_time')) {
          loadReads += 1;

          return [{ loaded: reloads === 0 || loadReads < 3 ? stale : fresh }];
        }

        if (text.includes('pg_reload_conf')) {
          reloads += 1;

          return [{ pg_reload_conf: true }];
        }

        if (text.includes('pending_restart')) {
          return [{ pending_restart: reloads > 0 && loadReads >= 3 }];
        }

        return [{ one: 1 }];
      },
      { unsafe: async () => {}, close: async () => {} }
    );
    const plane = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: root,
      portRangeStart: 47973,
      portRangeEnd: 47973,
      processManager: {
        ...unavailableSupervisor(),
        isPostgresAvailable: () => true,
        ensureInitialized: async dataDir => {
          await mkdir(dataDir, { recursive: true });
          await Bun.write(join(dataDir, 'PG_VERSION'), '18\n');
        },
        start: async () => {
          starts.push(1);
        },
        openAdminConnection: () => sql as unknown as SQL,
      },
    });

    await plane.startInstance('p', 'inst', ['postgres']);
    await plane.applyDatabaseFlags(
      'p',
      'inst',
      [{ name: 'max_connections', value: '200' }],
      ['postgres']
    );

    expect(starts).toHaveLength(2);
    await plane.stopAll();
    await rm(root, { recursive: true, force: true });
  });

  test('applyDatabaseFlags accepts a timezone that moves the clock backward', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-tz-reload-'));
    const starts: number[] = [];
    let loadReads = 0;
    const sql = Object.assign(
      async (strings: TemplateStringsArray) => {
        const text = strings.join('');

        if (text.includes('pg_conf_load_time')) {
          loadReads += 1;
          const utc = text.includes("TIME ZONE 'UTC'");
          const loaded = utc
            ? loadReads < 3
              ? '2020-01-01 00:00:00.000100'
              : '2020-01-01 00:00:00.000900'
            : loadReads < 3
              ? '2020-01-01 05:00:00.000100'
              : '2020-01-01 00:00:00.000900';

          return [{ loaded }];
        }

        if (text.includes('pg_reload_conf')) return [{ pg_reload_conf: true }];

        if (text.includes('pending_restart')) return [{ pending_restart: false }];

        return [{ one: 1 }];
      },
      { unsafe: async () => {}, close: async () => {} }
    );
    const plane = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: root,
      portRangeStart: 47975,
      portRangeEnd: 47975,
      processManager: {
        ...unavailableSupervisor(),
        isPostgresAvailable: () => true,
        ensureInitialized: async dataDir => {
          await mkdir(dataDir, { recursive: true });
          await Bun.write(join(dataDir, 'PG_VERSION'), '18\n');
        },
        start: async () => {
          starts.push(1);
        },
        openAdminConnection: () => sql as unknown as SQL,
      },
    });

    await plane.startInstance('p', 'inst', ['postgres']);
    await plane.applyDatabaseFlags(
      'p',
      'inst',
      [{ name: 'timezone', value: 'Pacific/Pago_Pago' }],
      ['postgres']
    );

    expect(starts).toHaveLength(1);
    await plane.stopAll();
    await rm(root, { recursive: true, force: true });
  });

  test('applyDatabaseFlags restores auto.conf when the reload is not observed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-reload-unseen-'));
    const autoPath = join(root, 'cloudsql', 'p', 'inst', 'postgresql.auto.conf');
    const previous = "work_mem = '8MB'\n";
    const stuck = '2020-01-01 00:00:00.000100';
    const sql = Object.assign(
      async (strings: TemplateStringsArray) => {
        const text = strings.join('');

        if (text.includes('pg_conf_load_time')) return [{ loaded: stuck }];

        if (text.includes('pg_reload_conf')) return [{ pg_reload_conf: true }];

        return [{ one: 1 }];
      },
      {
        unsafe: async (statement: string) => {
          if (statement.startsWith('ALTER SYSTEM')) {
            await Bun.write(autoPath, `${previous}${statement}\n`);
          }
        },
        close: async () => {},
      }
    );
    const plane = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: root,
      portRangeStart: 47974,
      portRangeEnd: 47974,
      processManager: {
        ...unavailableSupervisor(),
        isPostgresAvailable: () => true,
        ensureInitialized: async dataDir => {
          await mkdir(dataDir, { recursive: true });
          await Bun.write(join(dataDir, 'PG_VERSION'), '18\n');
          await Bun.write(join(dataDir, 'postgresql.auto.conf'), previous);
        },
        start: async () => {},
        openAdminConnection: () => sql as unknown as SQL,
      },
    });

    await plane.startInstance('p', 'inst', ['postgres']);
    const applied = plane.applyDatabaseFlags(
      'p',
      'inst',
      [{ name: 'work_mem', value: '16MB' }],
      ['postgres']
    );

    await expect(applied).rejects.toThrow('Postgres did not reload its configuration');
    expect(await Bun.file(autoPath).text()).toBe(previous);
    await plane.stopAll();
    await rm(root, { recursive: true, force: true });
  });

  test('startReplicaInstance returns null when postgres is unavailable', async () => {
    const plane = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: null,
      portRangeStart: 47950,
      portRangeEnd: 47950,
      processManager: unavailableSupervisor(),
    });

    expect(await plane.startReplicaInstance('p', 'pool', null)).toBeNull();
    expect(await plane.startReplicaInstance('p', 'pool', 5432)).toBeNull();
  });

  test('startReplicaInstance throws when the primary has no port', async () => {
    const plane = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: null,
      portRangeStart: 47951,
      portRangeEnd: 47951,
      processManager: {
        ...unavailableSupervisor(),
        isPostgresAvailable: () => true,
        start: async () => {},
      },
    });

    await expect(plane.startReplicaInstance('p', 'pool', null)).rejects.toThrow(/not running/);
  });

  test('a pre-replica directory is kept and a failed start releases its port', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-replica-'));
    const backups: string[] = [];
    const sql = Object.assign(async () => [{ one: 1 }], {
      unsafe: async () => {},
      close: async () => {},
    });
    const plane = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: root,
      portRangeStart: 47960,
      portRangeEnd: 47961,
      processManager: {
        ...unavailableSupervisor(),
        isPostgresAvailable: () => true,
        ensureInitialized: async dataDir => {
          await mkdir(dataDir, { recursive: true });
          await Bun.write(join(dataDir, 'PG_VERSION'), '18\n');
        },
        start: async dataDir => {
          if (dataDir.endsWith('/pool')) throw new Error('standby failed to start');
        },
        basebackup: async standbyDir => {
          backups.push(standbyDir);
          await mkdir(standbyDir, { recursive: true });
        },
        refreshReplicaConninfo: async () => {},
        openAdminConnection: () => sql as unknown as SQL,
      },
    });

    await plane.startInstance('p', 'primary', ['postgres']);

    const oldPool = join(root, 'cloudsql', 'p', 'pool');

    await mkdir(oldPool, { recursive: true });
    await Bun.write(join(oldPool, 'PG_VERSION'), '16\n');

    await expect(
      plane.startReplicaInstance('p', 'pool', await plane.getPort('p', 'primary'))
    ).rejects.toThrow('standby failed to start');
    expect(await Bun.file(join(`${oldPool}.kinglet-prereplica`, 'PG_VERSION')).text()).toBe('16\n');
    expect(backups).toHaveLength(1);

    await plane.startInstance('p', 'other', ['postgres']);
    await plane.stopAll();
    await rm(root, { recursive: true, force: true });
  });

  test('a live pre-replica server is stopped before its directory is moved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-replica-live-'));
    const events: string[] = [];
    const sql = Object.assign(async () => [{ status: 'streaming' }], {
      unsafe: async () => {},
      close: async () => {},
    });
    const plane = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: root,
      portRangeStart: 47970,
      portRangeEnd: 47971,
      processManager: {
        ...unavailableSupervisor(),
        isPostgresAvailable: () => true,
        ensureInitialized: async dataDir => {
          await mkdir(dataDir, { recursive: true });
          await Bun.write(join(dataDir, 'PG_VERSION'), '18\n');
        },
        start: async () => {},
        stop: async dataDir => {
          const version = Bun.file(join(dataDir, 'PG_VERSION'));

          if (await version.exists()) events.push(`stop:${await version.text()}`);
        },
        stopStaleServer: async dataDir => {
          const version = Bun.file(join(dataDir, 'PG_VERSION'));

          if (await version.exists()) events.push(`stale:${await version.text()}`);
        },
        basebackup: async standbyDir => {
          events.push(`backup:${await Bun.file(join(standbyDir, 'PG_VERSION')).exists()}`);
          await mkdir(standbyDir, { recursive: true });
        },
        refreshReplicaConninfo: async () => {},
        openAdminConnection: () => sql as unknown as SQL,
      },
    });

    try {
      await plane.startInstance('p', 'primary', ['postgres']);

      const oldPool = join(root, 'cloudsql', 'p', 'pool');

      await mkdir(oldPool, { recursive: true });
      await Bun.write(join(oldPool, 'PG_VERSION'), '16\n');
      await plane.startReplicaInstance('p', 'pool', await plane.getPort('p', 'primary'));

      expect(events).toEqual(['stop:16\n', 'stale:16\n', 'backup:false']);
      expect(await Bun.file(join(`${oldPool}.kinglet-prereplica`, 'PG_VERSION')).text()).toBe(
        '16\n'
      );
    } finally {
      await plane.stopAll();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a pre-replica directory stays put when its server cannot be stopped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-replica-stuck-'));
    const sql = Object.assign(async () => [{ one: 1 }], {
      unsafe: async () => {},
      close: async () => {},
    });
    const plane = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: root,
      portRangeStart: 47972,
      portRangeEnd: 47973,
      processManager: {
        ...unavailableSupervisor(),
        isPostgresAvailable: () => true,
        ensureInitialized: async dataDir => {
          await mkdir(dataDir, { recursive: true });
          await Bun.write(join(dataDir, 'PG_VERSION'), '18\n');
        },
        start: async () => {},
        stopStaleServer: async () => {
          throw new Error('still running');
        },
        basebackup: async () => {
          throw new Error('backup should not run');
        },
        openAdminConnection: () => sql as unknown as SQL,
      },
    });

    try {
      await plane.startInstance('p', 'primary', ['postgres']);

      const oldPool = join(root, 'cloudsql', 'p', 'pool');

      await mkdir(oldPool, { recursive: true });
      await Bun.write(join(oldPool, 'PG_VERSION'), '16\n');

      await expect(
        plane.startReplicaInstance('p', 'pool', await plane.getPort('p', 'primary'))
      ).rejects.toThrow('still running');
      expect(await Bun.file(join(oldPool, 'PG_VERSION')).text()).toBe('16\n');
      expect(await Bun.file(join(`${oldPool}.kinglet-prereplica`, 'PG_VERSION')).exists()).toBe(
        false
      );
    } finally {
      await plane.stopAll();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a standby that is not streaming is backed up again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-replica-stream-'));
    const backups: string[] = [];
    const sql = Object.assign(
      async (strings: TemplateStringsArray) => {
        const text = strings.join(' ');

        if (text.includes('pg_stat_wal_receiver')) return [];

        return [{ one: 1 }];
      },
      { unsafe: async () => {}, close: async () => {} }
    );
    const plane = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: root,
      portRangeStart: 47962,
      portRangeEnd: 47963,
      processManager: {
        ...unavailableSupervisor(),
        isPostgresAvailable: () => true,
        ensureInitialized: async dataDir => {
          await mkdir(dataDir, { recursive: true });
          await Bun.write(join(dataDir, 'PG_VERSION'), '18\n');
        },
        start: async () => {},
        basebackup: async standbyDir => {
          backups.push(standbyDir);
          await mkdir(standbyDir, { recursive: true });
        },
        refreshReplicaConninfo: async () => {},
        openAdminConnection: () => sql as unknown as SQL,
      },
    });
    const streaming = plane as unknown as { replicaStreamTimeoutMs: number };

    streaming.replicaStreamTimeoutMs = 40;

    try {
      await plane.startInstance('p', 'primary', ['postgres']);
      await expect(
        plane.startReplicaInstance('p', 'pool', await plane.getPort('p', 'primary'))
      ).rejects.toThrow(/did not start streaming/);
      expect(backups).toHaveLength(2);
    } finally {
      await plane.stopAll();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a failed backup releases its replication slot without standby.signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-replica-fail-'));
    const sql = Object.assign(async () => [{ one: 1 }], {
      unsafe: async () => {},
      close: async () => {},
    });
    const released: { directory: string; slot: string; port: number | null }[] = [];
    let standbyDir = '';
    const plane = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: root,
      portRangeStart: 47965,
      portRangeEnd: 47966,
      processManager: {
        ...unavailableSupervisor(),
        isPostgresAvailable: () => true,
        ensureInitialized: async dataDir => {
          await mkdir(dataDir, { recursive: true });
          await Bun.write(join(dataDir, 'PG_VERSION'), '18\n');
        },
        start: async () => {},
        basebackup: async directory => {
          standbyDir = directory;
          throw new Error('pg_basebackup failed');
        },
        releaseReplicationSlot: async (directory, slot, port) => {
          released.push({ directory, slot, port });
        },
        openAdminConnection: () => sql as unknown as SQL,
      },
    });

    try {
      await plane.startInstance('p', 'primary', ['postgres']);
      const primaryPort = await plane.getPort('p', 'primary');

      await expect(plane.startReplicaInstance('p', 'pool', primaryPort)).rejects.toThrow(
        /pg_basebackup failed/
      );
      expect(await Bun.file(join(standbyDir, 'standby.signal')).exists()).toBe(false);
      expect(released).toEqual([
        {
          directory: join(root, 'cloudsql', 'p', 'primary'),
          slot: replicationSlotName(standbyDir),
          port: primaryPort,
        },
      ]);
    } finally {
      await plane.stopAll();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('dropping a standby releases its replication slot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-replica-slot-'));
    const pool = join(root, 'cloudsql', 'p', 'pool');
    const primary = join(root, 'cloudsql', 'p', 'primary');
    const slot = replicationSlotName(pool);
    const released: string[] = [];

    await mkdir(join(primary, 'pg_replslot', slot), { recursive: true });
    await mkdir(pool, { recursive: true });
    await Bun.write(join(pool, 'standby.signal'), '');
    const plane = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: root,
      portRangeStart: 47964,
      portRangeEnd: 47964,
      processManager: {
        ...unavailableSupervisor(),
        releaseReplicationSlot: async (directory, name) => {
          released.push(`${directory}:${name}`);
        },
      },
    });

    try {
      await plane.dropInstance('p', 'pool');
      expect(released).toEqual([`${join(root, 'cloudsql', 'p', 'primary')}:${slot}`]);
    } finally {
      await plane.stopAll();
      await rm(root, { recursive: true, force: true });
    }
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

  test('refuses to change a database or user whose cluster is on disk but not running', async () => {
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
      await expect(
        started.upsertUser('p', 'inst', { name: 'app', password: 'next', memberOf: [] })
      ).rejects.toThrow(/not running/);
      expect(await Bun.file(version).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('stopAll waits for a start still in progress and rejects a new one', async () => {
    let releaseStart: () => void = () => {};
    const release = new Promise<void>(resolve => {
      releaseStart = resolve;
    });
    let entered: () => void = () => {};
    const startEntered = new Promise<void>(resolve => {
      entered = resolve;
    });
    const stopped: string[] = [];
    let dataDir = '';
    const sql = Object.assign(async () => [{ one: 1 }], {
      unsafe: async () => {},
      close: async () => {},
    });
    const plane = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: null,
      portRangeStart: 47930,
      portRangeEnd: 47931,
      processManager: {
        ...unavailableSupervisor(),
        isPostgresAvailable: () => true,
        ensureInitialized: async (dir: string) => {
          await mkdir(dir, { recursive: true });
        },
        start: async (dir: string) => {
          if (dataDir.length === 0) {
            dataDir = dir;
            entered();
            await release;

            return;
          }

          throw new Error(`unexpected start ${dir}`);
        },
        stop: async (dir: string) => {
          stopped.push(dir);
        },
        openAdminConnection: () => sql as unknown as SQL,
      },
    });

    const starting = plane.startInstance('p', 'inst', ['postgres']);

    try {
      await startEntered;

      const stopping = plane.stopAll();
      let finished = false;

      void stopping.then(() => {
        finished = true;
      });
      await Bun.sleep(30);
      expect(finished).toBe(false);
      expect(
        await fsPromises.stat(dataDir).then(
          () => true,
          () => false
        )
      ).toBe(true);

      const late = plane.startInstance('p', 'other', ['postgres']);

      await expect(late).rejects.toThrow(/shutting down/);

      releaseStart();
      await stopping;
      await expect(starting).resolves.toBe(47930);
      expect(stopped).toEqual([dataDir]);
      expect(plane.getPort('p', 'inst')).toBeNull();
      expect(
        await fsPromises.stat(dataDir).then(
          () => true,
          () => false
        )
      ).toBe(false);
    } finally {
      releaseStart();
    }
  });

  test('stopAll waits for a flag restart that has left running', async () => {
    let releaseRestart: () => void = () => {};
    const release = new Promise<void>(resolve => {
      releaseRestart = resolve;
    });
    let markEntered: () => void = () => {};
    const entered = new Promise<void>(resolve => {
      markEntered = resolve;
    });
    let starts = 0;
    let loadReads = 0;
    let dataDir = '';
    const stale = '2020-01-01 00:00:00.000100';
    const fresh = '2020-01-01 00:00:00.000900';
    const sql = Object.assign(
      async (strings: TemplateStringsArray) => {
        const text = strings.join('');

        if (text.includes('pg_conf_load_time')) {
          loadReads += 1;

          return [{ loaded: loadReads < 3 ? stale : fresh }];
        }

        if (text.includes('pg_reload_conf')) return [{ pg_reload_conf: true }];

        if (text.includes('pending_restart')) return [{ pending_restart: true }];

        return [{ one: 1 }];
      },
      { unsafe: async () => {}, close: async () => {} }
    );
    const plane = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: null,
      portRangeStart: 47932,
      portRangeEnd: 47932,
      processManager: {
        ...unavailableSupervisor(),
        isPostgresAvailable: () => true,
        ensureInitialized: async (dir: string) => {
          await mkdir(dir, { recursive: true });
          await Bun.write(join(dir, 'PG_VERSION'), '18\n');
        },
        start: async (dir: string) => {
          starts += 1;
          dataDir = dir;

          if (starts === 1) return;

          markEntered();
          await release;
        },
        stop: async () => {},
        openAdminConnection: () => sql as unknown as SQL,
      },
    });

    await plane.startInstance('p', 'inst', ['postgres']);

    const applying = plane.applyDatabaseFlags(
      'p',
      'inst',
      [{ name: 'max_connections', value: '200' }],
      ['postgres']
    );

    try {
      await entered;

      const stopping = plane.stopAll();
      let finished = false;

      void stopping.then(() => {
        finished = true;
      });
      await Bun.sleep(30);
      expect(finished).toBe(false);
      expect(
        await fsPromises.stat(dataDir).then(
          () => true,
          () => false
        )
      ).toBe(true);

      releaseRestart();
      await Promise.all([applying, stopping]);
      expect(plane.getPort('p', 'inst')).toBeNull();
      expect(
        await fsPromises.stat(dataDir).then(
          () => true,
          () => false
        )
      ).toBe(false);
    } finally {
      releaseRestart();
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

  test('a root-owned memory root stays traversable by the unprivileged server', async () => {
    const uid = spyOn(process, 'getuid').mockReturnValue(0);
    const dirs: string[] = [];
    const started = new PostgresServerDataPlane(logger, {
      product: CLOUDSQL_DATA_PLANE_PRODUCT,
      dataDirectory: null,
      portRangeStart: 47980,
      portRangeEnd: 47990,
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
      await expect(started.startInstance('p', 'a', ['postgres'])).rejects.toThrow(
        'stop after the directory is chosen'
      );
      const dataDir = dirs[0];

      expect(dataDir?.includes('/cloudsql/')).toBe(true);

      const info = await fsPromises.stat(dataDir?.split('/cloudsql/')[0] ?? '');

      expect(info.mode & 0o777).toBe(0o711);
    } finally {
      uid.mockRestore();
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

  test('createOnly leaves an existing role and its password alone', async () => {
    const { plane: started, root } = await plane('sqlite');
    const port = await started.startInstance('p', 'inst', ['postgres']);
    const admin = new PostgresProcessManager(logger).openAdminConnection(
      join(root, 'cloudsql', 'p', 'inst'),
      port ?? 0
    );

    try {
      await admin.unsafe("CREATE ROLE app LOGIN PASSWORD 'original'");
    } finally {
      await admin.close({ timeout: 0 });
    }

    const created = started.upsertUser(
      'p',
      'inst',
      { name: 'app', password: 'changed', memberOf: [] },
      { createOnly: true }
    );

    await expect(created).rejects.toBeInstanceOf(RoleAlreadyExistsError);

    const client = new SQL({
      url: `postgres://app:original@127.0.0.1:${port}/postgres`,
      tls: false,
      max: 1,
    });

    try {
      expect((await client`select current_user as name`)[0].name).toBe('app');
    } finally {
      await client.close({ timeout: 0 });
    }
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

  test('a built-in user can create a database and a role', async () => {
    const { plane: started } = await plane('sqlite');
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
      await client`create database appdb`;
      await client`create role app_reader`;
      const rows = await client<{ name: string }[]>`
        select datname as name from pg_database where datname = 'appdb'
      `;

      expect(rows[0]?.name).toBe('appdb');
    } finally {
      await client.close({ timeout: 0 });
    }
  });

  test(
    'drops the default database and a role that still has a session',
    async () => {
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
    },
    // initdb plus a live session's teardown exceeds the 5s default when the runner is busy.
    { timeout: 20_000 }
  );

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

  test('applyDatabaseFlags sets a reload-level GUC without restarting', async () => {
    const { plane: started, root } = await plane('sqlite');
    const port = await started.startInstance('p', 'wm', ['postgres']);

    await started.applyDatabaseFlags('p', 'wm', [{ name: 'work_mem', value: '8MB' }], ['postgres']);

    // Open via the Unix socket so kinglet_admin trust-auth works
    const conn = new PostgresProcessManager(logger).openAdminConnection(
      join(root, 'cloudsql', 'p', 'wm'),
      port ?? 0
    );

    try {
      const rows = await conn<{ v: string }[]>`SELECT current_setting('work_mem') AS v`;

      expect(rows[0]?.v).toBe('8MB');
    } finally {
      await conn.close({ timeout: 0 });
    }
  });

  test('applyDatabaseFlags accepts a timezone that moves the clock backward', async () => {
    const { plane: started, root } = await plane('sqlite');
    const port = await started.startInstance('p', 'tz', ['postgres']);

    await started.applyDatabaseFlags(
      'p',
      'tz',
      [{ name: 'timezone', value: 'Pacific/Pago_Pago' }],
      ['postgres']
    );

    const conn = new PostgresProcessManager(logger).openAdminConnection(
      join(root, 'cloudsql', 'p', 'tz'),
      port ?? 0
    );

    try {
      const rows = await conn<{ v: string }[]>`SELECT current_setting('TimeZone') AS v`;

      expect(rows[0]?.v).toBe('Pacific/Pago_Pago');
    } finally {
      await conn.close({ timeout: 0 });
    }
  });

  test('applyDatabaseFlags accepts a postmaster-context flag and keeps the server up', async () => {
    const { plane: started, root } = await plane('sqlite');
    await started.startInstance('p', 'mc', ['postgres']);

    // max_connections is postmaster context; this triggers a restart
    await started.applyDatabaseFlags(
      'p',
      'mc',
      [{ name: 'max_connections', value: '105' }],
      ['postgres']
    );

    const newPort = started.getPort('p', 'mc');

    expect(newPort).toBeTypeOf('number');

    const conn = new PostgresProcessManager(logger).openAdminConnection(
      join(root, 'cloudsql', 'p', 'mc'),
      newPort ?? 0
    );

    try {
      const rows = await conn<{ v: string }[]>`SELECT current_setting('max_connections') AS v`;

      expect(rows[0]?.v).toBe('105');
    } finally {
      await conn.close({ timeout: 0 });
    }
  });

  test('applyDatabaseFlags with an empty list resets a flag set earlier', async () => {
    const { plane: started, root } = await plane('sqlite');
    const port = await started.startInstance('p', 'clear', ['postgres']);

    await started.applyDatabaseFlags(
      'p',
      'clear',
      [{ name: 'work_mem', value: '8MB' }],
      ['postgres']
    );
    await started.applyDatabaseFlags('p', 'clear', [], ['postgres']);

    const conn = new PostgresProcessManager(logger).openAdminConnection(
      join(root, 'cloudsql', 'p', 'clear'),
      port ?? 0
    );

    try {
      const rows = await conn<{ v: string }[]>`SELECT current_setting('work_mem') AS v`;

      expect(rows[0]?.v).toBe('4MB');
    } finally {
      await conn.close({ timeout: 0 });
    }
  });

  test('applyDatabaseFlags with an empty list is a no-op', async () => {
    const { plane: started } = await plane('sqlite');
    await started.startInstance('p', 'noop', ['postgres']);

    await expect(
      started.applyDatabaseFlags('p', 'noop', [], ['postgres'])
    ).resolves.toBeUndefined();
  });

  test('applyDatabaseFlags restores the previous GUC when a later flag is rejected', async () => {
    const { plane: started, root } = await plane('sqlite');
    const port = await started.startInstance('p', 'partial', ['postgres']);

    await started.applyDatabaseFlags(
      'p',
      'partial',
      [{ name: 'work_mem', value: '8MB' }],
      ['postgres']
    );

    const promise = started.applyDatabaseFlags(
      'p',
      'partial',
      [
        { name: 'work_mem', value: '16MB' },
        { name: 'not_a_real_guc', value: '1' },
      ],
      ['postgres']
    );

    await expect(promise).rejects.toBeInstanceOf(DatabaseFlagError);

    const conn = new PostgresProcessManager(logger).openAdminConnection(
      join(root, 'cloudsql', 'p', 'partial'),
      port ?? 0
    );

    try {
      const rows = await conn<{ v: string }[]>`SELECT current_setting('work_mem') AS v`;

      expect(rows[0]?.v).toBe('8MB');
    } finally {
      await conn.close({ timeout: 0 });
    }

    const auto = await Bun.file(
      join(root, 'cloudsql', 'p', 'partial', 'postgresql.auto.conf')
    ).text();

    expect(auto).toContain('8MB');
    expect(auto).not.toContain('16MB');
  });

  test('applyDatabaseFlags rejects a setting the process manager owns', async () => {
    const { plane: started } = await plane('sqlite');

    await started.startInstance('p', 'port', ['postgres']);

    const promise = started.applyDatabaseFlags(
      'p',
      'port',
      [{ name: 'port', value: '1' }],
      ['postgres']
    );

    await expect(promise).rejects.toBeInstanceOf(DatabaseFlagError);
  });

  test('applyDatabaseFlags folds a mixed-case postmaster flag and applies it once', async () => {
    const { plane: started, root } = await plane('sqlite');

    await started.startInstance('p', 'case', ['postgres']);
    await started.applyDatabaseFlags(
      'p',
      'case',
      [{ name: 'Max_Connections', value: '107' }],
      ['postgres']
    );

    const conn = new PostgresProcessManager(logger).openAdminConnection(
      join(root, 'cloudsql', 'p', 'case'),
      started.getPort('p', 'case') ?? 0
    );

    try {
      const first = await conn<{ started: string; connections: string }[]>`
        SELECT pg_postmaster_start_time()::text AS started, current_setting('max_connections') AS connections
      `;

      await started.applyDatabaseFlags(
        'p',
        'case',
        [{ name: 'max_connections', value: '107' }],
        ['postgres']
      );

      const second = await conn<{ started: string; connections: string }[]>`
        SELECT pg_postmaster_start_time()::text AS started, current_setting('max_connections') AS connections
      `;

      expect(first[0]?.connections).toBe('107');
      expect(second[0]?.connections).toBe('107');
      expect(second[0]?.started).toBe(first[0]?.started);
    } finally {
      await conn.close({ timeout: 0 });
    }
  }, 20_000);

  test('applyDatabaseFlags rejects an unknown GUC name with DatabaseFlagError', async () => {
    const { plane: started } = await plane('sqlite');
    await started.startInstance('p', 'bad', ['postgres']);

    const promise = started.applyDatabaseFlags(
      'p',
      'bad',
      [{ name: 'kinglet_nonexistent_guc', value: 'x' }],
      ['postgres']
    );

    await expect(promise).rejects.toBeInstanceOf(DatabaseFlagError);
  });

  test('applyDatabaseFlags updates a flag value on a second call', async () => {
    const { plane: started, root } = await plane('sqlite');
    await started.startInstance('p', 'reset', ['postgres']);

    await started.applyDatabaseFlags(
      'p',
      'reset',
      [{ name: 'work_mem', value: '16MB' }],
      ['postgres']
    );

    await started.applyDatabaseFlags(
      'p',
      'reset',
      [{ name: 'work_mem', value: '12MB' }],
      ['postgres']
    );

    const conn = new PostgresProcessManager(logger).openAdminConnection(
      join(root, 'cloudsql', 'p', 'reset'),
      started.getPort('p', 'reset') ?? 0
    );

    try {
      const rows = await conn<{ v: string }[]>`SELECT current_setting('work_mem') AS v`;

      expect(rows[0]?.v).toBe('12MB');
    } finally {
      await conn.close({ timeout: 0 });
    }
  });
});
