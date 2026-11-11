/**
 * One real Postgres server per emulated instance.
 *
 * <p>Clients connect to the server directly. Kinglet only supervises the
 * process and issues the DDL the admin API asked for. See ADR-019.
 */

import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { SQL } from 'bun';
import type { Logger } from '@/shared/utils/logger.ts';
import { PortAllocator } from '@/shared/utils/port-allocator.ts';
import { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import type { DataPlaneLogin, PostgresDataPlane } from './data-plane-manager.ts';
import type { PostgresDataPlaneProduct } from './host.ts';
import { encodePathSegment } from './pglite-database-manager.ts';
import type { PostgresProcessManager } from './postgres-process-manager.ts';

/** The methods {@link PostgresServerDataPlane} calls. A container runtime can match this later. */
export type PostgresSupervisor = Pick<
  PostgresProcessManager,
  'isPostgresAvailable' | 'ensureInitialized' | 'start' | 'stop' | 'openAdminConnection'
>;

export interface PostgresServerDataPlaneOptions {
  product: PostgresDataPlaneProduct;
  /**
   * Parent of the product directory. Null means memory storage: a temp root,
   * removed in {@link PostgresServerDataPlane.stopAll}.
   */
  dataDirectory: string | null;
  portRangeStart: number;
  portRangeEnd: number;
  processManager: PostgresSupervisor;
}

interface RunningInstance {
  port: number;
  dataDir: string;
}

const SUPERUSER_ROLE = 'cloudsqlsuperuser';
const RESERVED_ROLES = new Set(['kinglet_admin', SUPERUSER_ROLE]);

/** Names the data plane owns, plus Postgres's `pg_` prefix. The admin API must not alter them. */
export function isReservedCloudSqlRole(name: string): boolean {
  return RESERVED_ROLES.has(name) || name.startsWith('pg_');
}

/** Quote a Postgres identifier. Names come from the admin API, so `"` is doubled. */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Quote a string literal. `CREATE ROLE ... PASSWORD` rejects parameters, so
 * the password has to be inlined. Callers must not log the statement.
 */
export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function instanceKey(project: string, instance: string): string {
  return `${project}/${instance}`;
}

function splitInstanceKey(key: string): { project: string; instance: string } {
  const separator = key.indexOf('/');

  if (separator < 0) return { project: key, instance: '' };

  return { project: key.slice(0, separator), instance: key.slice(separator + 1) };
}

function isAddressInUse(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';

  return message.includes('Address already in use') || message.includes('could not bind');
}

function postgresErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error == null) return null;

  // Bun reports the SQLSTATE on `errno`. `code` is its own wrapper.
  if ('errno' in error && typeof error.errno === 'string') return error.errno;

  if ('code' in error && typeof error.code === 'string') return error.code;

  return null;
}

export class PostgresServerDataPlane implements PostgresDataPlane {
  private readonly ports: PortAllocator;
  private readonly mutex = new ResourceMutex();
  private readonly running = new Map<string, RunningInstance>();
  private tempRoot: string | undefined;
  private tempRootPromise: Promise<string> | undefined;
  private warnedUnavailable = false;

  constructor(
    private readonly logger: Logger,
    private readonly options: PostgresServerDataPlaneOptions
  ) {
    this.ports = new PortAllocator({
      portRangeStart: options.portRangeStart,
      portRangeEnd: options.portRangeEnd,
    });
  }

  async startInstance(
    project: string,
    instance: string,
    databases: string[]
  ): Promise<number | null> {
    return this.mutex.runExclusively(instanceKey(project, instance), () =>
      this.startInstanceLocked(project, instance, databases)
    );
  }

  async stopInstance(project: string, instance: string): Promise<void> {
    return this.mutex.runExclusively(instanceKey(project, instance), () =>
      this.stopInstanceLocked(project, instance)
    );
  }

  async dropInstance(project: string, instance: string): Promise<void> {
    return this.mutex.runExclusively(instanceKey(project, instance), () =>
      this.dropInstanceLocked(project, instance)
    );
  }

  async restartInstance(project: string, instance: string, databases: string[]): Promise<void> {
    // start replaces a live server and keeps its port. Locking stop and start
    // separately would deadlock: this mutex is not re-entrant.
    await this.startInstance(project, instance, databases);
  }

  async openDatabase(project: string, instance: string, database: string): Promise<void> {
    return this.mutex.runExclusively(instanceKey(project, instance), async () => {
      const current = this.running.get(instanceKey(project, instance));

      if (current == null) return;

      await this.createDatabase(current, database);
    });
  }

  async dropDatabase(project: string, instance: string, database: string): Promise<void> {
    return this.mutex.runExclusively(instanceKey(project, instance), async () => {
      const current = this.running.get(instanceKey(project, instance));

      if (current == null) {
        if (!(await this.clusterExists(project, instance))) return;

        throw new Error(
          `Cloud SQL instance ${project}/${instance} is not running, so database ${database} was not dropped`
        );
      }

      // DROP DATABASE cannot run inside the database being dropped.
      const maintenance = database === 'postgres' ? 'template1' : 'postgres';

      await this.admin(
        current,
        async sql => {
          await sql.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`);
        },
        maintenance
      );
    });
  }

  async stopAll(): Promise<void> {
    const keys = [...this.running.keys()];

    await Promise.all(
      keys.map(key => {
        const { project, instance } = splitInstanceKey(key);

        return this.stopInstance(project, instance);
      })
    );

    if (this.tempRoot == null) return;

    await rm(this.tempRoot, { recursive: true, force: true });
    this.tempRoot = undefined;
    this.tempRootPromise = undefined;
  }

  getPort(project: string, instance: string): number | null {
    return this.running.get(instanceKey(project, instance))?.port ?? null;
  }

  async upsertUser(project: string, instance: string, user: DataPlaneLogin): Promise<void> {
    return this.mutex.runExclusively(instanceKey(project, instance), async () => {
      if (isReservedCloudSqlRole(user.name)) {
        throw new Error(`Role ${user.name} is reserved`);
      }

      const current = this.running.get(instanceKey(project, instance));

      if (current == null) return;

      await this.admin(current, async sql => {
        const ident = quoteIdentifier(user.name);
        const existing = await sql`SELECT 1 AS one FROM pg_roles WHERE rolname = ${user.name}`;
        const login = user.password != null && user.password !== '';
        const attributes = `${user.superuser === true ? 'SUPERUSER' : 'NOSUPERUSER'} ${
          login ? 'LOGIN' : 'NOLOGIN'
        }`;

        if (existing.length === 0 && login && user.password != null) {
          await sql.unsafe(
            `CREATE ROLE ${ident} ${attributes} PASSWORD ${quoteLiteral(user.password)}`
          );
        } else if (existing.length === 0) {
          await sql.unsafe(`CREATE ROLE ${ident} ${attributes}`);
        } else if (login && user.password != null) {
          await sql.unsafe(
            `ALTER ROLE ${ident} ${attributes} PASSWORD ${quoteLiteral(user.password)}`
          );
        } else {
          await sql.unsafe(`ALTER ROLE ${ident} ${attributes}`);
        }

        for (const role of user.memberOf) {
          await sql.unsafe(`GRANT ${quoteIdentifier(role)} TO ${ident}`);
        }
      });
    });
  }

  async dropUser(project: string, instance: string, userName: string): Promise<void> {
    return this.mutex.runExclusively(instanceKey(project, instance), async () => {
      if (isReservedCloudSqlRole(userName)) {
        throw new Error(`Role ${userName} is reserved`);
      }

      const current = this.running.get(instanceKey(project, instance));

      if (current == null) {
        if (!(await this.clusterExists(project, instance))) return;

        throw new Error(
          `Cloud SQL instance ${project}/${instance} is not running, so user ${userName} was not dropped`
        );
      }

      const databases = await this.admin(current, async sql => {
        const existing = await sql`SELECT 1 AS one FROM pg_roles WHERE rolname = ${userName}`;

        if (existing.length === 0) return [] as string[];

        await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${userName} AND pid <> pg_backend_pid()`;

        const rows = await sql<{ datname: string }[]>`
          SELECT datname FROM pg_database WHERE datallowconn
        `;

        return rows.map(row => row.datname);
      });

      if (databases == null || databases.length === 0) return;

      const ident = quoteIdentifier(userName);

      for (const database of databases) {
        await this.admin(
          current,
          async sql => {
            await sql.unsafe(`REASSIGN OWNED BY ${ident} TO kinglet_admin`);
            await sql.unsafe(`DROP OWNED BY ${ident}`);
          },
          database
        );
      }

      try {
        await this.dropRole(current, ident);
      } catch (error) {
        if (postgresErrorCode(error) !== '55006') throw error;

        await Bun.sleep(100);
        await this.admin(current, async sql => {
          await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${userName} AND pid <> pg_backend_pid()`;
        });
        await this.dropRole(current, ident);
      }
    });
  }

  private async dropRole(current: RunningInstance, ident: string): Promise<void> {
    await this.admin(current, async sql => {
      await sql.unsafe(`DROP ROLE IF EXISTS ${ident}`);
    });
  }

  private async startInstanceLocked(
    project: string,
    instance: string,
    databases: string[]
  ): Promise<number | null> {
    if (!this.options.processManager.isPostgresAvailable()) {
      this.warnUnavailable();

      return null;
    }

    const key = instanceKey(project, instance);
    const previous = this.running.get(key);
    const dataDir = this.instanceDirectory(await this.rootDirectory(), project, instance);

    if (previous != null) {
      await this.options.processManager.stop(previous.dataDir);
      this.running.delete(key);
    }

    const refused: number[] = [];
    let port: number | undefined;

    try {
      await mkdir(dirname(dataDir), { recursive: true });
      await this.refusePgliteLayout(dataDir);
      await this.options.processManager.ensureInitialized(dataDir);

      let preferred = previous?.port;

      while (port == null) {
        const allocated = await this.ports.allocate(
          preferred == null ? {} : { preferredPort: preferred }
        );

        preferred = undefined;

        if (allocated == null) {
          throw new Error(
            `No free port in the ${this.options.product.productLabel} data plane range ` +
              `${this.options.portRangeStart}-${this.options.portRangeEnd}`
          );
        }

        port = allocated;

        try {
          await this.options.processManager.start(dataDir, port);
          break;
        } catch (error) {
          if (!isAddressInUse(error)) throw error;

          // The probe only reaches loopback. Postgres binds every interface, so
          // a port can look free and still refuse. Keep it claimed until this
          // attempt finishes, then try the next one.
          refused.push(port);
          port = undefined;
          this.logger.debug(
            `Port ${allocated} looked free but could not be bound for ${key}, trying the next`,
            error
          );
        }
      }

      const current = { port, dataDir };

      await this.ensureSuperuser(current);

      for (const database of databases) {
        await this.createDatabase(current, database);
      }

      this.running.set(key, current);
      this.logger.info(
        `${this.options.product.productLabel} instance ${key} listening on 127.0.0.1:${port}`
      );

      return port;
    } catch (error) {
      await this.options.processManager.stop(dataDir);

      if (port != null) this.ports.release(port);

      throw error;
    } finally {
      for (const refusedPort of refused) this.ports.release(refusedPort);
    }
  }

  private async stopInstanceLocked(project: string, instance: string): Promise<void> {
    const key = instanceKey(project, instance);
    const current = this.running.get(key);

    if (current == null) return;

    this.running.delete(key);
    await this.options.processManager.stop(current.dataDir);
    this.ports.release(current.port);
  }

  private async dropInstanceLocked(project: string, instance: string): Promise<void> {
    await this.stopInstanceLocked(project, instance);

    const root = this.options.dataDirectory ?? this.tempRoot;

    if (root == null) return;

    await rm(this.instanceDirectory(root, project, instance), { recursive: true, force: true });
  }

  private warnUnavailable(): void {
    if (this.warnedUnavailable) return;

    this.warnedUnavailable = true;
    this.logger.warn(
      `${this.options.product.productLabel} Postgres binaries were not found, so instances will ` +
        'expose metadata-only endpoints. Install PostgreSQL or set the product POSTGRES_BIN_DIR, ' +
        'or disable the data plane to silence this'
    );
  }

  private rootDirectory(): Promise<string> {
    if (this.options.dataDirectory != null) return Promise.resolve(this.options.dataDirectory);

    // Assign the promise before the first await so two creates share one root.
    this.tempRootPromise ??= this.createTempRoot();

    return this.tempRootPromise;
  }

  private async createTempRoot(): Promise<string> {
    try {
      const root = await mkdtemp(join(tmpdir(), 'kinglet-pg-'));

      this.tempRoot = root;

      return root;
    } catch (error) {
      this.tempRootPromise = undefined;
      throw error;
    }
  }

  private async clusterExists(project: string, instance: string): Promise<boolean> {
    const root = this.options.dataDirectory ?? this.tempRoot;

    if (root == null) return false;

    try {
      const info = await stat(this.instanceDirectory(root, project, instance));

      return info.isDirectory();
    } catch {
      return false;
    }
  }

  private async refusePgliteLayout(dataDir: string): Promise<void> {
    let entries: string[];

    try {
      entries = await readdir(dataDir);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return;

      throw error;
    }

    if (entries.includes('PG_VERSION') || entries.length === 0) return;

    throw new Error(
      `Refusing to replace ${dataDir} with an empty Postgres cluster. It still has files from the PGlite data plane. Move that directory aside and start the instance again; it will come up empty.`
    );
  }

  private instanceDirectory(root: string, project: string, instance: string): string {
    const directory = resolve(
      root,
      this.options.product.dataDirectoryName,
      encodePathSegment(project),
      encodePathSegment(instance)
    );
    const resolvedRoot = resolve(root);

    if (directory !== resolvedRoot && !directory.startsWith(`${resolvedRoot}${sep}`)) {
      throw new Error(`Refusing to use a data directory outside ${resolvedRoot}`);
    }

    return directory;
  }

  private async ensureSuperuser(current: RunningInstance): Promise<void> {
    await this.admin(current, async sql => {
      const existing = await sql`SELECT 1 AS one FROM pg_roles WHERE rolname = ${SUPERUSER_ROLE}`;

      if (existing.length > 0) return;

      await sql.unsafe(
        `CREATE ROLE ${quoteIdentifier(SUPERUSER_ROLE)} NOLOGIN CREATEDB CREATEROLE`
      );
    });
  }

  private async createDatabase(current: RunningInstance, database: string): Promise<void> {
    await this.admin(current, async sql => {
      try {
        await sql.unsafe(`CREATE DATABASE ${quoteIdentifier(database)}`);
      } catch (error) {
        if (postgresErrorCode(error) !== '42P04') throw error;
      }
    });

    await this.admin(
      current,
      async sql => {
        await sql.unsafe(`GRANT ALL ON SCHEMA public TO ${quoteIdentifier(SUPERUSER_ROLE)}`);
      },
      database
    );
  }

  private async admin<T>(
    current: RunningInstance,
    fn: (sql: SQL) => Promise<T>,
    database = 'postgres'
  ): Promise<T> {
    const sql = this.options.processManager.openAdminConnection(
      current.dataDir,
      current.port,
      database
    );

    try {
      return await fn(sql);
    } finally {
      await sql.close({ timeout: 0 });
    }
  }
}
