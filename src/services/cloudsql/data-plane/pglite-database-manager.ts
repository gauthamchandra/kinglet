/**
 * Owns the PGlite instances behind emulated databases.
 *
 * <p>PGlite has no `CREATE DATABASE` — one PGlite is one database — so the
 * mapping is one PGlite per admin-API `Database` resource, keyed by
 * project/instance/database. The wire server routes to the right one using the
 * `database` parameter of the client's startup message, which is what makes a
 * single listening port able to serve every database on an instance.
 *
 * <p>Nothing here is Cloud-SQL-specific, so AlloyDB can reuse it.
 */

import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { DATA_PLANE_EXTENSIONS } from './extensions.ts';
import type { ProtocolBackend } from './pglite-session-queue.ts';
import { PGliteSessionQueue } from './pglite-session-queue.ts';

export interface DatabaseKey {
  project: string;
  instance: string;
  database: string;
}

export interface PGliteDatabaseManagerOptions {
  /**
   * kinglet's own storage mode. `memory` means the emulator is explicitly
   * running without durable state, so the data plane matches it rather than
   * quietly leaving Postgres data on disk that a restart would resurrect.
   */
  storageType: 'memory' | 'sqlite' | 'hybrid';
  /**
   * Path to kinglet's SQLite file. Database directories are placed beside it,
   * so a developer who points kinglet at a scratch directory gets their
   * Postgres data there too, and deleting that directory really is a reset.
   */
  sqlitePath: string;
}

export interface OpenDatabase {
  db: PGlite;
  queue: PGliteSessionQueue;
}

export function buildDatabaseKey(key: DatabaseKey): string {
  return `${key.project}/${key.instance}/${key.database}`;
}

export class PGliteDatabaseManager {
  private options: PGliteDatabaseManagerOptions;
  private databases = new Map<string, OpenDatabase>();
  // Opens are slow (a wasm Postgres boot) and `open` is reentrant per key, so
  // in-flight opens are shared rather than duplicated — two connections
  // arriving together for the same database must not build two PGlites, of
  // which one would be silently dropped along with anything written to it.
  private opening = new Map<string, Promise<OpenDatabase>>();

  constructor(options: PGliteDatabaseManagerOptions) {
    this.options = options;
  }

  async open(key: DatabaseKey): Promise<OpenDatabase> {
    const id = buildDatabaseKey(key);
    const existing = this.databases.get(id);

    if (existing) return existing;

    const inFlight = this.opening.get(id);

    if (inFlight) return inFlight;

    const opening = this.createDatabase(id, key);

    this.opening.set(id, opening);

    try {
      return await opening;
    } finally {
      this.opening.delete(id);
    }
  }

  get(key: DatabaseKey): OpenDatabase | null {
    return this.databases.get(buildDatabaseKey(key)) ?? null;
  }

  async close(key: DatabaseKey): Promise<void> {
    const id = buildDatabaseKey(key);

    // Await any in-flight open first: closing a key mid-open would otherwise
    // leave the freshly-built PGlite registered and running after the close
    // that was supposed to dispose of it.
    await this.opening.get(id)?.catch(() => undefined);

    const open = this.databases.get(id);

    if (!open) return;

    this.databases.delete(id);

    await open.db.close();
  }

  /**
   * Close a database and delete its on-disk data, so a dropped database really
   * is gone rather than something a later database of the same name inherits.
   */
  async drop(key: DatabaseKey): Promise<void> {
    await this.close(key);

    if (this.options.storageType === 'memory') return;

    await rm(this.resolveDataDirectory(key), { recursive: true, force: true });
  }

  async closeAll(): Promise<void> {
    const keys = [...this.databases.keys(), ...this.opening.keys()];

    await Promise.all(
      keys.map(async id => {
        const [project = '', instance = '', database = ''] = id.split('/');

        await this.close({ project, instance, database });
      })
    );
  }

  /**
   * Where this database's files live, or `memory://` when kinglet itself is
   * running without durable storage.
   */
  resolveDataSource(key: DatabaseKey): string {
    if (this.options.storageType === 'memory') return 'memory://';

    return `file://${this.resolveDataDirectory(key)}`;
  }

  private resolveDataDirectory(key: DatabaseKey): string {
    return join(
      dirname(this.options.sqlitePath),
      'cloudsql',
      key.project,
      key.instance,
      key.database
    );
  }

  private async createDatabase(id: string, key: DatabaseKey): Promise<OpenDatabase> {
    if (this.options.storageType !== 'memory') {
      // PGlite creates only the leaf directory it is pointed at, so the
      // project/instance path above it has to exist first or the very first
      // database on a fresh data directory fails with ENOENT.
      await mkdir(this.resolveDataDirectory(key), { recursive: true });
    }

    const db = await PGlite.create(this.resolveDataSource(key), {
      extensions: DATA_PLANE_EXTENSIONS,
    });

    const open: OpenDatabase = {
      db,
      queue: new PGliteSessionQueue(db as unknown as ProtocolBackend),
    };

    this.databases.set(id, open);

    return open;
  }
}
