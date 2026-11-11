/**
 * Behaviors a real Postgres server has and the PGlite wire server did not:
 * concurrent transactions, session advisory locks, COPY, microsecond now(),
 * pg_stat_statements, and roles that follow the admin API.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { SQL } from 'bun';
import { toStorageConfig } from '@/core/storage/config.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { CloudSqlService } from '@/services/cloudsql/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { buildRouter } from './e2e-helpers.ts';

const PORT_RANGE_START = 16900;
const PORT_RANGE_END = 16920;
const PROJECT = 'e2e-project';
const INSTANCE = 'real-pg';
const ROOT_PASSWORD = 'root-pass';

let emulatorServer: Server;
let emulatorPort: number;
let cloudSqlService: CloudSqlService;
let clients: SQL[] = [];
let instancePort: number;

function emulatorUrl(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

function connect(user = 'postgres', password = ROOT_PASSWORD, database = 'postgres'): SQL {
  const client = new SQL({
    url: `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${instancePort}/${database}`,
    tls: false,
    max: 1,
  });

  clients.push(client);

  return client;
}

async function expectOk(response: Response, what: string): Promise<void> {
  if (response.status === 200) return;

  throw new Error(`${what} failed with ${response.status}: ${await response.text()}`);
}

beforeAll(async () => {
  emulatorPort = await getAvailablePort();

  const storage = new StorageManager();

  await storage.initialize({ type: 'memory' });

  cloudSqlService = new CloudSqlService(storage, new Logger('e2e', 'error'), {
    enabled: true,
    portRangeStart: PORT_RANGE_START,
    portRangeEnd: PORT_RANGE_END,
    storageType: 'memory',
    sqlitePath: './data/emulator.db',
  });

  await cloudSqlService.initialize();

  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: buildRouter(cloudSqlService.getRoutes()),
  });

  const response = await fetch(emulatorUrl(`/v1/projects/${PROJECT}/instances`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: INSTANCE,
      databaseVersion: 'POSTGRES_16',
      rootPassword: ROOT_PASSWORD,
    }),
  });

  await expectOk(response, 'Creating instance');

  const port = cloudSqlService.getDataPlanePort(PROJECT, INSTANCE);

  expect(port).toBeTypeOf('number');

  instancePort = port ?? 0;
}, 30_000);

afterEach(async () => {
  for (const client of clients) await client.close({ timeout: 0 });

  clients = [];
});

afterAll(async () => {
  emulatorServer.stop();
  await cloudSqlService.stop();
});

describe('Cloud SQL on real Postgres', () => {
  test('two transactions on separate connections both commit', async () => {
    const first = connect();
    const second = connect();

    await first.unsafe('CREATE TABLE commits (name text primary key, value int)');

    await Promise.all([
      first.begin(async tx => {
        await tx.unsafe("INSERT INTO commits VALUES ('a', 1)");
      }),
      second.begin(async tx => {
        await tx.unsafe("INSERT INTO commits VALUES ('b', 2)");
      }),
    ]);

    const rows: { name: string }[] = await first.unsafe('SELECT name FROM commits ORDER BY name');

    expect(rows.map(row => row.name)).toEqual(['a', 'b']);
  });

  test('an advisory lock held in one session blocks the other', async () => {
    const holder = connect();
    const other = connect();

    await holder.unsafe('SELECT pg_advisory_lock(1)');

    const rows: { got: boolean }[] = await other.unsafe('SELECT pg_try_advisory_lock(1) AS got');

    expect(rows[0]?.got).toBe(false);

    await holder.unsafe('SELECT pg_advisory_unlock(1)');
  });

  test('COPY FROM STDIN loads rows', async () => {
    const sql = connect();

    await sql.unsafe('CREATE TABLE copied (id int)');

    const binDir = Bun.spawnSync(['pg_config', '--bindir']).stdout.toString().trim();
    const child = Bun.spawn(
      [
        join(binDir, 'psql'),
        `postgres://postgres:${ROOT_PASSWORD}@127.0.0.1:${instancePort}/postgres`,
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        '\\copy copied(id) from stdin',
      ],
      { stdin: new Blob(['1\n2\n']), stdout: 'pipe', stderr: 'pipe' }
    );
    const exitCode = await child.exited;

    expect(exitCode).toBe(0);

    const rows: { id: number }[] = await sql.unsafe('SELECT id FROM copied ORDER BY id');

    expect(rows.map(row => row.id)).toEqual([1, 2]);
  });

  test('now() has microseconds', async () => {
    const sql = connect();
    const rows: { now: string }[] = await sql.unsafe(
      "SELECT to_char(now(), 'YYYY-MM-DD HH24:MI:SS.US') AS now"
    );

    expect(rows[0]?.now).toMatch(/\.\d{6}$/);
  });

  test('pg_stat_statements can be created and read', async () => {
    const sql = connect();

    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');

    const rows: { n: number }[] = await sql.unsafe(
      'SELECT count(*)::int AS n FROM pg_stat_statements'
    );

    expect(rows[0]?.n).toBeGreaterThan(0);
  });

  test('a user can log in, rotate its password, and then not use the old one', async () => {
    const created = await fetch(
      emulatorUrl(`/v1/projects/${PROJECT}/instances/${INSTANCE}/users`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'app-user', password: 'app-pass' }),
      }
    );

    await expectOk(created, 'Creating user');

    const sql = connect('app-user', 'app-pass');

    expect((await sql`select current_user as name`)[0].name).toBe('app-user');
    await sql.close({ timeout: 0 });

    const updated = await fetch(
      emulatorUrl(`/v1/projects/${PROJECT}/instances/${INSTANCE}/users?name=app-user`),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'app-user', password: 'app-pass-2' }),
      }
    );

    await expectOk(updated, 'Updating user');

    const next = connect('app-user', 'app-pass-2');

    expect((await next`select 1 as one`)[0].one).toBe(1);
    await next.close({ timeout: 0 });

    const stale = new SQL({
      url: `postgres://app-user:app-pass@127.0.0.1:${instancePort}/postgres`,
      tls: false,
      max: 1,
      connectionTimeout: 1,
    });

    await expect(Promise.resolve(stale`select 1`)).rejects.toMatchObject({ errno: '28P01' });
    await stale.close({ timeout: 0 });

    const deleted = await fetch(
      emulatorUrl(`/v1/projects/${PROJECT}/instances/${INSTANCE}/users?name=app-user`),
      { method: 'DELETE' }
    );

    await expectOk(deleted, 'Deleting user');

    const removed = new SQL({
      url: `postgres://app-user:app-pass-2@127.0.0.1:${instancePort}/postgres`,
      tls: false,
      max: 1,
      connectionTimeout: 1,
    });

    await expect(Promise.resolve(removed`select 1`)).rejects.toMatchObject({ errno: '28P01' });
    await removed.close({ timeout: 0 });
  });

  test('a row written under sqlite storage is still there after the service restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-cloudsql-real-'));
    const sqlitePath = join(root, 'data', 'emulator.db');
    const rangeStart = PORT_RANGE_END + 1;

    async function boot(): Promise<{ service: CloudSqlService; server: Server }> {
      const storage = new StorageManager();

      await storage.initialize(toStorageConfig({ type: 'sqlite', sqlitePath }));

      const service = new CloudSqlService(storage, new Logger('e2e', 'error'), {
        enabled: true,
        portRangeStart: rangeStart,
        portRangeEnd: rangeStart + 4,
        storageType: 'sqlite',
        sqlitePath,
      });

      await service.initialize();

      const server = Bun.serve({
        port: await getAvailablePort(),
        fetch: buildRouter(service.getRoutes()),
      });

      return { service, server };
    }

    const first = await boot();
    const create = await fetch(
      `http://localhost:${first.server.port}/v1/projects/${PROJECT}/instances`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'durable-real',
          databaseVersion: 'POSTGRES_16',
          rootPassword: ROOT_PASSWORD,
        }),
      }
    );

    await expectOk(create, 'Creating durable instance');

    const port = first.service.getDataPlanePort(PROJECT, 'durable-real');

    expect(port).toBeTypeOf('number');

    const before = new SQL({
      url: `postgres://postgres:${ROOT_PASSWORD}@127.0.0.1:${port}/postgres`,
      tls: false,
      max: 1,
    });

    await before.unsafe('CREATE TABLE survivors (id int)');
    await before.unsafe('INSERT INTO survivors VALUES (99)');
    await before.close({ timeout: 0 });
    first.server.stop();
    await first.service.stop();

    const second = await boot();
    const after = new SQL({
      url: `postgres://postgres:${ROOT_PASSWORD}@127.0.0.1:${second.service.getDataPlanePort(PROJECT, 'durable-real')}/postgres`,
      tls: false,
      max: 1,
    });

    try {
      const rows: { id: number }[] = await after.unsafe('SELECT id FROM survivors');

      expect(rows.map(row => row.id)).toEqual([99]);
    } finally {
      await after.close({ timeout: 0 });
      second.server.stop();
      await second.service.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
