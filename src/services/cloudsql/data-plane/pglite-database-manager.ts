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
import { dirname, join, resolve, sep } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { StorageType } from '@/core/storage/types.ts';
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
  storageType: StorageType;
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

interface TrackedDatabase extends OpenDatabase {
  /** The names this database was opened under, kept so nothing has to be
   * recovered by taking a key apart. */
  key: DatabaseKey;
}

/**
 * A key that identifies one database unambiguously.
 *
 * <p>Built from the encoded segments rather than the raw names: a database may
 * legitimately be called `a/b`, and joining raw names would produce a key that
 * cannot be taken apart again — or worse, one that collides with a different
 * project/instance/database triple.
 */
export function buildDatabaseKey(key: DatabaseKey): string {
  return [key.project, key.instance, key.database].map(encodePathSegment).join('/');
}

/**
 * Make one project/instance/database name safe to use as a directory name.
 *
 * <p>These names arrive from the API — the URL path for project and instance,
 * the request body for database — and the admin API deliberately does not
 * constrain a database name, since real Cloud SQL accepts far more than a
 * filesystem path segment does. Percent-encoding keeps that fidelity while
 * making traversal impossible: `..` becomes `%2E%2E`, `a/b` becomes `a%2Fb`,
 * and an ordinary name like `postgres` is left untouched and still readable
 * on disk. `encodeURIComponent` already escapes separators and handles UTF-8;
 * `.` is the one character it leaves through that matters here.
 */
export function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/\./g, '%2E');
}

export class PGliteDatabaseManager {
  private options: PGliteDatabaseManagerOptions;
  private databases = new Map<string, TrackedDatabase>();
  // Opens are slow (a wasm Postgres boot) and `open` is reentrant per key, so
  // in-flight opens are shared rather than duplicated — two connections
  // arriving together for the same database must not build two PGlites, of
  // which one would be silently dropped along with anything written to it.
  private opening = new Map<string, Promise<TrackedDatabase>>();
  // The names behind each in-flight open, for the same reason.
  private openingKeys = new Map<string, DatabaseKey>();

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
    this.openingKeys.set(id, key);

    try {
      return await opening;
    } finally {
      this.opening.delete(id);
      this.openingKeys.delete(id);
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

  /**
   * Close every open database for an instance and delete the instance's whole
   * directory tree.
   *
   * <p>Deliberately driven by what is on disk rather than by what this manager
   * currently has open: an instance whose data plane never came back up after a
   * restart has no open databases, so a drop that only walked the open ones
   * would leave its files behind — and the next instance created with the same
   * name would silently inherit the deleted instance's rows.
   */
  async dropInstance(project: string, instance: string): Promise<void> {
    for (const key of this.trackedKeys()) {
      if (key.project !== project || key.instance !== instance) continue;

      await this.close(key);
    }

    if (this.options.storageType === 'memory') return;

    await rm(this.resolveInstanceDirectory(project, instance), {
      recursive: true,
      force: true,
    });
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.trackedKeys().map(key => this.close(key)));
  }

  /** Every database currently open or being opened, by the names it was opened under. */
  private trackedKeys(): DatabaseKey[] {
    return [
      ...[...this.databases.values()].map(tracked => tracked.key),
      ...this.openingKeys.values(),
    ];
  }

  /**
   * Where this database's files live, or `memory://` when kinglet itself is
   * running without durable storage.
   */
  resolveDataSource(key: DatabaseKey): string {
    if (this.options.storageType === 'memory') return 'memory://';

    return `file://${this.resolveDataDirectory(key)}`;
  }

  /** The directory holding every database for one instance. */
  private resolveInstanceDirectory(project: string, instance: string): string {
    const root = join(dirname(this.options.sqlitePath), 'cloudsql');
    const directory = resolve(root, encodePathSegment(project), encodePathSegment(instance));

    return this.requireContainedIn(root, directory);
  }

  private resolveDataDirectory(key: DatabaseKey): string {
    const root = join(dirname(this.options.sqlitePath), 'cloudsql');
    const directory = resolve(
      this.resolveInstanceDirectory(key.project, key.instance),
      encodePathSegment(key.database)
    );

    return this.requireContainedIn(root, directory);
  }

  /**
   * Refuse to hand back a path outside the data root.
   *
   * <p>Encoding above already prevents this; the check stays because these
   * paths are passed to a recursive delete, where a mistake would take out
   * kinglet's own SQLite file and every other service's state along with it.
   * A cheap invariant is worth it at that blast radius.
   */
  private requireContainedIn(root: string, directory: string): string {
    const resolvedRoot = resolve(root);

    if (directory !== resolvedRoot && !directory.startsWith(`${resolvedRoot}${sep}`)) {
      throw new Error(`Refusing to use a Cloud SQL data directory outside ${resolvedRoot}`);
    }

    return directory;
  }

  private async createDatabase(id: string, key: DatabaseKey): Promise<TrackedDatabase> {
    if (this.options.storageType !== 'memory') {
      // PGlite creates only the leaf directory it is pointed at, so the
      // project/instance path above it has to exist first or the very first
      // database on a fresh data directory fails with ENOENT.
      await mkdir(this.resolveDataDirectory(key), { recursive: true });
    }

    const db = await PGlite.create(this.resolveDataSource(key), {
      extensions: DATA_PLANE_EXTENSIONS,
    });

    const open: TrackedDatabase = {
      db,
      key,
      queue: new PGliteSessionQueue(db as unknown as ProtocolBackend),
    };

    this.databases.set(id, open);

    return open;
  }
}
