/**
 * Cloud Tasks Service - entry point
 *
 * Wires together all Cloud Tasks components: repositories, services,
 * handlers, and dispatch engine.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import { QueueRepository } from './queue-repository.ts';
import { TaskRepository } from './task-repository.ts';
import { QueueService } from './queue-service.ts';
import { TaskService } from './task-service.ts';
import { QueueHandlers } from './queue-handlers.ts';
import { TaskHandlers } from './task-handlers.ts';
import { DispatchEngine } from './dispatch-engine.ts';

export class CloudTasksService {
  private storage: StorageManager;
  private logger: Logger;
  private queueRepository: QueueRepository | null = null;
  private taskRepository: TaskRepository | null = null;
  private queueService: QueueService | null = null;
  private taskService: TaskService | null = null;
  private queueHandlers: QueueHandlers | null = null;
  private taskHandlers: TaskHandlers | null = null;
  private dispatchEngine: DispatchEngine | null = null;

  constructor(storage: StorageManager, logger: Logger) {
    this.storage = storage;
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    this.queueRepository = new QueueRepository(this.storage);
    await this.queueRepository.initialize();

    this.taskRepository = new TaskRepository(this.storage);
    await this.taskRepository.initialize();

    this.queueService = new QueueService(this.queueRepository);
    this.taskService = new TaskService(this.taskRepository, this.queueRepository);

    this.dispatchEngine = new DispatchEngine(
      this.queueRepository,
      this.taskRepository,
      this.logger
    );

    const taskRepoRef = this.taskRepository;
    const queueRepoRef = this.queueRepository;
    const dispatchEngineRef = this.dispatchEngine;

    this.queueService.setPurgeCallback(async queueName => {
      await taskRepoRef.deleteTasksByQueue(queueName);
    });

    this.queueService.setDeleteCallback(async queueName => {
      await taskRepoRef.deleteTasksByQueue(queueName);
    });

    this.taskService.setDispatchCallback(async task => {
      const queue = await queueRepoRef.getQueueByName(task.queueName);

      if (queue) {
        await dispatchEngineRef.dispatchTask(task, queue);
      }
    });

    this.queueHandlers = new QueueHandlers(this.queueService, this.logger);
    this.taskHandlers = new TaskHandlers(this.taskService, this.logger);

    this.logger.info('Cloud Tasks service initialized');
  }

  getRoutes(): RouteDefinition[] {
    if (!this.queueHandlers || !this.taskHandlers) {
      throw new Error('CloudTasksService not initialized. Call initialize() first.');
    }

    return [...this.queueHandlers.getRoutes(), ...this.taskHandlers.getRoutes()];
  }

  start(pollIntervalMs?: number): void {
    if (!this.dispatchEngine) {
      throw new Error('CloudTasksService not initialized. Call initialize() first.');
    }

    this.dispatchEngine.start(pollIntervalMs);
    this.logger.info('Cloud Tasks dispatch engine started');
  }

  async stop(): Promise<void> {
    if (this.dispatchEngine) {
      await this.dispatchEngine.stop();
    }

    this.logger.info('Cloud Tasks service stopped');
  }
}
