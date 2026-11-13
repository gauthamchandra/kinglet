/**
 * The shared interface and no-op implementation for the Postgres data plane.
 *
 * <p>Both Cloud SQL and AlloyDB implement {@link PostgresDataPlane} with
 * {@link PostgresServerDataPlane} (real Postgres, ADR-019). The admin
 * service talks only to this interface, so the control plane can run without
 * a data plane at all ({@link DisabledDataPlane}) and so tests can substitute
 * a double instead of spawning a Postgres process.
 */

export const ADVERTISED_HOST = '127.0.0.1';

/** A create found a role that SQL already owned. It was left unchanged. */
export class RoleAlreadyExistsError extends Error {
  constructor(readonly roleName: string) {
    super(`Role ${roleName} already exists`);
    this.name = 'RoleAlreadyExistsError';
  }
}

/** A single `{ name, value }` entry from `settings.databaseFlags`. */
export interface DatabaseFlag {
  name: string;
  value: string;
}

/**
 * Thrown by the data plane when Postgres rejects a flag name or value.
 * Maps to INVALID_ARGUMENT at the service layer; all other data-plane errors
 * stay INTERNAL.
 */
export class DatabaseFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseFlagError';
  }
}

export interface PostgresDataPlane {
  /**
   * Bring up an instance's endpoint with the given databases open, returning
   * the port it listens on, or null when no data plane is running.
   */
  startInstance(project: string, instance: string, databases: string[]): Promise<number | null>;
  /**
   * Bring up a streaming standby of the server running at `primaryPort`.
   *
   * <p>On first call the standby data directory is created via
   * {@code pg_basebackup}. On a subsequent call (rehydration after restart)
   * the existing standby directory is started as-is; Postgres reconnects to
   * the primary using the {@code primary_conninfo} already written to
   * {@code postgresql.auto.conf}, updated to the new primary port.
   *
   * <p>Returns the port the standby listens on, or null when no data plane is
   * running (binaries absent or data plane disabled).
   */
  startReplicaInstance(
    project: string,
    instance: string,
    primaryPort: number | null
  ): Promise<number | null>;
  /** Tear down the endpoint but leave any persisted data alone. */
  stopInstance(project: string, instance: string): Promise<void>;
  /** Tear down the endpoint and delete the instance's data. */
  dropInstance(project: string, instance: string): Promise<void>;
  restartInstance(project: string, instance: string, databases: string[]): Promise<void>;
  openDatabase(project: string, instance: string, database: string): Promise<void>;
  dropDatabase(project: string, instance: string, database: string): Promise<void>;
  stopAll(): Promise<void>;
  getPort(project: string, instance: string): number | null;
  /**
   * Create or alter the role a control-plane user logs in as.
   * A null or empty password is NOLOGIN. No-op when the instance has no server.
   * `createOnly` refuses to change a role that already exists.
   */
  upsertUser(
    project: string,
    instance: string,
    user: DataPlaneLogin,
    options?: { createOnly?: boolean }
  ): Promise<void>;
  /** Remove a role from every database in the instance. No-op when nothing is running. */
  dropUser(project: string, instance: string, userName: string): Promise<void>;
  /**
   * Apply `settings.databaseFlags` to the running Postgres server.
   *
   * The `flags` array is the full replacement list. Flags omitted from a prior
   * call are reset with `ALTER SYSTEM RESET`. An empty list clears flags that
   * were applied earlier, and does nothing when none were. A flag Postgres
   * reports as `pending_restart` restarts the postmaster. No-op when no server
   * is running for this instance.
   *
   * Throws {@link DatabaseFlagError} (→ INVALID_ARGUMENT) when Postgres rejects
   * the flag name or value; all other errors surface as INTERNAL.
   */
  applyDatabaseFlags(
    project: string,
    instance: string,
    flags: DatabaseFlag[],
    databases: string[]
  ): Promise<void>;
}

/**
 * A control-plane user projected onto a Postgres role.
 */
export interface DataPlaneLogin {
  name: string;
  /** null or '' is NOLOGIN. Anything else is LOGIN with that password. */
  password: string | null;
  /** Granted to the role. Cloud SQL passes `cloudsqlsuperuser`. */
  memberOf: string[];
  /**
   * The seeded `postgres` user is a superuser so it can `CREATE EXTENSION`
   * for vector, PostGIS, and pg_stat_statements. Those control files are not
   * `trusted`, and membership in `cloudsqlsuperuser` does not confer it.
   */
  superuser?: boolean;
}

/**
 * The no-op data plane used when a service's `*_DATA_PLANE=false`, so the
 * control plane keeps working on its own and no Postgres process is ever
 * spawned.
 */
export class DisabledDataPlane implements PostgresDataPlane {
  async startInstance(): Promise<number | null> {
    return null;
  }

  async startReplicaInstance(): Promise<number | null> {
    return null;
  }

  async stopInstance(): Promise<void> {}

  async dropInstance(): Promise<void> {}

  async restartInstance(): Promise<void> {}

  async openDatabase(): Promise<void> {}

  async dropDatabase(): Promise<void> {}

  async stopAll(): Promise<void> {}

  async upsertUser(): Promise<void> {}

  async dropUser(): Promise<void> {}

  async applyDatabaseFlags(): Promise<void> {}

  getPort(): number | null {
    return null;
  }
}
