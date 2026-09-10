/**
 * A {@link PostgresDataPlane} double that records the calls made to it.
 *
 * <p>Shared by the Cloud SQL and AlloyDB service tests, which assert on the
 * control plane's side of the contract — which instances were started, dropped
 * or left alone — without booting a wasm Postgres for every case. Both products
 * drive the same interface, so three near-identical copies of this had already
 * drifted apart on `getPort` before it moved here.
 */

import type { PostgresDataPlane } from '@/shared/postgres-data-plane/data-plane-manager.ts';

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
  }

  async stopAll(): Promise<void> {
    this.calls.push('stopAll');
  }

  getPort(): number | null {
    return this.reportedPort;
  }
}
