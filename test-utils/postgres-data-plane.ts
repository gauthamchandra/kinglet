/**
 * A {@link PostgresDataPlane} double that records the calls made to it.
 *
 * <p>Shared by the Cloud SQL and AlloyDB service tests, which assert on the
 * control plane's side of the contract — which instances were started, dropped
 * or left alone — without booting a wasm Postgres for every case. Both products
 * drive the same interface, so three near-identical copies of this had already
 * drifted apart on `getPort` before it moved here.
 */

import type {
  DataPlaneLogin,
  PostgresDataPlane,
} from '@/shared/postgres-data-plane/data-plane-manager.ts';

export interface RecordingDataPlaneOptions {
  /** Port reported by {@link RecordingDataPlane.startInstance}. */
  port?: number;
  /** When set, {@link RecordingDataPlane.getPort} returns this instead of `port`. */
  reportedPort?: number | null;
}

export class RecordingDataPlane implements PostgresDataPlane {
  readonly calls: string[] = [];

  /** When set, `startInstance` records the call and then throws this. */
  startFailure: Error | null = null;

  /** When set, `dropInstance` records the call and then throws this. */
  dropFailure: Error | null = null;

  /** When set, `upsertUser` records the call and then throws this. */
  upsertFailure: Error | null = null;

  /** When set, `dropUser` records the call and then throws this. */
  dropUserFailure: Error | null = null;

  /** When set, `dropDatabase` records the call and then throws this. */
  dropDatabaseFailure: Error | null = null;

  private readonly port: number;
  private readonly reportedPort: number | null;

  constructor(options: RecordingDataPlaneOptions = {}) {
    this.port = options.port ?? 5432;
    this.reportedPort = options.reportedPort === undefined ? this.port : options.reportedPort;
  }

  async startInstance(project: string, instance: string, databases: string[]): Promise<number> {
    this.calls.push(`start:${project}/${instance}:${databases.join(',')}`);

    if (this.startFailure) throw this.startFailure;

    return this.port;
  }

  async startReplicaInstance(
    project: string,
    instance: string,
    primaryPort: number | null
  ): Promise<number> {
    if (primaryPort == null) {
      throw new Error('Primary instance is not running; cannot create a read pool');
    }

    this.calls.push(`startReplica:${project}/${instance}:${primaryPort}`);

    if (this.startFailure) throw this.startFailure;

    return this.port;
  }

  async stopInstance(project: string, instance: string): Promise<void> {
    this.calls.push(`stop:${project}/${instance}`);
  }

  async dropInstance(project: string, instance: string): Promise<void> {
    this.calls.push(`drop:${project}/${instance}`);

    if (this.dropFailure) throw this.dropFailure;
  }

  async restartInstance(project: string, instance: string, databases: string[]): Promise<void> {
    this.calls.push(`restart:${project}/${instance}:${databases.join(',')}`);
  }

  async openDatabase(project: string, instance: string, database: string): Promise<void> {
    this.calls.push(`openDatabase:${project}/${instance}/${database}`);
  }

  async dropDatabase(project: string, instance: string, database: string): Promise<void> {
    this.calls.push(`dropDatabase:${project}/${instance}/${database}`);

    if (this.dropDatabaseFailure) throw this.dropDatabaseFailure;
  }

  async stopAll(): Promise<void> {
    this.calls.push('stopAll');
  }

  async upsertUser(project: string, instance: string, user: DataPlaneLogin): Promise<void> {
    this.calls.push(`upsertUser:${project}/${instance}:${user.name}`);

    if (this.upsertFailure) throw this.upsertFailure;
  }

  async dropUser(project: string, instance: string, userName: string): Promise<void> {
    this.calls.push(`dropUser:${project}/${instance}:${userName}`);

    if (this.dropUserFailure) throw this.dropUserFailure;
  }

  getPort(): number | null {
    return this.reportedPort;
  }
}
