/**
 * The data plane's facade: one listening Postgres endpoint per emulated
 * instance, backed by one PGlite per database on it.
 *
 * <p>The admin service talks only to the {@link CloudSqlDataPlane} interface,
 * so the control plane can run without a data plane at all
 * ({@link DisabledDataPlane}) and so tests can substitute a double instead of
 * booting wasm Postgres.
 *
 * <p>Nothing here is Cloud-SQL-specific beyond the name, so AlloyDB can reuse
 * it.
 */

import type { Logger } from '@/shared/utils/logger.ts';
import type { DatabaseKey } from './pglite-database-manager.ts';
import { PGliteDatabaseManager } from './pglite-database-manager.ts';
import { PortAllocator } from './port-allocator.ts';
import type { ConnectionResolution } from './postgres-wire-server.ts';
import {
  PostgresWireServer,
  SQLSTATE_INVALID_AUTHORIZATION_SPECIFICATION,
  SQLSTATE_INVALID_CATALOG_NAME,
} from './postgres-wire-server.ts';

/** The address handed to clients, matching Memorystore's reasoning: loopback
 * is correct both for kinglet run directly on the developer's machine and for
 * kinglet in Docker with the data-plane range published. */
const ADVERTISED_HOST = '127.0.0.1';

export interface CloudSqlDataPlane {
  /**
   * Bring up an instance's endpoint with the given databases open, returning
   * the port it listens on, or null when no data plane is running.
   */
  startInstance(project: string, instance: string, databases: string[]): Promise<number | null>;
  /** Tear down the endpoint but leave any persisted data alone. */
  stopInstance(project: string, instance: string): Promise<void>;
  /** Tear down the endpoint and delete the instance's data. */
  dropInstance(project: string, instance: string): Promise<void>;
  restartInstance(project: string, instance: string, databases: string[]): Promise<void>;
  openDatabase(project: string, instance: string, database: string): Promise<void>;
  dropDatabase(project: string, instance: string, database: string): Promise<void>;
  stopAll(): Promise<void>;
  getPort(project: string, instance: string): number | null;
}

/** The user record the data plane needs to authenticate a connection. */
export interface DataPlaneUser {
  password: string;
}

export type LookupUser = (
  project: string,
  instance: string,
  user: string
) => Promise<DataPlaneUser | null>;

export interface DataPlaneManagerOptions {
  portRangeStart: number;
  portRangeEnd: number;
  storageType: 'memory' | 'sqlite' | 'hybrid';
  sqlitePath: string;
}

interface RunningInstance {
  port: number;
  wireServer: PostgresWireServer;
  databases: Set<string>;
}

function buildInstanceKey(project: string, instance: string): string {
  return `${project}/${instance}`;
}

function splitInstanceKey(key: string): { project: string; instance: string } {
  const [project = '', instance = ''] = key.split('/');

  return { project, instance };
}

export class DataPlaneManager implements CloudSqlDataPlane {
  private logger: Logger;
  private options: DataPlaneManagerOptions;
  private lookupUser: LookupUser;
  private databaseManager: PGliteDatabaseManager;
  private portAllocator: PortAllocator;
  private instances = new Map<string, RunningInstance>();

  constructor(logger: Logger, options: DataPlaneManagerOptions, lookupUser: LookupUser) {
    this.logger = logger;
    this.options = options;
    this.lookupUser = lookupUser;
    this.databaseManager = new PGliteDatabaseManager({
      storageType: options.storageType,
      sqlitePath: options.sqlitePath,
    });
    this.portAllocator = new PortAllocator({
      portRangeStart: options.portRangeStart,
      portRangeEnd: options.portRangeEnd,
    });
  }

  async startInstance(
    project: string,
    instance: string,
    databases: string[]
  ): Promise<number | null> {
    const key = buildInstanceKey(project, instance);
    const existing = this.instances.get(key);

    // A restart, or a retried create: the old listener has to go before a new
    // one can bind, and its port must be given back rather than leaked.
    if (existing) await this.stopInstance(project, instance);

    const port = await this.portAllocator.allocate();

    if (port == null) {
      throw new Error(
        `Cannot start a Cloud SQL data plane for ${key}: every port in ` +
          `${this.options.portRangeStart}-${this.options.portRangeEnd} is already in use`
      );
    }

    const wireServer = new PostgresWireServer({
      instanceKey: key,
      port,
      resolveConnection: (instanceKey, database, user) =>
        this.resolveConnection(instanceKey, database, user),
    });

    const running: RunningInstance = { port, wireServer, databases: new Set() };

    this.instances.set(key, running);

    try {
      // Databases are opened before the port accepts anything, so the first
      // connection is not raced against a wasm Postgres still booting.
      for (const database of databases) {
        await this.openDatabase(project, instance, database);
      }

      wireServer.listen();

      // The port is the one thing a developer cannot discover from the API
      // response, which stays byte-faithful to sqladmin and so has nowhere to
      // put a kinglet-only field. Logging it at start is how they find it.
      this.logger.info(`Cloud SQL instance ${key} listening on ${ADVERTISED_HOST}:${port}`);
    } catch (error) {
      await this.stopInstance(project, instance);

      throw error;
    }

    return port;
  }

  async stopInstance(project: string, instance: string): Promise<void> {
    const key = buildInstanceKey(project, instance);
    const running = this.instances.get(key);

    if (!running) return;

    this.instances.delete(key);
    running.wireServer.stop();

    for (const database of running.databases) {
      await this.databaseManager.close({ project, instance, database });
    }

    this.portAllocator.release(running.port);
  }

  async dropInstance(project: string, instance: string): Promise<void> {
    const running = this.instances.get(buildInstanceKey(project, instance));
    const databases = running ? [...running.databases] : [];

    await this.stopInstance(project, instance);

    for (const database of databases) {
      await this.databaseManager.drop({ project, instance, database });
    }
  }

  async restartInstance(project: string, instance: string, databases: string[]): Promise<void> {
    await this.startInstance(project, instance, databases);
  }

  async openDatabase(project: string, instance: string, database: string): Promise<void> {
    const running = this.instances.get(buildInstanceKey(project, instance));

    // Nothing is listening for this instance, so there is no session to serve
    // and booting a PGlite now would only be wasted work: the next
    // startInstance opens it with the rest.
    if (!running) return;

    await this.databaseManager.open({ project, instance, database });

    running.databases.add(database);
  }

  async dropDatabase(project: string, instance: string, database: string): Promise<void> {
    this.instances.get(buildInstanceKey(project, instance))?.databases.delete(database);

    await this.databaseManager.drop({ project, instance, database });
  }

  async stopAll(): Promise<void> {
    for (const key of [...this.instances.keys()]) {
      const { project, instance } = splitInstanceKey(key);

      await this.stopInstance(project, instance);
    }

    await this.databaseManager.closeAll();
  }

  getPort(project: string, instance: string): number | null {
    return this.instances.get(buildInstanceKey(project, instance))?.port ?? null;
  }

  /**
   * Decide whether a startup packet may proceed, and to which PGlite.
   *
   * <p>Users are read live rather than cached at start time, so a password
   * changed through `users.update` takes effect on the next connection exactly
   * as it would on a real instance.
   */
  private async resolveConnection(
    instanceKey: string,
    database: string,
    user: string
  ): Promise<ConnectionResolution> {
    const { project, instance } = splitInstanceKey(instanceKey);
    const running = this.instances.get(instanceKey);
    const key: DatabaseKey = { project, instance, database };
    const open = running?.databases.has(database) === true ? this.databaseManager.get(key) : null;

    if (!open) {
      // Logged because the client only ever sees a SQLSTATE: without this a
      // developer who mistyped a database name has nothing on the emulator
      // side tying the refusal to the instance it was aimed at.
      this.logger.debug(
        `Rejected a Cloud SQL connection to ${instanceKey}: no database "${database}"`
      );

      return {
        allowed: false,
        rejection: {
          sqlState: SQLSTATE_INVALID_CATALOG_NAME,
          message: `database "${database}" does not exist`,
        },
      };
    }

    const record = await this.lookupUser(project, instance, user);

    if (!record) {
      this.logger.debug(`Rejected a Cloud SQL connection to ${instanceKey}: no user "${user}"`);

      return {
        allowed: false,
        rejection: {
          sqlState: SQLSTATE_INVALID_AUTHORIZATION_SPECIFICATION,
          message: `role "${user}" does not exist`,
        },
      };
    }

    return { allowed: true, connection: { queue: open.queue, password: record.password } };
  }
}

/**
 * The no-op data plane used when `CLOUDSQL_DATA_PLANE=false`, so the control
 * plane keeps working on its own and no wasm Postgres is ever built.
 */
export class DisabledDataPlane implements CloudSqlDataPlane {
  async startInstance(): Promise<number | null> {
    return null;
  }

  async stopInstance(): Promise<void> {}

  async dropInstance(): Promise<void> {}

  async restartInstance(): Promise<void> {}

  async openDatabase(): Promise<void> {}

  async dropDatabase(): Promise<void> {}

  async stopAll(): Promise<void> {}

  getPort(): number | null {
    return null;
  }
}
