/**
 * Tests for DataPlaneManager and DisabledDataPlane
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@/shared/utils/logger.ts';
import type { DataPlaneManagerOptions, LookupUser } from './data-plane-manager.ts';
import { DataPlaneManager, DisabledDataPlane } from './data-plane-manager.ts';

const TEST_PORT_BASE = 46300;

let nextRangeStart = TEST_PORT_BASE;
let managers: DataPlaneManager[] = [];
let temporaryDirectories: string[] = [];

const anyUser: LookupUser = async () => ({ password: '' });

function makeManager(
  overrides: Partial<DataPlaneManagerOptions> = {},
  lookupUser: LookupUser = anyUser
): DataPlaneManager {
  const portRangeStart = nextRangeStart;

  nextRangeStart += 10;

  const manager = new DataPlaneManager(
    new Logger('CloudSqlDataPlaneTest', 'error'),
    {
      portRangeStart,
      portRangeEnd: portRangeStart + 4,
      storageType: 'memory',
      sqlitePath: './data/emulator.db',
      ...overrides,
    },
    lookupUser
  );

  managers.push(manager);

  return manager;
}

async function makeTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kinglet-dataplane-'));

  temporaryDirectories.push(root);

  return root;
}

/**
 * Run one statement through a real Postgres client against the given port.
 *
 * <p>Rows are copied into plain objects because Bun's result carries metadata
 * properties alongside the rows, which structural matchers compare too.
 */
async function runQuery(
  port: number,
  database: string,
  user: string,
  password: string,
  sql: string
): Promise<Record<string, unknown>[]> {
  const client = new Bun.SQL({
    url: `postgres://${user}:${password}@127.0.0.1:${port}/${database}`,
    tls: false,
    max: 1,
  });

  try {
    const rows: Record<string, unknown>[] = await client.unsafe(sql);

    return rows.map(row => ({ ...row }));
  } finally {
    await client.end();
  }
}

afterEach(async () => {
  for (const manager of managers) await manager.stopAll();

  managers = [];

  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }

  temporaryDirectories = [];
});

describe('DataPlaneManager', () => {
  test('allocates ports sequentially from the start of the range', async () => {
    const manager = makeManager();
    const first = await manager.startInstance('p1', 'a', ['postgres']);
    const second = await manager.startInstance('p1', 'b', ['postgres']);

    expect(second).toBe((first ?? 0) + 1);
    expect(manager.getPort('p1', 'a')).toBe(first);
  });

  test('reports no port for an instance that was never started', () => {
    expect(makeManager().getPort('p1', 'ghost')).toBeNull();
  });

  test('serves queries against the instance endpoint', async () => {
    const manager = makeManager();
    const port = await manager.startInstance('p1', 'a', ['postgres']);

    await runQuery(port ?? 0, 'postgres', 'postgres', '', 'CREATE TABLE t (a int)');
    await runQuery(port ?? 0, 'postgres', 'postgres', '', 'INSERT INTO t VALUES (42)');

    expect(await runQuery(port ?? 0, 'postgres', 'postgres', '', 'SELECT a FROM t')).toEqual([
      { a: 42 },
    ]);
  });

  test('keeps databases on the same instance isolated from each other', async () => {
    const manager = makeManager();
    const port = (await manager.startInstance('p1', 'a', ['postgres'])) ?? 0;

    await manager.openDatabase('p1', 'a', 'app');

    await runQuery(port, 'postgres', 'postgres', '', 'CREATE TABLE only_in_postgres (a int)');

    await expect(
      runQuery(port, 'app', 'postgres', '', 'SELECT * FROM only_in_postgres')
    ).rejects.toThrow();
  });

  test('requires the stored password when the user has one', async () => {
    const manager = makeManager({}, async () => ({ password: 's3cret' }));
    const port = (await manager.startInstance('p1', 'a', ['postgres'])) ?? 0;

    expect(await runQuery(port, 'postgres', 'postgres', 's3cret', 'SELECT 1 AS one')).toEqual([
      { one: 1 },
    ]);

    await expect(runQuery(port, 'postgres', 'postgres', 'wrong', 'SELECT 1')).rejects.toThrow();
  });

  test('reads the password live so an updated user takes effect on the next connection', async () => {
    let password = 'first';
    const manager = makeManager({}, async () => ({ password }));
    const port = (await manager.startInstance('p1', 'a', ['postgres'])) ?? 0;

    await runQuery(port, 'postgres', 'postgres', 'first', 'SELECT 1');

    password = 'second';

    await expect(runQuery(port, 'postgres', 'postgres', 'first', 'SELECT 1')).rejects.toThrow();
    expect(await runQuery(port, 'postgres', 'postgres', 'second', 'SELECT 1 AS one')).toEqual([
      { one: 1 },
    ]);
  });

  test('refuses a connection to a database the instance does not have', async () => {
    const manager = makeManager();
    const port = (await manager.startInstance('p1', 'a', ['postgres'])) ?? 0;

    await expect(runQuery(port, 'nope', 'postgres', '', 'SELECT 1')).rejects.toThrow();
  });

  test('refuses a connection from a user the instance does not have', async () => {
    const manager = makeManager({}, async () => null);
    const port = (await manager.startInstance('p1', 'a', ['postgres'])) ?? 0;

    await expect(runQuery(port, 'postgres', 'ghost', '', 'SELECT 1')).rejects.toThrow();
  });

  test('a dropped database stops accepting connections', async () => {
    const manager = makeManager();
    const port = (await manager.startInstance('p1', 'a', ['postgres', 'app'])) ?? 0;

    await runQuery(port, 'app', 'postgres', '', 'SELECT 1');

    await manager.dropDatabase('p1', 'a', 'app');

    await expect(runQuery(port, 'app', 'postgres', '', 'SELECT 1')).rejects.toThrow();
  });

  test('opening a database on an instance that is not running is a no-op', async () => {
    const manager = makeManager();

    await expect(manager.openDatabase('p1', 'ghost', 'app')).resolves.toBeUndefined();
  });

  test('restart rebinds the instance and gives its previous port back', async () => {
    const manager = makeManager();
    const port = await manager.startInstance('p1', 'a', ['postgres']);

    await manager.restartInstance('p1', 'a', ['postgres']);

    expect(manager.getPort('p1', 'a')).toBe(port);
    expect(await runQuery(port ?? 0, 'postgres', 'postgres', '', 'SELECT 1 AS one')).toEqual([
      { one: 1 },
    ]);
  });

  test('stopInstance releases the port for the next instance', async () => {
    const manager = makeManager();
    const port = await manager.startInstance('p1', 'a', ['postgres']);

    await manager.stopInstance('p1', 'a');

    expect(manager.getPort('p1', 'a')).toBeNull();
    expect(await manager.startInstance('p1', 'b', ['postgres'])).toBe(port);
  });

  test('stopping an instance that is not running is a no-op', async () => {
    await expect(makeManager().stopInstance('p1', 'ghost')).resolves.toBeUndefined();
  });

  test('throws once every port in the range is taken', async () => {
    const manager = makeManager();

    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await manager.startInstance('p1', name, []);
    }

    await expect(manager.startInstance('p1', 'f', [])).rejects.toThrow('already in use');
  });

  test('stopInstance leaves persisted data behind for the next start', async () => {
    const root = await makeTemporaryRoot();
    const manager = makeManager({ storageType: 'sqlite', sqlitePath: join(root, 'emulator.db') });
    const port = (await manager.startInstance('p1', 'a', ['postgres'])) ?? 0;

    await runQuery(port, 'postgres', 'postgres', '', 'CREATE TABLE t (a int)');
    await runQuery(port, 'postgres', 'postgres', '', 'INSERT INTO t VALUES (7)');
    await manager.stopInstance('p1', 'a');

    const restarted = (await manager.startInstance('p1', 'a', ['postgres'])) ?? 0;

    expect(await runQuery(restarted, 'postgres', 'postgres', '', 'SELECT a FROM t')).toEqual([
      { a: 7 },
    ]);
  });

  test('dropInstance deletes the persisted data', async () => {
    const root = await makeTemporaryRoot();
    const manager = makeManager({ storageType: 'sqlite', sqlitePath: join(root, 'emulator.db') });

    await manager.startInstance('p1', 'a', ['postgres']);

    const directory = join(root, 'cloudsql/p1/a/postgres');

    expect(existsSync(directory)).toBe(true);

    await manager.dropInstance('p1', 'a');

    expect(existsSync(directory)).toBe(false);
    expect(manager.getPort('p1', 'a')).toBeNull();
  });

  test('dropping an instance that is not running is a no-op', async () => {
    await expect(makeManager().dropInstance('p1', 'ghost')).resolves.toBeUndefined();
  });

  test('dropInstance deletes the data of an instance that is not running', async () => {
    const root = await makeTemporaryRoot();
    const options = { storageType: 'sqlite' as const, sqlitePath: join(root, 'emulator.db') };
    const first = makeManager(options);
    const port = (await first.startInstance('p1', 'a', ['postgres'])) ?? 0;

    await runQuery(port, 'postgres', 'postgres', '', 'CREATE TABLE secrets (id int)');
    await first.stopAll();

    // A manager that never brought the instance up — what a restart leaves
    // behind when the data plane cannot restore it. Deleting the instance must
    // still remove its files, or a new instance of the same name would come up
    // holding the deleted one's tables.
    const second = makeManager(options);

    await second.dropInstance('p1', 'a');

    const restarted = (await second.startInstance('p1', 'a', ['postgres'])) ?? 0;

    await expect(
      runQuery(restarted, 'postgres', 'postgres', '', 'SELECT * FROM secrets')
    ).rejects.toThrow();
  });

  test('stopAll tears every instance down', async () => {
    const manager = makeManager();

    await manager.startInstance('p1', 'a', ['postgres']);
    await manager.startInstance('p1', 'b', ['postgres']);
    await manager.stopAll();

    expect(manager.getPort('p1', 'a')).toBeNull();
    expect(manager.getPort('p1', 'b')).toBeNull();
  });
});

describe('DisabledDataPlane', () => {
  test('advertises no port and does nothing for every lifecycle call', async () => {
    const dataPlane = new DisabledDataPlane();

    expect(await dataPlane.startInstance()).toBeNull();
    expect(dataPlane.getPort()).toBeNull();

    await expect(dataPlane.stopInstance()).resolves.toBeUndefined();
    await expect(dataPlane.dropInstance()).resolves.toBeUndefined();
    await expect(dataPlane.restartInstance()).resolves.toBeUndefined();
    await expect(dataPlane.openDatabase()).resolves.toBeUndefined();
    await expect(dataPlane.dropDatabase()).resolves.toBeUndefined();
    await expect(dataPlane.stopAll()).resolves.toBeUndefined();
  });
});
