/**
 * End-to-End Test: Cloud SQL Data Plane
 *
 * With the data plane enabled, creating an Instance brings up a real Postgres
 * wire endpoint backed by PGlite. This suite asserts application code can
 * connect to it with Bun's built-in Bun.SQL and use it as a database — the
 * entire point of emulating a data plane rather than metadata only.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { toStorageConfig } from '@/core/storage/config.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { CloudSqlService } from '@/services/cloudsql/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { buildRouter } from './e2e-helpers.ts';

// Away from 5432 so the suite cannot collide with a Postgres the developer
// already runs locally, and away from the control-plane e2e suite's range. The
// ports actually used are read back from the service rather than assumed: the
// allocator skips anything already listening, so the first port in the range
// is not guaranteed to be the one an instance landed on.
const PORT_RANGE_START = 15700;
const PORT_RANGE_END = 15720;

// Creating an instance boots a wasm Postgres per database, which is fast but
// not uniformly so across CI runners. The tests that do it get an explicit
// budget rather than relying on the 5s default they would otherwise sit at
// roughly half of.
const INSTANCE_BOOT_TIMEOUT_MS = 30_000;

const PROJECT = 'e2e-project';
const INSTANCE = 'data-plane-db';
const ROOT_PASSWORD = 'root-pass';

let emulatorServer: Server;
let emulatorPort: number;
let cloudSqlService: CloudSqlService;
let clients: Bun.SQL[] = [];
let instancePort: number;

function emulatorUrl(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

function connect(
  port: number,
  database: string,
  user = 'postgres',
  password = ROOT_PASSWORD
): Bun.SQL {
  const client = new Bun.SQL({
    url: `postgres://${user}:${password}@127.0.0.1:${port}/${database}`,
    tls: false,
    max: 1,
  });

  clients.push(client);

  return client;
}

function portOf(instance: string): number {
  const port = cloudSqlService.getDataPlanePort(PROJECT, instance);

  expect(port).not.toBeNull();

  return port ?? 0;
}

async function createInstance(name: string): Promise<void> {
  const response = await fetch(emulatorUrl(`/v1/projects/${PROJECT}/instances`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      databaseVersion: 'POSTGRES_16',
      rootPassword: ROOT_PASSWORD,
    }),
  });

  expect(response.status).toBe(200);
}

async function createDatabase(instance: string, name: string): Promise<void> {
  const response = await fetch(
    emulatorUrl(`/v1/projects/${PROJECT}/instances/${instance}/databases`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }
  );

  expect(response.status).toBe(200);
}

/** Rows as plain objects: Bun's result carries metadata alongside them. */
async function rows(client: Bun.SQL, sql: string): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = await client.unsafe(sql);

  return result.map(row => ({ ...row }));
}

/**
 * Run a statement expected to fail, as a real promise.
 *
 * <p>Bun's query object is a lazy thenable that only runs once something
 * awaits it; handing it straight to `expect(...).rejects` leaves it unstarted
 * and the assertion never settles. Awaiting inside an async function is what
 * makes the failure observable.
 */
async function run(client: Bun.SQL, sql: string): Promise<void> {
  await client.unsafe(sql);
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

  await createInstance(INSTANCE);

  instancePort = portOf(INSTANCE);
}, INSTANCE_BOOT_TIMEOUT_MS);

afterEach(async () => {
  for (const client of clients) await client.end();

  clients = [];
});

afterAll(async () => {
  emulatorServer.stop();
  await cloudSqlService.stop();
});

describe('Cloud SQL data plane e2e', () => {
  test('a created instance is a usable Postgres over the wire', async () => {
    const sql = connect(instancePort, 'postgres');

    await sql.unsafe('CREATE TABLE orders (id serial primary key, total numeric)');
    await sql.unsafe('INSERT INTO orders (total) VALUES (10.5), (20.25)');

    expect(await rows(sql, 'SELECT id, total::float8 AS total FROM orders ORDER BY id')).toEqual([
      { id: 1, total: 10.5 },
      { id: 2, total: 20.25 },
    ]);
  });

  test('contrib and pgvector extensions can be created', async () => {
    const sql = connect(instancePort, 'postgres');

    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');

    expect(await rows(sql, "SELECT similarity('kinglet', 'kinglets') > 0.5 AS close")).toEqual([
      { close: true },
    ]);

    await sql.unsafe('CREATE TABLE embeddings (v vector(3))');
    await sql.unsafe("INSERT INTO embeddings VALUES ('[1,2,3]')");

    expect(await rows(sql, "SELECT (v <-> '[1,2,3]')::float8 AS distance FROM embeddings")).toEqual(
      [{ distance: 0 }]
    );
  });

  test(
    'a database added through the admin API is reachable and isolated',
    async () => {
      await createDatabase(INSTANCE, 'analytics');

      const analytics = connect(instancePort, 'analytics');

      await analytics.unsafe('CREATE TABLE events (id int)');
      await analytics.unsafe('INSERT INTO events VALUES (1)');

      expect(await rows(analytics, 'SELECT id FROM events')).toEqual([{ id: 1 }]);

      // The default database must not see the other database's table.
      const postgres = connect(instancePort, 'postgres');

      await expect(run(postgres, 'SELECT id FROM events')).rejects.toThrow();
    },
    INSTANCE_BOOT_TIMEOUT_MS
  );

  test('the wrong password is refused', async () => {
    const sql = connect(instancePort, 'postgres', 'postgres', 'not-the-password');

    await expect(run(sql, 'SELECT 1')).rejects.toThrow();
  });

  test('an unknown database is refused', async () => {
    const sql = connect(instancePort, 'no-such-database');

    await expect(run(sql, 'SELECT 1')).rejects.toThrow();
  });

  test('an unknown user is refused', async () => {
    const sql = connect(instancePort, 'postgres', 'ghost', '');

    await expect(run(sql, 'SELECT 1')).rejects.toThrow();
  });

  test('a user added through the admin API can connect with its own password', async () => {
    const response = await fetch(
      emulatorUrl(`/v1/projects/${PROJECT}/instances/${INSTANCE}/users`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'app-user', password: 'app-pass' }),
      }
    );

    expect(response.status).toBe(200);

    const sql = connect(instancePort, 'postgres', 'app-user', 'app-pass');

    expect(await rows(sql, 'SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });

  test('an emulated user gates the connection but is not a Postgres role', async () => {
    const response = await fetch(
      emulatorUrl(`/v1/projects/${PROJECT}/instances/${INSTANCE}/users`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'reporting', password: 'reporting-pass' }),
      }
    );

    expect(response.status).toBe(200);

    const sql = connect(instancePort, 'postgres', 'reporting', 'reporting-pass');

    // The credentials are enforced, but the session behind them is PGlite's own
    // superuser: emulated users are not real roles. Pinned so the limitation in
    // ADR-013 cannot drift silently.
    expect(await rows(sql, 'SELECT current_user AS who')).toEqual([{ who: 'postgres' }]);
  });

  test('two connections can run the same parameterised query', async () => {
    const first = connect(instancePort, 'postgres');
    const second = connect(instancePort, 'postgres');

    await first.unsafe('CREATE TABLE lookups (id int primary key, label text)');
    await first.unsafe("INSERT INTO lookups VALUES (1, 'one'), (2, 'two')");

    // Every connection to a database shares one PGlite backend, and clients
    // derive a prepared-statement name from the query text — so the same
    // parameterised query on two connections used to collide in the shared
    // statement namespace with SQLSTATE 42P05. This is what a connection pool
    // does constantly.
    const firstRows = await first`SELECT label FROM lookups WHERE id = ${1}`;
    const secondRows = await second`SELECT label FROM lookups WHERE id = ${2}`;

    expect([...firstRows].map(row => ({ ...row }))).toEqual([{ label: 'one' }]);
    expect([...secondRows].map(row => ({ ...row }))).toEqual([{ label: 'two' }]);
  });

  test('a connection pool can hammer one parameterised query concurrently', async () => {
    const pool = new Bun.SQL({
      url: `postgres://postgres:${ROOT_PASSWORD}@127.0.0.1:${instancePort}/postgres`,
      tls: false,
      max: 5,
    });

    await pool.unsafe('CREATE TABLE pooled (id int primary key, label text)');
    await pool.unsafe("INSERT INTO pooled VALUES (1, 'one'), (2, 'two')");

    const results = await Promise.all(
      Array.from(
        { length: 20 },
        (_, index) => pool`SELECT label FROM pooled WHERE id = ${(index % 2) + 1}`
      )
    );

    expect(results.map(rows => [...rows].length)).toEqual(Array.from({ length: 20 }, () => 1));

    await pool.end();
  });

  test('two connections can each run a transaction against the same database', async () => {
    const first = connect(instancePort, 'postgres');
    const second = connect(instancePort, 'postgres');

    await first.unsafe('CREATE TABLE counters (name text primary key, value int)');

    await Promise.all([
      first.begin(async tx => {
        await tx.unsafe("INSERT INTO counters VALUES ('a', 1)");
      }),
      second.begin(async tx => {
        await tx.unsafe("INSERT INTO counters VALUES ('b', 2)");
      }),
    ]);

    expect(await rows(first, 'SELECT name, value FROM counters ORDER BY name')).toEqual([
      { name: 'a', value: 1 },
      { name: 'b', value: 2 },
    ]);
  });

  test(
    'a second instance gets its own endpoint and its own data',
    async () => {
      await createInstance('second-db');

      const second = connect(portOf('second-db'), 'postgres');

      await second.unsafe('CREATE TABLE only_here (id int)');

      expect(await rows(second, 'SELECT count(*)::int AS n FROM only_here')).toEqual([{ n: 0 }]);

      const first = connect(instancePort, 'postgres');

      await expect(run(first, 'SELECT id FROM only_here')).rejects.toThrow();
    },
    INSTANCE_BOOT_TIMEOUT_MS
  );
});

describe('Cloud SQL data plane persistence', () => {
  test(
    'an instance and its data survive a restart on durable storage',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'kinglet-cloudsql-e2e-'));
      const sqlitePath = join(root, 'data', 'emulator.db');
      const rangeStart = PORT_RANGE_START + 10;

      // `hybrid` is kinglet's default storage type. Both the control-plane rows
      // and the data plane's Postgres files have to outlive the process for a
      // restart to be a no-op from the caller's point of view.
      async function bootService(): Promise<{ service: CloudSqlService; server: Server }> {
        const storage = new StorageManager();

        await storage.initialize(toStorageConfig({ type: 'hybrid', sqlitePath }));

        const service = new CloudSqlService(storage, new Logger('e2e', 'error'), {
          enabled: true,
          portRangeStart: rangeStart,
          portRangeEnd: rangeStart + 5,
          storageType: 'hybrid',
          sqlitePath,
        });

        await service.initialize();

        const httpPort = await getAvailablePort();
        const server = Bun.serve({ port: httpPort, fetch: buildRouter(service.getRoutes()) });

        return { service, server };
      }

      const first = await bootService();

      const createResponse = await fetch(
        `http://localhost:${first.server.port}/v1/projects/${PROJECT}/instances`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'durable-db',
            databaseVersion: 'POSTGRES_16',
            rootPassword: ROOT_PASSWORD,
          }),
        }
      );

      expect(createResponse.status).toBe(200);

      const port = first.service.getDataPlanePort(PROJECT, 'durable-db');

      expect(port).not.toBeNull();

      const before = connect(port ?? 0, 'postgres');

      await before.unsafe('CREATE TABLE survivors (id int)');
      await before.unsafe('INSERT INTO survivors VALUES (99)');
      await before.end();

      first.server.stop();
      await first.service.stop();

      // A second service over the same files, creating nothing: the instance and
      // its endpoint have to come back on their own.
      const second = await bootService();

      const getResponse = await fetch(
        `http://localhost:${second.server.port}/v1/projects/${PROJECT}/instances/durable-db`
      );

      expect(getResponse.status).toBe(200);
      expect(second.service.getDataPlanePort(PROJECT, 'durable-db')).toBe(port);

      const after = connect(port ?? 0, 'postgres');

      expect(await rows(after, 'SELECT id FROM survivors')).toEqual([{ id: 99 }]);

      await after.end();
      second.server.stop();
      await second.service.stop();

      await rm(root, { recursive: true, force: true });
    },
    INSTANCE_BOOT_TIMEOUT_MS
  );
});
