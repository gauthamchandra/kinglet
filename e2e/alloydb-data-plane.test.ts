/**
 * End-to-End Test: AlloyDB Data Plane
 *
 * With the data plane enabled, creating an AlloyDB instance brings up a real
 * Postgres wire endpoint backed by the shared PGlite stack (ADR-013). This
 * suite asserts application code can connect with Bun.SQL — the entire point
 * of emulating a data plane rather than metadata only.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { StorageManager } from '@/core/storage/manager.ts';
import { AlloyDbService } from '@/services/alloydb/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { buildRouter } from './e2e-helpers.ts';

// Away from AlloyDB's default 5540 range and from Cloud SQL's e2e range.
const PORT_RANGE_START = 15800;
const PORT_RANGE_END = 15820;

const INSTANCE_BOOT_TIMEOUT_MS = 30_000;

const PROJECT = 'e2e-project';
const LOCATION = 'us-central1';
const CLUSTER = 'data-plane-cluster';
const INSTANCE = 'primary';
const ROOT_PASSWORD = 'root-pass';

let emulatorServer: Server;
let emulatorPort: number;
let alloydbService: AlloyDbService;
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

function portOf(instanceId: string): number {
  const port = alloydbService.getDataPlanePort(PROJECT, LOCATION, CLUSTER, instanceId);

  expect(port).not.toBeNull();

  return port ?? 0;
}

async function expectOk(response: Response, what: string): Promise<void> {
  if (response.status === 200) return;

  const body = await response.text();

  throw new Error(`${what} failed with ${response.status}: ${body}`);
}

async function createCluster(): Promise<void> {
  const response = await fetch(
    emulatorUrl(`/v1/projects/${PROJECT}/locations/${LOCATION}/clusters?clusterId=${CLUSTER}`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initialUser: { user: 'postgres', password: ROOT_PASSWORD },
        networkConfig: { network: `projects/${PROJECT}/global/networks/default` },
      }),
    }
  );

  await expectOk(response, `Creating cluster ${CLUSTER}`);
}

async function createInstance(instanceId: string): Promise<void> {
  const response = await fetch(
    emulatorUrl(
      `/v1/projects/${PROJECT}/locations/${LOCATION}/clusters/${CLUSTER}/instances?instanceId=${instanceId}`
    ),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceType: 'PRIMARY' }),
    }
  );

  await expectOk(response, `Creating instance ${instanceId}`);
}

async function rows(client: Bun.SQL, sql: string): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = await client.unsafe(sql);

  return result.map(row => ({ ...row }));
}

/**
 * Run a statement expected to fail, as a real promise.
 *
 * <p>Bun's query object is a lazy thenable that only runs once something
 * awaits it; handing it straight to `expect(...).rejects` leaves it unstarted
 * and the assertion never settles.
 */
async function run(client: Bun.SQL, sql: string): Promise<void> {
  await client.unsafe(sql);
}

beforeAll(async () => {
  emulatorPort = await getAvailablePort();

  const storage = new StorageManager();

  await storage.initialize({ type: 'memory' });

  alloydbService = new AlloyDbService(storage, new Logger('e2e', 'error'), {
    enabled: true,
    portRangeStart: PORT_RANGE_START,
    portRangeEnd: PORT_RANGE_END,
    storageType: 'memory',
    sqlitePath: './data/emulator.db',
    postgis: false,
  });

  await alloydbService.initialize();

  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: buildRouter(alloydbService.getRoutes()),
  });

  await createCluster();
  await createInstance(INSTANCE);

  instancePort = portOf(INSTANCE);
}, INSTANCE_BOOT_TIMEOUT_MS);

afterEach(async () => {
  for (const client of clients) await client.end();

  clients = [];
});

afterAll(async () => {
  emulatorServer.stop();
  await alloydbService.stop();
});

describe('AlloyDB data plane e2e', () => {
  test('a created instance is a usable Postgres over the wire', async () => {
    const sql = connect(instancePort, 'postgres');

    await sql.unsafe('CREATE TABLE orders (id serial primary key, total numeric)');
    await sql.unsafe('INSERT INTO orders (total) VALUES (10.5), (20.25)');

    expect(await rows(sql, 'SELECT id, total::float8 AS total FROM orders ORDER BY id')).toEqual([
      { id: 1, total: 10.5 },
      { id: 2, total: 20.25 },
    ]);
  });

  test('the cluster initialUser password authenticates', async () => {
    const sql = connect(instancePort, 'postgres', 'postgres', ROOT_PASSWORD);

    expect(await rows(sql, 'SELECT 1 AS ok')).toEqual([{ ok: 1 }]);
  });

  test('a wrong password is rejected', async () => {
    const sql = connect(instancePort, 'postgres', 'postgres', 'not-the-password');

    await expect(run(sql, 'SELECT 1')).rejects.toThrow(
      /password authentication failed for user "postgres"/
    );
  });

  test('contrib and pgvector extensions can be created', async () => {
    const sql = connect(instancePort, 'postgres');

    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');

    expect(await rows(sql, "SELECT similarity('kinglet', 'kinglets') > 0.5 AS close")).toEqual([
      { close: true },
    ]);
  });

  test('getDataPlanePort reports the listening port', () => {
    expect(alloydbService.getDataPlanePort(PROJECT, LOCATION, CLUSTER, INSTANCE)).toBe(
      instancePort
    );
    expect(alloydbService.getDataPlanePort(PROJECT, LOCATION, CLUSTER, 'ghost')).toBeNull();
  });
});
