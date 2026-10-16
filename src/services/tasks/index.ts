/**
 * Cloud Tasks Service - entry point
 *
 * Wires together all Cloud Tasks components: repositories, services,
 * handlers, and dispatch engine.
 */

import path from 'node:path';
import { getProtoPath } from 'google-proto-files';
import type { GrpcServiceDefinition } from '@/core/gateway/grpc-server.ts';
import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import type { StorageManager } from '@/core/storage/manager.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { DispatchEngine } from './dispatch-engine.ts';
import { LocationHandlers } from './location-handlers.ts';
import { QueueHandlers } from './queue-handlers.ts';
import { QueueRepository } from './queue-repository.ts';
import { QueueService } from './queue-service.ts';
import { CloudTasksGrpcHandlers } from './task-grpc-handlers.ts';
import { TaskHandlers } from './task-handlers.ts';
import { TaskRepository } from './task-repository.ts';
import { TaskService } from './task-service.ts';

export class CloudTasksService {
  private storage: StorageManager;
  private logger: Logger;
  private queueRepository: QueueRepository | null = null;
  private taskRepository: TaskRepository | null = null;
  private queueService: QueueService | null = null;
  private taskService: TaskService | null = null;
  private queueHandlers: QueueHandlers | null = null;
  private taskHandlers: TaskHandlers | null = null;
  private locationHandlers: LocationHandlers | null = null;
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
      dispatchEngineRef.cleanupBucket(queueName);
    });

    this.taskService.setDispatchCallback(async task => {
      const queue = await queueRepoRef.getQueueByName(task.queueName);

      if (queue) {
        await dispatchEngineRef.dispatchTask(task, queue);
      }
    });

    this.queueHandlers = new QueueHandlers(this.queueService, this.logger);
    this.taskHandlers = new TaskHandlers(this.taskService, this.logger);
    this.locationHandlers = new LocationHandlers(this.logger);

    this.logger.info('Cloud Tasks service initialized');
  }

  getGrpcServices(): GrpcServiceDefinition[] {
    if (!this.queueService || !this.taskService) {
      throw new Error('CloudTasksService not initialized. Call initialize() first.');
    }

    const handlers = new CloudTasksGrpcHandlers(this.queueService, this.taskService);

    const protoPath = getProtoPath('cloud/tasks/v2/cloudtasks.proto');

    // google-proto-files stores all Google API protos under its package root.
    // proto-loader needs that root on the include path so that relative imports
    // inside cloudtasks.proto (e.g. "google/api/annotations.proto") resolve.
    // protoPath is under .../google-proto-files/google/cloud/tasks/v2/
    // so we go up 4 levels to reach the package root.
    const protoRoot = path.resolve(path.dirname(protoPath), '../../../..');

    return [
      {
        name: 'CloudTasks',
        protoPath,
        packageName: 'google.cloud.tasks.v2',
        serviceName: 'CloudTasks',
        implementation: handlers.toServiceImplementation(),
        includeDirs: [protoRoot],
      },
    ];
  }

  getRoutes(): RouteDefinition[] {
    if (!this.queueHandlers || !this.taskHandlers || !this.locationHandlers) {
      throw new Error('CloudTasksService not initialized. Call initialize() first.');
    }

    return [
      ...this.locationHandlers.getRoutes(),
      ...this.queueHandlers.getRoutes(),
      ...this.taskHandlers.getRoutes(),
    ];
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
