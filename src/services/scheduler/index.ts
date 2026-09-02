/**
 * Cloud Scheduler Service - entry point
 *
 * Wires together all scheduler components: repository, cron engine,
 * job service, handlers, and execution engine.
 */

import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import type { StorageManager } from '@/core/storage/manager.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { CronEngine } from './cron-engine.ts';
import { ExecutionEngine } from './execution-engine.ts';
import { SchedulerHandlers } from './handlers.ts';
import { JobRepository } from './repository.ts';
import { JobService } from './service.ts';

export class SchedulerService {
  private storage: StorageManager;
  private logger: Logger;
  private kingletHttpPort: number | undefined;
  private repository: JobRepository | null = null;
  private cronEngine: CronEngine | null = null;
  private jobService: JobService | null = null;
  private handlers: SchedulerHandlers | null = null;
  private executionEngine: ExecutionEngine | null = null;

  constructor(storage: StorageManager, logger: Logger, kingletHttpPort?: number) {
    this.storage = storage;
    this.logger = logger;
    this.kingletHttpPort = kingletHttpPort;
  }

  async initialize(): Promise<void> {
    this.repository = new JobRepository(this.storage);
    await this.repository.initialize();

    this.cronEngine = new CronEngine();
    this.jobService = new JobService(this.repository, this.cronEngine);
    const executionEngine = new ExecutionEngine(this.repository, this.cronEngine, this.logger, {
      ...(this.kingletHttpPort != null ? { kingletHttpPort: this.kingletHttpPort } : {}),
    });

    this.executionEngine = executionEngine;
    this.jobService.setExecuteCallback(job => executionEngine.executeJob(job));
    this.handlers = new SchedulerHandlers(this.jobService, this.logger);

    this.logger.info('Cloud Scheduler service initialized');
  }

  getRoutes(): RouteDefinition[] {
    if (!this.handlers) {
      throw new Error('SchedulerService not initialized. Call initialize() first.');
    }

    return this.handlers.getRoutes();
  }

  start(pollIntervalMs?: number): void {
    if (!this.executionEngine) {
      throw new Error('SchedulerService not initialized. Call initialize() first.');
    }

    this.executionEngine.start(pollIntervalMs);
    this.logger.info('Cloud Scheduler execution engine started');
  }

  async stop(): Promise<void> {
    if (this.executionEngine) {
      await this.executionEngine.stop();
    }

    this.logger.info('Cloud Scheduler service stopped');
  }

  getJobService(): JobService {
    if (!this.jobService) {
      throw new Error('SchedulerService not initialized. Call initialize() first.');
    }

    return this.jobService;
  }

  getExecutionEngine(): ExecutionEngine {
    if (!this.executionEngine) {
      throw new Error('SchedulerService not initialized. Call initialize() first.');
    }

    return this.executionEngine;
  }
}
