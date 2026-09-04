/**
 * Tests for the data plane's extension set
 */

import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { DATA_PLANE_EXTENSIONS } from './extensions.ts';

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
    // pgvector is the one non-contrib extension, and the reason it is a
    // separate dependency — worth naming so a lost dependency is obvious.
    expect(installed.rows.map(row => row.extname)).toContain('vector');
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
