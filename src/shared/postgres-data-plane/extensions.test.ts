/**
 * Tests for the data plane's extension set
 */

import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { DATA_PLANE_EXTENSIONS, resolveExtensions } from './extensions.ts';

// The SQL name does not always match the module export: PGlite exports
// `uuid_ossp`, but the extension installs as `uuid-ossp`.
const SQL_NAMES: Record<string, string> = { uuid_ossp: 'uuid-ossp' };

// `auto_explain` is a preload module rather than an extension — real Postgres
// has no control file for it either, so it is used with LOAD and not
// CREATE EXTENSION. Bundled because LOAD still works.
const LOAD_ONLY_MODULES = new Set(['auto_explain']);

describe('DATA_PLANE_EXTENSIONS', () => {
  test('every bundled extension can actually be created', async () => {
    // Asserting the object's keys would only restate the source. What is worth
    // pinning is that each entry is a working PGlite extension: a wrong import
    // or one that ships but fails to load would otherwise surface as a
    // developer's `CREATE EXTENSION` failing at runtime.
    const db = await PGlite.create('memory://', { extensions: DATA_PLANE_EXTENSIONS });
    const failures: string[] = [];

    for (const name of Object.keys(DATA_PLANE_EXTENSIONS)) {
      if (LOAD_ONLY_MODULES.has(name)) continue;

      const sqlName = SQL_NAMES[name] ?? name;

      try {
        await db.exec(`CREATE EXTENSION IF NOT EXISTS "${sqlName}" CASCADE`);
      } catch (error) {
        failures.push(`${sqlName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const installed = await db.query<{ extname: string }>('SELECT extname FROM pg_extension');

    await db.close();

    expect(failures).toEqual([]);
    // These two are separate packages, so a dropped dependency fails here
    // rather than as a missing import.
    const installedNames = installed.rows.map(row => row.extname);

    expect(installedNames).toContain('pg_partman');
    expect(installedNames).toContain('vector');
    expect(Object.keys(DATA_PLANE_EXTENSIONS).length).toBeGreaterThan(20);
  });

  test('a load-only module can still be loaded', async () => {
    const db = await PGlite.create('memory://', { extensions: DATA_PLANE_EXTENSIONS });

    await db.exec("LOAD 'auto_explain'");

    const loaded = await db.query<{ setting: string }>(
      "SELECT setting FROM pg_settings WHERE name = 'auto_explain.log_analyze'"
    );

    await db.close();

    expect(loaded.rows).toHaveLength(1);
  });
});

describe('resolveExtensions', () => {
  test('without postgis returns the base set', () => {
    const extensions = resolveExtensions({ postgis: false });

    expect(extensions).toBe(DATA_PLANE_EXTENSIONS);
    expect('postgis' in extensions).toBe(false);
  });

  test('with postgis enabled, CREATE EXTENSION postgis works', async () => {
    const extensions = resolveExtensions({ postgis: true });
    const db = await PGlite.create('memory://', { extensions });

    await db.exec('CREATE EXTENSION postgis');

    const result = await db.query<{ wkt: string }>('SELECT ST_AsText(ST_MakePoint(1, 2)) AS wkt');

    await db.close();

    expect(result.rows[0]?.wkt).toBe('POINT(1 2)');
  }, 30_000);
});

describe('pg_partman', () => {
  test('creates a daily partition set and run_maintenance honors a higher premake', async () => {
    const db = await PGlite.create('memory://', { extensions: DATA_PLANE_EXTENSIONS });

    await db.exec(`
      SET TIME ZONE 'UTC';
      CREATE SCHEMA partman;
      CREATE EXTENSION pg_partman SCHEMA partman;
      CREATE TABLE events (
        id int,
        created_at timestamptz NOT NULL
      ) PARTITION BY RANGE (created_at);
      SELECT partman.create_parent('public.events', 'created_at', '1 day');
    `);

    const version = await db.query<{ extversion: string }>(
      "SELECT extversion FROM pg_extension WHERE extname = 'pg_partman'"
    );
    const before = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM partman.show_partitions('public.events')"
    );

    // An empty set is left alone unless infinite_time_partitions is on, and the
    // extra children run_maintenance adds depends on the time of day, so the
    // assertion is that the set grew rather than an exact new count.
    await db.exec(`
      UPDATE partman.part_config
      SET premake = 6, infinite_time_partitions = true
      WHERE parent_table = 'public.events';
      SELECT partman.run_maintenance('public.events');
    `);

    const after = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM partman.show_partitions('public.events')"
    );

    await db.close();

    const beforeCount = before.rows[0]?.n ?? -1;
    const afterCount = after.rows[0]?.n ?? -1;

    expect(version.rows[0]?.extversion).toBe('5.5.0');
    expect(beforeCount).toBe(9);
    expect(afterCount).toBeGreaterThan(beforeCount);
  }, 30_000);
});
