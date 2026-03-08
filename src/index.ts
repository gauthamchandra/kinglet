/**
 * LocalStack GCP Emulator
 * Entry point for the application
 */

import type { Server } from 'bun';
import { getConfig } from '@/config/loader.ts';
import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import { RequestRouter } from '@/core/gateway/request-router.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { SchedulerService } from '@/services/scheduler/index.ts';
import { CloudStorageService } from '@/services/storage/index.ts';
import { CloudTasksService } from '@/services/tasks/index.ts';
import { CloudWorkflowsService } from '@/services/workflows/index.ts';
import { Logger } from '@/shared/utils/logger.ts';

const logger = new Logger('Main');

let server: Server | null = null;
let storageManager: StorageManager | null = null;
let schedulerService: SchedulerService | null = null;
let tasksService: CloudTasksService | null = null;
let cloudStorageService: CloudStorageService | null = null;
let workflowsService: CloudWorkflowsService | null = null;

async function main(): Promise<void> {
  try {
    logger.info('Starting LocalStack GCP Emulator...');
    logger.info('Bun version:', Bun.version);

    const config = await getConfig();

    logger.info('Configuration loaded', {
      httpPort: config.server.httpPort,
      storageType: config.storage.type,
    });

    storageManager = new StorageManager();

    await storageManager.initialize(config.storage);

    logger.info('Storage initialized');

    const router = new RequestRouter(new Logger('Router'));

    const healthRoute: RouteDefinition = {
      id: 'health',
      method: 'GET',
      path: '/health',
      handler: () => ({
        status: 200,
        body: { status: 'ok' },
      }),
    };

    router.addRoute(healthRoute);

    if (config.services.scheduler.enabled) {
      schedulerService = new SchedulerService(storageManager, new Logger('Scheduler'));
      await schedulerService.initialize();

      for (const route of schedulerService.getRoutes()) {
        router.addRoute(route);
      }

      schedulerService.start();
      logger.info('Cloud Scheduler service enabled and started');
    }

    if (config.services.pubsub.enabled) {
      logger.info('Pub/Sub service enabled (stub - not yet implemented)');
    }

    if (config.services.tasks.enabled) {
      tasksService = new CloudTasksService(storageManager, new Logger('Tasks'));
      await tasksService.initialize();

      for (const route of tasksService.getRoutes()) {
        router.addRoute(route);
      }

      tasksService.start();
      logger.info('Cloud Tasks service enabled and started');
    }

    if (config.services.secrets.enabled) {
      logger.info('Secret Manager service enabled (stub - not yet implemented)');
    }

    if (config.services.storage.enabled) {
      cloudStorageService = new CloudStorageService(storageManager, new Logger('Storage'));
      await cloudStorageService.initialize();

      for (const route of cloudStorageService.getRoutes()) {
        router.addRoute(route);
      }

      cloudStorageService.start();
      logger.info('Cloud Storage service enabled and started');
    }

    if (config.services.workflows.enabled) {
      workflowsService = new CloudWorkflowsService(storageManager, new Logger('Workflows'));
      await workflowsService.initialize();

      for (const route of workflowsService.getRoutes()) {
        router.addRoute(route);
      }

      logger.info('Cloud Workflows service enabled');
    }

    server = Bun.serve({
      port: config.server.httpPort,
      fetch: request => router.route(request),
      error: error => {
        logger.error('HTTP server error:', error);

        return new Response('Internal Server Error', { status: 500 });
      },
    });

    logger.info(`LocalStack GCP Emulator started on port ${server.port}`);
  } catch (error) {
    logger.error('Failed to start LocalStack GCP Emulator:', error);
    process.exit(1);
  }
}

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  if (server) {
    server.stop();
    server = null;
    logger.info('HTTP server stopped');
  }

  if (schedulerService) {
    await schedulerService.stop();
    logger.info('Scheduler service stopped');
  }

  if (tasksService) {
    await tasksService.stop();
    logger.info('Tasks service stopped');
  }

  if (cloudStorageService) {
    await cloudStorageService.stop();
    logger.info('Cloud Storage service stopped');
  }

  if (workflowsService) {
    await workflowsService.stop();
    logger.info('Workflows service stopped');
  }

  if (storageManager) {
    await storageManager.close();
    logger.info('Storage manager closed');
  }

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => {
  shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

if (import.meta.main) {
  await main();
}
