/**
 * Tests for PGliteDatabaseManager
 *
 * These build real PGlite instances: the point of the manager is where the
 * data lands and whether it is disposed of, which a fake would not exercise.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDatabaseKey, PGliteDatabaseManager } from './pglite-database-manager.ts';

const KEY = { project: 'p1', instance: 'inst', database: 'postgres' };

let managers: PGliteDatabaseManager[] = [];
let temporaryDirectories: string[] = [];

function memoryManager(): PGliteDatabaseManager {
  const manager = new PGliteDatabaseManager({
    storageType: 'memory',
    sqlitePath: './data/emulator.db',
  });

  managers.push(manager);

  return manager;
}

async function fileManager(): Promise<{ manager: PGliteDatabaseManager; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'kinglet-pglite-'));

  temporaryDirectories.push(root);

  const manager = new PGliteDatabaseManager({
    storageType: 'sqlite',
    sqlitePath: join(root, 'emulator.db'),
  });

  managers.push(manager);

  return { manager, root };
}

afterEach(async () => {
  for (const manager of managers) await manager.closeAll();

  managers = [];

  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }

  temporaryDirectories = [];
});

describe('buildDatabaseKey', () => {
  test('scopes a database by project and instance', () => {
    expect(buildDatabaseKey(KEY)).toBe('p1/inst/postgres');
  });
});

describe('PGliteDatabaseManager', () => {
  test('uses an in-memory data source when kinglet itself is in-memory', () => {
    expect(memoryManager().resolveDataSource(KEY)).toBe('memory://');
  });

  test('places file-backed databases beside kinglet own store', async () => {
    const { manager, root } = await fileManager();

    expect(manager.resolveDataSource(KEY)).toBe(
      `file://${join(root, 'cloudsql/p1/inst/postgres')}`
    );
  });

  test('opens a queryable database and returns the same one on reopen', async () => {
    const manager = memoryManager();
    const open = await manager.open(KEY);

    await open.db.exec('CREATE TABLE t (a int); INSERT INTO t VALUES (1)');

    expect((await manager.open(KEY)).db).toBe(open.db);
    expect((await open.db.query('SELECT a FROM t')).rows).toEqual([{ a: 1 }]);
  });

  test('builds only one database when two opens race for the same key', async () => {
    const manager = memoryManager();
    const [first, second] = await Promise.all([manager.open(KEY), manager.open(KEY)]);

    expect(first.db).toBe(second.db);
  });

  test('loads the contrib and pgvector extension set', async () => {
    const manager = memoryManager();
    const open = await manager.open(KEY);

    await open.db.exec('CREATE EXTENSION pg_trgm; CREATE EXTENSION vector');

    const result = await open.db.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('pg_trgm', 'vector') ORDER BY extname"
    );

    expect(result.rows).toEqual([{ extname: 'pg_trgm' }, { extname: 'vector' }]);
  });

  test('close forgets the database and reopening starts a fresh one in memory', async () => {
    const manager = memoryManager();
    const open = await manager.open(KEY);

    await manager.close(KEY);

    expect(manager.get(KEY)).toBeNull();
    expect((await manager.open(KEY)).db).not.toBe(open.db);
  });

  test('closing an unknown key is a no-op', async () => {
    await expect(memoryManager().close(KEY)).resolves.toBeUndefined();
  });

  test('a file-backed database keeps its data across a close and reopen', async () => {
    const { manager } = await fileManager();
    const open = await manager.open(KEY);

    await open.db.exec('CREATE TABLE t (a int); INSERT INTO t VALUES (7)');
    await manager.close(KEY);

    const reopened = await manager.open(KEY);

    expect((await reopened.db.query('SELECT a FROM t')).rows).toEqual([{ a: 7 }]);
  });

  test('drop deletes the data directory so a later database of the same name starts empty', async () => {
    const { manager, root } = await fileManager();
    const open = await manager.open(KEY);
    const directory = join(root, 'cloudsql/p1/inst/postgres');

    await open.db.exec('CREATE TABLE t (a int)');
    await manager.close(KEY);

    expect(existsSync(directory)).toBe(true);

    await manager.drop(KEY);

    expect(existsSync(directory)).toBe(false);

    const recreated = await manager.open(KEY);

    await expect(recreated.db.query('SELECT a FROM t')).rejects.toThrow();
  });

  test('dropping an in-memory database touches no files', async () => {
    const manager = memoryManager();

    await manager.open(KEY);

    await expect(manager.drop(KEY)).resolves.toBeUndefined();
    expect(manager.get(KEY)).toBeNull();
  });

  test('closeAll disposes every open database', async () => {
    const manager = memoryManager();
    const other = { ...KEY, database: 'app' };

    await manager.open(KEY);
    await manager.open(other);
    await manager.closeAll();

    expect(manager.get(KEY)).toBeNull();
    expect(manager.get(other)).toBeNull();
  });
});
