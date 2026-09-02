/**
 * Cloud SQL Service - entry point
 *
 * Wires together repository, admin service, HTTP handlers, and the PGlite-backed
 * data plane that makes an emulated instance something a Postgres client can
 * actually connect to (see docs/adrs/010-cloudsql-pglite-data-plane.md).
 */

import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import type { StorageManager } from '@/core/storage/manager.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import type {
  CloudSqlDataPlane,
  DataPlaneManagerOptions,
} from './data-plane/data-plane-manager.ts';
import { DataPlaneManager, DisabledDataPlane } from './data-plane/data-plane-manager.ts';
import { CloudSqlHandlers } from './handlers.ts';
import { CloudSqlRepository } from './repository.ts';
import { SqlAdminService } from './service.ts';

export interface CloudSqlDataPlaneOptions extends Partial<DataPlaneManagerOptions> {
  enabled?: boolean;
}

// Mirrors the config schema's defaults (see src/config/schema.ts). Tests that
// only exercise the control plane pass `{ enabled: false }` to avoid building
// wasm Postgres instances they never connect to.
const DEFAULT_DATA_PLANE_OPTIONS: Required<CloudSqlDataPlaneOptions> = {
  enabled: true,
  portRangeStart: 5432,
  portRangeEnd: 5531,
  storageType: 'hybrid',
  sqlitePath: './data/emulator.db',
};

export class CloudSqlService {
  private storage: StorageManager;
  private logger: Logger;
  private dataPlaneOptions: Required<CloudSqlDataPlaneOptions>;
  private dataPlane: CloudSqlDataPlane = new DisabledDataPlane();
  private adminService: SqlAdminService | null = null;
  private handlers: CloudSqlHandlers | null = null;

  constructor(
    storage: StorageManager,
    logger: Logger,
    dataPlaneOptions?: CloudSqlDataPlaneOptions
  ) {
    this.storage = storage;
    this.logger = logger;
    this.dataPlaneOptions = { ...DEFAULT_DATA_PLANE_OPTIONS, ...dataPlaneOptions };
  }

  async initialize(): Promise<void> {
    const repository = new CloudSqlRepository(this.storage);

    await repository.initialize();

    this.dataPlane = this.dataPlaneOptions.enabled
      ? new DataPlaneManager(
          this.logger,
          {
            portRangeStart: this.dataPlaneOptions.portRangeStart,
            portRangeEnd: this.dataPlaneOptions.portRangeEnd,
            storageType: this.dataPlaneOptions.storageType,
            sqlitePath: this.dataPlaneOptions.sqlitePath,
          },
          async (project, instance, user) => {
            const record = await repository.getUser(project, instance, user);

            return record ? { password: record.password } : null;
          }
        )
      : new DisabledDataPlane();

    this.adminService = new SqlAdminService(repository, this.dataPlane);
    this.handlers = new CloudSqlHandlers(this.adminService, this.logger);

    if (this.dataPlaneOptions.enabled) {
      await this.restartPersistedInstances(repository);
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
   * Bring the data plane back up for instances that outlived the last run.
   *
   * <p>With durable storage the control-plane rows survive a restart, so
   * without this an instance would keep being listed and described while
   * nothing listened on its endpoint — and no admin call short of a restart
   * would ever bring it back.
   */
  private async restartPersistedInstances(repository: CloudSqlRepository): Promise<void> {
    const instances = await repository.listAllInstances();

    for (const instance of instances) {
      try {
        const databases = await repository.listDatabases(instance.project, instance.name);

        await this.dataPlane.startInstance(
          instance.project,
          instance.name,
          databases.map(database => database.name)
        );
      } catch (error) {
        // One instance that cannot get a port back must degrade only itself,
        // not abort startup for every other persisted instance.
        this.logger.warn(
          `Failed to restart the data plane for Cloud SQL instance ${instance.project}/${instance.name}, leaving it degraded`,
          error
        );
      }
    }
  }
}
