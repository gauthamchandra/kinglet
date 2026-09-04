/**
 * Extract kinglet route tables per emulated GCP service at runtime.
 */

import { createLocationRoutes } from '@/core/gateway/location-routes.ts';
import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { AlloyDbService } from '@/services/alloydb/index.ts';
import { ComputeService } from '@/services/compute/index.ts';
import { CloudSqlService } from '@/services/cloudsql/index.ts';
import { CloudKmsService } from '@/services/kms/index.ts';
import { MemorystoreService } from '@/services/memorystore/index.ts';
import { PubSubService } from '@/services/pubsub/index.ts';
import { SchedulerService } from '@/services/scheduler/index.ts';
import { CloudStorageService } from '@/services/storage/index.ts';
import { CloudTasksService } from '@/services/tasks/index.ts';
import { CloudWorkflowsService } from '@/services/workflows/index.ts';
import { Logger } from '@/shared/utils/logger.ts';

export interface ExtractedRoute {
  readonly id: string;
  readonly method: string;
  readonly path: string;
}

interface EmulatedService {
  initialize(): Promise<void>;
  getRoutes(): RouteDefinition[];
}

type ServiceFactory = (storage: StorageManager, logger: Logger) => EmulatedService;

const SERVICE_FACTORIES: Record<string, ServiceFactory> = {
  alloydb: (storage, logger) => new AlloyDbService(storage, logger),
  compute: (storage, logger) => new ComputeService(storage, logger),
  'cloud-kms': (storage, logger) => new CloudKmsService(storage, logger),
  'cloud-scheduler': (storage, logger) => new SchedulerService(storage, logger),
  'cloud-sql': (storage, logger) => new CloudSqlService(storage, logger),
  'cloud-storage': (storage, logger) => new CloudStorageService(storage, logger),
  'cloud-tasks': (storage, logger) => new CloudTasksService(storage, logger),
  memorystore: (storage, logger) => new MemorystoreService(storage, logger, { enabled: false }),
  pubsub: (storage, logger) => new PubSubService(storage, logger),
  workflows: (storage, logger) => new CloudWorkflowsService(storage, logger),
};

/** Registry services with no routes yet — empty output is expected. */
const PLANNED_WITHOUT_ROUTES = new Set(['secret-manager']);

/** v1 services that rely on the shared gateway locations routes. */
const USES_SHARED_V1_LOCATIONS = new Set([
  'alloydb',
  'cloud-kms',
  'cloud-scheduler',
  'cloud-sql',
  'memorystore',
  'pubsub',
  'workflows',
]);

let sharedV1LocationRoutes: ExtractedRoute[] | undefined;

function getSharedV1LocationRoutes(logger: Logger): ExtractedRoute[] {
  if (!sharedV1LocationRoutes) {
    sharedV1LocationRoutes = createLocationRoutes(logger).map(toExtractedRoute);
  }

  return sharedV1LocationRoutes;
}

export async function extractRoutesForService(serviceName: string): Promise<ExtractedRoute[]> {
  if (PLANNED_WITHOUT_ROUTES.has(serviceName)) {
    return [];
  }

  const factory = SERVICE_FACTORIES[serviceName];

  if (!factory) {
    throw new Error(
      `No route extractor registered for service "${serviceName}". Add it to SERVICE_FACTORIES in scripts/lib/extract-service-routes.ts.`
    );
  }

  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const logger = new Logger('docs', 'error');
  const service = factory(storage, logger);

  await service.initialize();

  const routes = service.getRoutes().map(toExtractedRoute);

  if (USES_SHARED_V1_LOCATIONS.has(serviceName)) {
    return dedupeRoutes([...routes, ...getSharedV1LocationRoutes(logger)]);
  }

  return dedupeRoutes(routes);
}

export async function extractRoutesForAllServices(
  serviceNames: readonly string[]
): Promise<Map<string, ExtractedRoute[]>> {
  const routesByService = new Map<string, ExtractedRoute[]>();

  for (const serviceName of serviceNames) {
    routesByService.set(serviceName, await extractRoutesForService(serviceName));
  }

  return routesByService;
}

function toExtractedRoute(route: RouteDefinition): ExtractedRoute {
  return {
    id: route.id,
    method: route.method,
    path: route.path,
  };
}

function dedupeRoutes(routes: readonly ExtractedRoute[]): ExtractedRoute[] {
  const seen = new Set<string>();
  const unique: ExtractedRoute[] = [];

  for (const route of routes) {
    const key = `${route.method} ${route.path}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(route);
  }

  return unique.sort((a, b) => {
    const pathCompare = a.path.localeCompare(b.path);

    if (pathCompare !== 0) {
      return pathCompare;
    }

    return a.method.localeCompare(b.method);
  });
}
