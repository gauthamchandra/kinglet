/**
 * Cloud SQL Service - entry point
 *
 * Wires together repository, admin service, and HTTP handlers. Control-plane
 * emulation only: instances/databases/users/operations are records in
 * kinglet's storage; there is no connectable database in this iteration.
 */

import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import type { StorageManager } from '@/core/storage/manager.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { CloudSqlHandlers } from './handlers.ts';
import { CloudSqlRepository } from './repository.ts';
import { SqlAdminService } from './service.ts';

export class CloudSqlService {
  private storage: StorageManager;
  private logger: Logger;
  private repository: CloudSqlRepository | null = null;
  private adminService: SqlAdminService | null = null;
  private handlers: CloudSqlHandlers | null = null;

  constructor(storage: StorageManager, logger: Logger) {
    this.storage = storage;
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    this.repository = new CloudSqlRepository(this.storage);
    await this.repository.initialize();

    this.adminService = new SqlAdminService(this.repository);
    this.handlers = new CloudSqlHandlers(this.adminService, this.logger);

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

  async stop(): Promise<void> {
    this.logger.info('Cloud SQL service stopped');
  }
}
