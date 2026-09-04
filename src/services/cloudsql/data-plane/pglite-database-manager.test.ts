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
import {
  buildDatabaseKey,
  encodePathSegment,
  PGliteDatabaseManager,
} from './pglite-database-manager.ts';

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

  test('stays unambiguous when a name contains a separator', () => {
    // A database may legitimately be called `a/b`. Joining raw names would
    // make this key indistinguishable from instance `inst/a`, database `b`.
    const withSlash = buildDatabaseKey({ project: 'p1', instance: 'inst', database: 'a/b' });
    const shifted = buildDatabaseKey({ project: 'p1', instance: 'inst/a', database: 'b' });

    expect(withSlash).not.toBe(shifted);
  });
});

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

  test('keeps a traversing database name inside the data root', async () => {
    const { manager, root } = await fileManager();
    const cloudsqlRoot = join(root, 'cloudsql');

    // The admin API does not constrain database names, so `..` reaches this
    // layer intact. Left unencoded it would resolve to the instance directory,
    // which `drop` then deletes recursively — taking every other database with
    // it, and for `a/../../..` kinglet's own SQLite file too.
    for (const database of ['..', 'a/../../..', '../../../../etc/pwn']) {
      const source = manager.resolveDataSource({ project: 'p1', instance: 'inst', database });

      expect(source.startsWith(`file://${cloudsqlRoot}/`)).toBe(true);
    }
  });

  test('keeps a traversing project or instance name inside the data root', async () => {
    const { manager, root } = await fileManager();
    const cloudsqlRoot = join(root, 'cloudsql');

    expect(
      manager
        .resolveDataSource({ project: '../..', instance: 'inst', database: 'postgres' })
        .startsWith(`file://${cloudsqlRoot}/`)
    ).toBe(true);
    expect(
      manager
        .resolveDataSource({ project: 'p1', instance: '../..', database: 'postgres' })
        .startsWith(`file://${cloudsqlRoot}/`)
    ).toBe(true);
  });

  test('dropInstance deletes an instance whose databases were never opened', async () => {
    const { manager, root } = await fileManager();

    await manager.open(KEY);
    await manager.close(KEY);

    const instanceDirectory = join(root, 'cloudsql/p1/inst');

    expect(existsSync(instanceDirectory)).toBe(true);

    // A fresh manager has nothing open — the state of an instance whose data
    // plane never came back after a restart. Dropping has to work from disk,
    // or the next instance of the same name inherits these rows.
    const restarted = new PGliteDatabaseManager({
      storageType: 'sqlite',
      sqlitePath: join(root, 'emulator.db'),
    });

    managers.push(restarted);

    await restarted.dropInstance('p1', 'inst');

    expect(existsSync(instanceDirectory)).toBe(false);
  });

  test('closes a database whose name contains a separator', async () => {
    const { manager, root } = await fileManager();
    const slashed = { project: 'p1', instance: 'inst', database: 'a/b' };

    await manager.open(slashed);

    // Recovering the database name by splitting the key used to yield `a`, so
    // the real handle was never closed: the directory was deleted underneath a
    // live PGlite and reopening handed back the stale handle.
    await manager.dropInstance('p1', 'inst');

    expect(manager.get(slashed)).toBeNull();
    expect(existsSync(join(root, 'cloudsql/p1/inst'))).toBe(false);
  });

  test('closeAll closes a database whose name contains a separator', async () => {
    const manager = memoryManager();
    const slashed = { project: 'p1', instance: 'inst', database: 'a/b' };

    await manager.open(slashed);
    await manager.closeAll();

    expect(manager.get(slashed)).toBeNull();
  });

  test('dropInstance closes databases it still holds open', async () => {
    const { manager, root } = await fileManager();

    await manager.open(KEY);
    await manager.dropInstance('p1', 'inst');

    expect(manager.get(KEY)).toBeNull();
    expect(existsSync(join(root, 'cloudsql/p1/inst'))).toBe(false);
  });

  test('refuses an open that races the deletion of its instance', async () => {
    const { manager, root } = await fileManager();

    await manager.open(KEY);

    // Started while the drop is in flight. Allowed through, it would build a
    // fresh backend and recreate the directory being removed, leaving the
    // deleted instance's storage alive behind a handle nothing tracks.
    const dropping = manager.dropInstance('p1', 'inst');
    const raced = manager.open({ project: 'p1', instance: 'inst', database: 'late' });

    await expect(raced).rejects.toThrow('is being deleted');
    await dropping;

    expect(existsSync(join(root, 'cloudsql/p1/inst'))).toBe(false);
  });

  test('fails an open that was already in flight when the deletion began', async () => {
    const { manager, root } = await fileManager();

    // Started first, so it is past the entry guard; the drop begins while the
    // backend is still booting. Returning it would let a caller bring up a
    // listener for a database whose files are being deleted underneath it.
    const opening = manager.open({ project: 'p1', instance: 'inst', database: 'racing' });
    const dropping = manager.dropInstance('p1', 'inst');

    await expect(opening).rejects.toThrow('is being deleted');
    await dropping;

    expect(manager.get({ project: 'p1', instance: 'inst', database: 'racing' })).toBeNull();
    expect(existsSync(join(root, 'cloudsql/p1/inst'))).toBe(false);
  });

  test('refuses an open that races the deletion of that database', async () => {
    const { manager, root } = await fileManager();

    await manager.open(KEY);

    // Dropping one database, not the whole instance: the delete would
    // otherwise remove the directory out from under a backend opened in the
    // same moment, losing the newly created files.
    const dropping = manager.drop(KEY);
    const raced = manager.open(KEY);

    await expect(raced).rejects.toThrow('is being deleted');
    await dropping;

    expect(existsSync(join(root, 'cloudsql/p1/inst/postgres'))).toBe(false);
  });

  test('allows opens again once the deletion is finished', async () => {
    const { manager } = await fileManager();

    await manager.open(KEY);
    await manager.dropInstance('p1', 'inst');

    // A new instance may legitimately reuse the name.
    await expect(manager.open(KEY)).resolves.toBeDefined();
  });

  test('dropping an in-memory instance touches no files', async () => {
    const manager = memoryManager();

    await manager.open(KEY);

    await expect(manager.dropInstance('p1', 'inst')).resolves.toBeUndefined();
    expect(manager.get(KEY)).toBeNull();
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
