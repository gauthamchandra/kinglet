/**
 * kinglet
 * Entry point for the application
 */

import type { Server } from 'bun';
import { getConfig } from '@/config/loader.ts';
import {
  buildComposedOperationsRoutes,
  type ComposableOperationsStore,
  isComposedOperationsPath,
} from '@/core/gateway/composable-operations.ts';
import { createLocationRoutes } from '@/core/gateway/location-routes.ts';
import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import { RequestRouter } from '@/core/gateway/request-router.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { AlloyDbService } from '@/services/alloydb/index.ts';
import { CloudSqlService } from '@/services/cloudsql/index.ts';
import { CloudKmsService } from '@/services/kms/index.ts';
import { MemorystoreService } from '@/services/memorystore/index.ts';
import { PubSubService } from '@/services/pubsub/index.ts';
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
let pubsubService: PubSubService | null = null;
let workflowsService: CloudWorkflowsService | null = null;
let memorystoreService: MemorystoreService | null = null;
let alloydbService: AlloyDbService | null = null;
let kmsService: CloudKmsService | null = null;
let cloudSqlService: CloudSqlService | null = null;

async function main(): Promise<void> {
  try {
    logger.info('Starting kinglet...');
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

    // Several GCP APIs share the v1 locations endpoint, so it is owned here rather
    // than by any one service — see src/core/gateway/location-routes.ts
    for (const route of createLocationRoutes(logger)) {
      router.addRoute(route);
    }

    if (config.services.scheduler.enabled) {
      schedulerService = new SchedulerService(
        storageManager,
        new Logger('Scheduler'),
        config.server.httpPort
      );
      await schedulerService.initialize();

      for (const route of schedulerService.getRoutes()) {
        router.addRoute(route);
      }

      schedulerService.start();
      logger.info('Cloud Scheduler service enabled and started');
    }

    if (config.services.pubsub.enabled) {
      pubsubService = new PubSubService(storageManager, new Logger('PubSub'));
      await pubsubService.initialize();

      for (const route of pubsubService.getRoutes()) {
        router.addRoute(route);
      }

      pubsubService.start();
      logger.info('Cloud Pub/Sub service enabled and started');
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

      logger.info('Cloud Workflows service enabled');
    }

    if (config.services.kms.enabled) {
      kmsService = new CloudKmsService(storageManager, new Logger('KMS'));
      await kmsService.initialize();

      for (const route of kmsService.getRoutes()) {
        router.addRoute(route);
      }

      kmsService.start();
      logger.info('Cloud KMS service enabled and started');
    }

    if (config.services.memorystore.enabled) {
      memorystoreService = new MemorystoreService(
        storageManager,
        new Logger('Memorystore'),
        config.services.memorystore.dataPlane
      );
      await memorystoreService.initialize();

      memorystoreService.start();
      logger.info('Memorystore for Valkey service enabled and started');
    }

    if (config.services.alloydb.enabled) {
      alloydbService = new AlloyDbService(storageManager, new Logger('AlloyDB'));
      await alloydbService.initialize();

      logger.info('AlloyDB service enabled');
    }

    if (config.services.cloudsql.enabled) {
      cloudSqlService = new CloudSqlService(storageManager, new Logger('CloudSQL'));
      await cloudSqlService.initialize();

      for (const route of cloudSqlService.getRoutes()) {
        router.addRoute(route);
      }

      cloudSqlService.start();
      logger.info('Cloud SQL service enabled and started');
    }

    // Workflows, Memorystore and AlloyDB all expose `/operations` routes of the same
    // shape (see docs/adrs/007-memorystore-valkey-data-plane.md). A composed route set
    // queries every store, so an LRO is retrievable regardless of which service
    // created it, and each service's own copy is then dropped below — one owner per
    // path, per docs/adrs/009-shared-route-namespace.md.
    const composableOperationsStores: ComposableOperationsStore[] = [];

    if (memorystoreService) {
      composableOperationsStores.push(memorystoreService.getComposableOperationsStore());
    }

    if (workflowsService) {
      composableOperationsStores.push(workflowsService.getComposableOperationsStore());
    }

    if (alloydbService) {
      composableOperationsStores.push(alloydbService.getComposableOperationsStore());
    }

    const composedOperationsRegistered = composableOperationsStores.length > 1;

    if (composedOperationsRegistered) {
      for (const route of buildComposedOperationsRoutes(
        composableOperationsStores,
        new Logger('Operations')
      )) {
        router.addRoute(route);
      }
    }

    // addRoute rejects a duplicate method+path outright, so a service's own
    // operations routes have to be dropped once the composed set owns them.
    const registerServiceRoutes = (routes: RouteDefinition[]): void => {
      for (const route of routes) {
        if (composedOperationsRegistered && isComposedOperationsPath(route.path)) {
          continue;
        }

        router.addRoute(route);
      }
    };

    if (workflowsService) {
      registerServiceRoutes(workflowsService.getRoutes());
    }

    if (memorystoreService) {
      registerServiceRoutes(memorystoreService.getRoutes());
    }

    if (alloydbService) {
      registerServiceRoutes(alloydbService.getRoutes());
    }

    server = Bun.serve({
      port: config.server.httpPort,
      fetch: request => router.route(request),
      error: error => {
        logger.error('HTTP server error:', error);

        return new Response('Internal Server Error', { status: 500 });
      },
    });

    logger.info(`kinglet started on port ${server.port}`);
  } catch (error) {
    logger.error('Failed to start kinglet:', error);

    // Bun does not kill Bun.spawn children (e.g. Memorystore's valkey-server
    // processes) when the parent exits, so a startup failure after those
    // processes were spawned would otherwise leak them.
    await memorystoreService?.stop();
    process.exit(1);
  }
}

let isShuttingDown = false;

/**
 * Tear down every running service and exit.
 *
 * <p>`exitCode` distinguishes a clean stop (SIGINT/SIGTERM, code 0) from a
 * crash (an uncaught exception or unhandled rejection, code 1) — a crash
 * that exits 0 is indistinguishable from a clean stop to `restart:
 * on-failure` supervisors (Docker, Kubernetes, systemd), which then never
 * restart the emulator. The teardown steps run inside `try`/`finally` so
 * `process.exit` still runs even if a service's `stop()` rejects, and
 * `isShuttingDown` guards against a second crash arriving mid-shutdown
 * (e.g. an unhandled rejection surfacing while an uncaughtException is
 * already tearing things down) re-running the whole teardown.
 */
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}, shutting down gracefully...`);

  try {
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

    if (pubsubService) {
      await pubsubService.stop();
      logger.info('Pub/Sub service stopped');
    }

    if (cloudStorageService) {
      await cloudStorageService.stop();
      logger.info('Cloud Storage service stopped');
    }

    if (workflowsService) {
      await workflowsService.stop();
      logger.info('Workflows service stopped');
    }

    if (memorystoreService) {
      await memorystoreService.stop();
      logger.info('Memorystore service stopped');
    }

    if (kmsService) {
      await kmsService.stop();
      logger.info('KMS service stopped');
    }

    if (cloudSqlService) {
      await cloudSqlService.stop();
      logger.info('Cloud SQL service stopped');
    }

    if (storageManager) {
      await storageManager.close();
      logger.info('Storage manager closed');
    }

    logger.info('Shutdown complete');
  } finally {
    process.exit(exitCode);
  }
}

process.on('SIGINT', () => {
  shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

// An uncaught exception has corrupted or abandoned some in-flight state, so
// the process is treated as unrecoverable: shut down (code 1) so a supervisor
// restarts it, and so Memorystore's spawned valkey-server children are killed
// on the way out — Bun does not kill Bun.spawn children when the parent exits.
process.on('uncaughtException', error => {
  logger.error('Uncaught exception, shutting down gracefully...', error);
  shutdown('uncaughtException', 1);
});

// An unhandled rejection is far more often a stray background promise (a timer,
// a fire-and-forget call) than a corrupted process, so it is logged and the
// emulator keeps running rather than tearing down a working dev server. Genuine
// unrecoverable failures still surface via uncaughtException above.
process.on('unhandledRejection', reason => {
  logger.error('Unhandled promise rejection (continuing)', reason);
});

if (import.meta.main) {
  await main();
}
