/**
 * Cloud Workflows Service - entry point
 *
 * Wires together all workflows components: repository, operations store,
 * workflow service, and handlers.
 */

import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import type { StorageManager } from '@/core/storage/manager.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { ExecutionHandlers } from './execution/handlers.ts';
import { ExecutionRepository } from './execution/repository.ts';
import { ExecutionService } from './execution/service.ts';
import { WorkflowHandlers } from './handlers.ts';
import { OperationsStore } from './operations.ts';
import { WorkflowRepository } from './repository.ts';
import { WorkflowService } from './service.ts';

export class CloudWorkflowsService {
  private storage: StorageManager;
  private logger: Logger;
  private repository: WorkflowRepository | null = null;
  private operationsStore: OperationsStore | null = null;
  private workflowService: WorkflowService | null = null;
  private handlers: WorkflowHandlers | null = null;
  private executionHandlers: ExecutionHandlers | null = null;

  constructor(storage: StorageManager, logger: Logger) {
    this.storage = storage;
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    this.repository = new WorkflowRepository(this.storage);
    await this.repository.initialize();

    this.operationsStore = new OperationsStore(this.storage);
    await this.operationsStore.initialize();

    this.workflowService = new WorkflowService(this.repository, this.operationsStore);
    this.handlers = new WorkflowHandlers(this.workflowService, this.operationsStore, this.logger);

    const executionRepo = new ExecutionRepository(this.storage);
    await executionRepo.initialize();

    const executionService = new ExecutionService(executionRepo);
    this.executionHandlers = new ExecutionHandlers(executionService, this.repository, this.logger);

    this.logger.info('Cloud Workflows service initialized');
  }

  getRoutes(): RouteDefinition[] {
    if (!this.handlers || !this.executionHandlers) {
      throw new Error('CloudWorkflowsService not initialized. Call initialize() first.');
    }

    return [...this.handlers.getRoutes(), ...this.executionHandlers.getRoutes()];
  }

  async stop(): Promise<void> {
    this.logger.info('Cloud Workflows service stopped');
  }

  getWorkflowService(): WorkflowService {
    if (!this.workflowService) {
      throw new Error('CloudWorkflowsService not initialized. Call initialize() first.');
    }

    return this.workflowService;
  }
}
