/**
 * Cloud SQL Service - entry point
 *
 * Wires together repository, admin service, HTTP handlers, and the PGlite-backed
 * data plane that makes an emulated instance something a Postgres client can
 * actually connect to (see docs/adrs/013-cloudsql-pglite-data-plane.md).
 */

import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import type { StorageManager } from '@/core/storage/manager.ts';
import type { PostgresDataPlane } from '@/shared/postgres-data-plane/data-plane-manager.ts';
import { DisabledDataPlane } from '@/shared/postgres-data-plane/data-plane-manager.ts';
import type {
  PersistedInstance,
  ServiceDataPlaneOptions,
} from '@/shared/postgres-data-plane/host.ts';
import {
  CLOUDSQL_DATA_PLANE_PRODUCT,
  createPostgresDataPlane,
  restartPersistedInstances,
} from '@/shared/postgres-data-plane/host.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { CloudSqlHandlers } from './handlers.ts';
import { CloudSqlRepository } from './repository.ts';
import { SqlAdminService } from './service.ts';

// Mirrors the config schema's defaults (see src/config/schema.ts). Tests that
// only exercise the control plane pass `{ enabled: false }` to avoid building
// wasm Postgres instances they never connect to.
export const DEFAULT_CLOUDSQL_DATA_PLANE_OPTIONS: Required<ServiceDataPlaneOptions> = {
  enabled: true,
  portRangeStart: 5432,
  portRangeEnd: 5531,
  storageType: 'hybrid',
  sqlitePath: './data/emulator.db',
  postgis: false,
};

export class CloudSqlService {
  private storage: StorageManager;
  private logger: Logger;
  private dataPlaneOptions: Required<ServiceDataPlaneOptions>;
  private dataPlane: PostgresDataPlane = new DisabledDataPlane();
  private adminService: SqlAdminService | null = null;
  private handlers: CloudSqlHandlers | null = null;

  constructor(storage: StorageManager, logger: Logger, dataPlaneOptions?: ServiceDataPlaneOptions) {
    this.storage = storage;
    this.logger = logger;
    this.dataPlaneOptions = { ...DEFAULT_CLOUDSQL_DATA_PLANE_OPTIONS, ...dataPlaneOptions };
  }

  async initialize(): Promise<void> {
    // Idempotent: a second call would build a second data plane and orphan the
    // first's listeners and PGlites, since stop() only reaches the one held.
    if (this.adminService) return;

    const repository = new CloudSqlRepository(this.storage);

    await repository.initialize();

    this.dataPlane = createPostgresDataPlane(
      this.logger,
      CLOUDSQL_DATA_PLANE_PRODUCT,
      this.dataPlaneOptions,
      async (project, instance, user) => {
        const record = await repository.getUser(project, instance, user);

        return record ? { password: record.password } : null;
      }
    );

    this.adminService = new SqlAdminService(repository, this.dataPlane);
    this.handlers = new CloudSqlHandlers(this.adminService, this.logger);

    if (this.dataPlaneOptions.enabled) {
      await this.rehydrateDataPlane(repository);
    }

    this.logger.info('Cloud SQL service initialized');
  }

  getRoutes(): RouteDefinition[] {
    if (!this.handlers) {
      throw new Error('CloudSqlService not initialized. Call initialize() first.');
    }

    return this.handlers.getRoutes();
  }

  start(): void {
    this.logger.info('Cloud SQL service started');
  }

  /**
   * The port an instance's Postgres endpoint listens on, or null when the
   * instance is not running a data plane.
   *
   * <p>Not derivable from the admin API, which stays byte-faithful to sqladmin
   * and so has nowhere to report a kinglet-only port. Callers that hold the
   * service — the emulator process itself, and tests — can ask here instead of
   * assuming the port allocator's first choice was free.
   */
  getDataPlanePort(project: string, instance: string): number | null {
    return this.dataPlane.getPort(project, instance);
  }

  async stop(): Promise<void> {
    await this.dataPlane.stopAll();
    this.logger.info('Cloud SQL service stopped');
  }

  /**
   * Rows that outlived the last run, keyed the way the data plane knows them.
   * Rehydration itself — and why it matters — is {@link restartPersistedInstances}.
   */
  private async rehydrateDataPlane(repository: CloudSqlRepository): Promise<void> {
    const persisted: PersistedInstance[] = [];

    for (const instance of await repository.listAllInstances()) {
      const databases = await repository.listDatabases(instance.project, instance.name);

      persisted.push({
        name: `${instance.project}/${instance.name}`,
        project: instance.project,
        instance: instance.name,
        databases: databases.map(database => database.name),
      });
    }

    await restartPersistedInstances(
      this.logger,
      CLOUDSQL_DATA_PLANE_PRODUCT,
      this.dataPlane,
      persisted
    );
  }
}
