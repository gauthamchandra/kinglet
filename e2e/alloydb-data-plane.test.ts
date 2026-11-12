/**
 * End-to-End Test: AlloyDB Data Plane
 *
 * With the data plane enabled, creating an AlloyDB instance brings up a real
 * Postgres wire endpoint backed by a supervised Postgres server (ADR-019). This
 * suite asserts application code can connect with Bun.SQL — the entire point
 * of emulating a data plane rather than metadata only.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { AlloyDBAdminClient } from '@google-cloud/alloydb';
import type { Server } from 'bun';
import { StorageManager } from '@/core/storage/manager.ts';
import { AlloyDbService } from '@/services/alloydb/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { isRealPostgresAvailable } from '../test-utils/postgres.ts';
import { buildRouter, createFakeAuth } from './e2e-helpers.ts';

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

async function createUser(userId: string, password: string): Promise<void> {
  const response = await fetch(
    emulatorUrl(
      `/v1/projects/${PROJECT}/locations/${LOCATION}/clusters/${CLUSTER}/users?userId=${userId}`
    ),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }
  );

  await expectOk(response, `Creating user ${userId}`);
}

async function deleteUser(userId: string): Promise<void> {
  const response = await fetch(
    emulatorUrl(
      `/v1/projects/${PROJECT}/locations/${LOCATION}/clusters/${CLUSTER}/users/${userId}`
    ),
    { method: 'DELETE' }
  );

  await expectOk(response, `Deleting user ${userId}`);
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

  test('a user created via the admin API can connect with its password', async () => {
    const USER = 'appuser';
    const PASS = 'app-secret';

    await createUser(USER, PASS);

    const sql = connect(instancePort, 'postgres', USER, PASS);

    expect(await rows(sql, 'SELECT 1 AS ok')).toEqual([{ ok: 1 }]);
  });

  test('a deleted user can no longer connect', async () => {
    const USER = 'tempuser';
    const PASS = 'temp-pass';

    await createUser(USER, PASS);
    await deleteUser(USER);

    const sql = connect(instancePort, 'postgres', USER, PASS);

    await expect(run(sql, 'SELECT 1')).rejects.toThrow(
      /password authentication failed for user "tempuser"/
    );
  });
});

/**
 * The raw-HTTP suite above proves the endpoint; this proves the real consumer
 * reaches it. The workflow suite drives the official client with the data plane
 * off, so nothing else exercises the client against an instance that actually
 * listens — including the initialUser password it supplies being the one the
 * wire server then authenticates.
 */
describe('AlloyDB data plane e2e: official client library', () => {
  const CLIENT_CLUSTER = 'client-cluster';
  const CLIENT_INSTANCE = 'primary';
  const CLIENT_PASSWORD = 'client-secret';

  function officialClient(port: number): AlloyDBAdminClient {
    return new AlloyDBAdminClient({
      fallback: 'rest',
      apiEndpoint: 'localhost',
      port,
      protocol: 'http',
      auth: createFakeAuth(PROJECT) as never,
    });
  }

  async function createClusterViaClient(
    client: AlloyDBAdminClient,
    clusterId: string
  ): Promise<string> {
    const parent = `projects/${PROJECT}/locations/${LOCATION}`;
    const [operation] = await client.createCluster({
      parent,
      clusterId,
      cluster: {
        network: `projects/${PROJECT}/global/networks/default`,
        initialUser: { user: 'postgres', password: CLIENT_PASSWORD },
      },
    });

    await operation.promise();

    return `${parent}/clusters/${clusterId}`;
  }

  test(
    'a cluster and instance created through @google-cloud/alloydb are a usable Postgres',
    async () => {
      const client = officialClient(emulatorPort);

      try {
        const cluster = await createClusterViaClient(client, CLIENT_CLUSTER);
        const [instanceOperation] = await client.createInstance({
          parent: cluster,
          instanceId: CLIENT_INSTANCE,
          instance: { instanceType: 'PRIMARY' },
        });
        const [instance] = await instanceOperation.promise();

        expect(instance.name).toBe(`${cluster}/instances/${CLIENT_INSTANCE}`);
        expect(instance.ipAddress).toBe('127.0.0.1');
      } finally {
        await client.close();
      }

      const port = alloydbService.getDataPlanePort(
        PROJECT,
        LOCATION,
        CLIENT_CLUSTER,
        CLIENT_INSTANCE
      );

      expect(port).not.toBeNull();

      const sql = connect(port ?? 0, 'postgres', 'postgres', CLIENT_PASSWORD);

      expect(await rows(sql, 'SELECT 1 AS one')).toEqual([{ one: 1 }]);
    },
    INSTANCE_BOOT_TIMEOUT_MS
  );

  /**
   * A service whose whole port range is one port: the first instance takes it,
   * so the second cannot start its data plane. Real AlloyDB reports that on the
   * operation, and the client's LRO rejects — the create call itself must not
   * fail with a 500 the client was never written to expect.
   */
  describe('when the data plane cannot start', () => {
    const ONLY_PORT = 15890;

    let exhaustedServer: Server;
    let exhaustedService: AlloyDbService;
    let exhaustedPort: number;

    beforeAll(async () => {
      exhaustedPort = await getAvailablePort();

      const storage = new StorageManager();

      await storage.initialize({ type: 'memory' });

      exhaustedService = new AlloyDbService(storage, new Logger('e2e', 'error'), {
        enabled: true,
        portRangeStart: ONLY_PORT,
        portRangeEnd: ONLY_PORT,
        storageType: 'memory',
        sqlitePath: './data/emulator.db',
        postgis: false,
      });

      await exhaustedService.initialize();

      exhaustedServer = Bun.serve({
        port: exhaustedPort,
        fetch: buildRouter(exhaustedService.getRoutes()),
      });
    });

    afterAll(async () => {
      exhaustedServer.stop();
      await exhaustedService.stop();
    });

    test(
      'the official client sees a rejected LRO and no instance, not a transport error',
      async () => {
        const client = officialClient(exhaustedPort);

        try {
          const first = await createClusterViaClient(client, 'takes-the-port');
          const [firstOperation] = await client.createInstance({
            parent: first,
            instanceId: 'primary',
            instance: { instanceType: 'PRIMARY' },
          });

          await firstOperation.promise();

          const second = await createClusterViaClient(client, 'no-port-left');
          const attempt = async () => {
            const [operation] = await client.createInstance({
              parent: second,
              instanceId: 'primary',
              instance: { instanceType: 'PRIMARY' },
            });

            await operation.promise();
          };

          await expect(attempt()).rejects.toThrow(/Failed to start the data plane/);
          await expect(client.getInstance({ name: `${second}/instances/primary` })).rejects.toThrow(
            /not found/i
          );
        } finally {
          await client.close();
        }
      },
      INSTANCE_BOOT_TIMEOUT_MS
    );
  });
});

describe.skipIf(!isRealPostgresAvailable)(
  'AlloyDB data plane e2e: READ_POOL streaming replica',
  () => {
    const RP_CLUSTER = 'rp-cluster';
    const RP_PRIMARY = 'rp-primary';
    const RP_POOL = 'rp-pool';
    const RP_PASSWORD = 'rp-secret';
    const PORT_RANGE_START = 15850;
    const PORT_RANGE_END = 15870;

    let rpServer: Server;
    let rpEmulatorPort: number;
    let rpService: AlloyDbService;
    let rpClients: Bun.SQL[] = [];

    async function waitForReplication(ready: () => Promise<boolean>): Promise<void> {
      const deadline = Date.now() + 5_000;
      let lastError: unknown;

      while (Date.now() < deadline) {
        try {
          if (await ready()) return;
        } catch (error) {
          lastError = error;
        }

        await Bun.sleep(50);
      }

      throw lastError instanceof Error ? lastError : new Error('replication did not catch up');
    }

    function rpConnect(
      port: number,
      database: string,
      user = 'postgres',
      password = RP_PASSWORD
    ): Bun.SQL {
      const client = new Bun.SQL({
        url: `postgres://${user}:${password}@127.0.0.1:${port}/${database}`,
        tls: false,
        max: 1,
      });

      rpClients.push(client);

      return client;
    }

    async function rpExpectOk(response: Response, what: string): Promise<void> {
      if (response.status === 200) return;

      const body = await response.text();

      throw new Error(`${what} failed with ${response.status}: ${body}`);
    }

    function rpEmulatorUrl(path: string): string {
      return `http://localhost:${rpEmulatorPort}${path}`;
    }

    function rpPortOf(instanceId: string): number {
      const port = rpService.getDataPlanePort(PROJECT, LOCATION, RP_CLUSTER, instanceId);

      expect(port).not.toBeNull();

      return port ?? 0;
    }

    beforeAll(async () => {
      rpEmulatorPort = await getAvailablePort();

      const storage = new StorageManager();

      await storage.initialize({ type: 'memory' });

      rpService = new AlloyDbService(storage, new Logger('rp-e2e', 'error'), {
        enabled: true,
        portRangeStart: PORT_RANGE_START,
        portRangeEnd: PORT_RANGE_END,
        storageType: 'memory',
        sqlitePath: './data/emulator.db',
        postgis: false,
      });

      await rpService.initialize();

      rpServer = Bun.serve({
        port: rpEmulatorPort,
        fetch: buildRouter(rpService.getRoutes()),
      });

      await rpExpectOk(
        await fetch(
          rpEmulatorUrl(
            `/v1/projects/${PROJECT}/locations/${LOCATION}/clusters?clusterId=${RP_CLUSTER}`
          ),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              initialUser: { user: 'postgres', password: RP_PASSWORD },
              networkConfig: { network: `projects/${PROJECT}/global/networks/default` },
            }),
          }
        ),
        `Creating cluster ${RP_CLUSTER}`
      );

      await rpExpectOk(
        await fetch(
          rpEmulatorUrl(
            `/v1/projects/${PROJECT}/locations/${LOCATION}/clusters/${RP_CLUSTER}/instances?instanceId=${RP_PRIMARY}`
          ),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instanceType: 'PRIMARY' }),
          }
        ),
        `Creating primary ${RP_PRIMARY}`
      );

      await rpExpectOk(
        await fetch(
          rpEmulatorUrl(
            `/v1/projects/${PROJECT}/locations/${LOCATION}/clusters/${RP_CLUSTER}/instances?instanceId=${RP_POOL}`
          ),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              instanceType: 'READ_POOL',
              readPoolConfig: { nodeCount: 1 },
            }),
          }
        ),
        `Creating read pool ${RP_POOL}`
      );
    }, INSTANCE_BOOT_TIMEOUT_MS * 3);

    afterEach(async () => {
      for (const client of rpClients) await client.end();

      rpClients = [];
    });

    afterAll(async () => {
      rpServer.stop();
      await rpService.stop();
    });

    test('a read pool can select data written on the primary', async () => {
      const primaryPort = rpPortOf(RP_PRIMARY);
      const poolPort = rpPortOf(RP_POOL);
      const primary = rpConnect(primaryPort, 'postgres');

      await primary.unsafe('CREATE TABLE rp_test (id serial primary key, val text)');
      await primary.unsafe("INSERT INTO rp_test (val) VALUES ('hello')");

      const pool = rpConnect(poolPort, 'postgres');

      await waitForReplication(async () => {
        const result: Record<string, unknown>[] = await pool.unsafe(
          'SELECT id, val FROM rp_test ORDER BY id'
        );

        return result.length === 1 && result[0]?.val === 'hello';
      });

      const visible: Record<string, unknown>[] = await pool.unsafe(
        'SELECT val FROM rp_test ORDER BY id'
      );

      expect(visible[0]?.val).toBe('hello');
    });

    test('a write on the read pool is rejected as read-only', async () => {
      const poolPort = rpPortOf(RP_POOL);
      const pool = rpConnect(poolPort, 'postgres');
      // Bun's query object is a lazy thenable; wrapping in an async function forces evaluation.
      const attempt = async (): Promise<void> => {
        await pool.unsafe('CREATE TABLE should_fail (id int)');
      };

      await expect(attempt()).rejects.toThrow(/read-only|cannot execute|standby/i);
    });

    test('nodeCount is preserved and returned in the instance response', async () => {
      const response = await fetch(
        rpEmulatorUrl(
          `/v1/projects/${PROJECT}/locations/${LOCATION}/clusters/${RP_CLUSTER}/instances/${RP_POOL}`
        )
      );

      await rpExpectOk(response, 'Getting read pool');

      const instance = (await response.json()) as Record<string, unknown>;
      const readPoolConfig = instance.readPoolConfig as Record<string, unknown> | undefined;

      expect(readPoolConfig?.nodeCount).toBe(1);
    });

    test('a user created on the cluster can log into the read pool without a separate upsertUser', async () => {
      const replicaUser = 'repl-user';
      const replicaPass = 'repl-pass';

      await rpExpectOk(
        await fetch(
          rpEmulatorUrl(
            `/v1/projects/${PROJECT}/locations/${LOCATION}/clusters/${RP_CLUSTER}/users?userId=${replicaUser}`
          ),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: replicaPass }),
          }
        ),
        `Creating user ${replicaUser}`
      );

      const poolPort = rpPortOf(RP_POOL);
      const pool = rpConnect(poolPort, 'postgres', replicaUser, replicaPass);

      await waitForReplication(async () => {
        const result: Record<string, unknown>[] = await pool.unsafe('SELECT 1 AS ok');

        return result[0]?.ok === 1;
      });

      const visible: Record<string, unknown>[] = await pool.unsafe('SELECT 1 AS ok');

      expect(visible[0]?.ok).toBe(1);
    });
  }
);
