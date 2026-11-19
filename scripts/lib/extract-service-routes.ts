/**
 * Extract kinglet route tables per emulated GCP service at runtime.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocationRoutes } from '@/core/gateway/location-routes.ts';
import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { AlloyDbService } from '@/services/alloydb/index.ts';
import { CloudSqlService } from '@/services/cloudsql/index.ts';
import { ComputeService } from '@/services/compute/index.ts';
import { CloudKmsService } from '@/services/kms/index.ts';
import { MemorystoreService } from '@/services/memorystore/index.ts';
import { NetworkSecurityService } from '@/services/networksecurity/index.ts';
import { PubSubService } from '@/services/pubsub/index.ts';
import { SchedulerService } from '@/services/scheduler/index.ts';
import { SecretsService } from '@/services/secrets/index.ts';
import { CloudStorageService } from '@/services/storage/index.ts';
import { CloudTasksService } from '@/services/tasks/index.ts';
import { CloudWorkflowsService } from '@/services/workflows/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { type RegisteredGrpcMethod, registeredGrpcMethods } from './grpc-methods.ts';

export interface ExtractedRoute {
  readonly id: string;
  readonly method: string;
  readonly path: string;
}

export interface ServiceSurface {
  readonly routes: ExtractedRoute[];
  readonly grpc: RegisteredGrpcMethod[];
}

interface EmulatedService {
  initialize(): Promise<void>;
  getRoutes(): RouteDefinition[];
}

type ServiceFactory = (storage: StorageManager, logger: Logger) => EmulatedService;

// `{ enabled: false }` goes to every service that owns a process-level data
// plane — Memorystore spawns valkey-server, Cloud SQL and AlloyDB boot a wasm
// Postgres — so that enumerating routes never starts one. The other services
// boot nothing on construction and take no such option.
const SERVICE_FACTORIES: Record<string, ServiceFactory> = {
  alloydb: (storage, logger) => new AlloyDbService(storage, logger, { enabled: false }),
  compute: (storage, logger) => new ComputeService(storage, logger),
  'cloud-kms': (storage, logger) => new CloudKmsService(storage, logger),
  'cloud-scheduler': (storage, logger) => new SchedulerService(storage, logger),
  'cloud-sql': (storage, logger) => new CloudSqlService(storage, logger, { enabled: false }),
  'cloud-tasks': (storage, logger) => new CloudTasksService(storage, logger),
  memorystore: (storage, logger) => new MemorystoreService(storage, logger, { enabled: false }),
  networksecurity: (storage, logger) => new NetworkSecurityService(storage, logger),
  pubsub: (storage, logger) => new PubSubService(storage, logger),
  'secret-manager': (storage, logger) => new SecretsService(storage, logger),
  workflows: (storage, logger) => new CloudWorkflowsService(storage, logger),
};

/** Registry services with no routes yet — empty output is expected. */
const PLANNED_WITHOUT_ROUTES = new Set<string>();

/** v1 services that rely on the shared gateway locations routes. */
const USES_SHARED_V1_LOCATIONS = new Set([
  'alloydb',
  'cloud-kms',
  'cloud-scheduler',
  'cloud-sql',
  'memorystore',
  'networksecurity',
  'pubsub',
  'secret-manager',
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
  return (await extractServiceSurface(serviceName)).routes;
}

export async function extractServiceSurface(serviceName: string): Promise<ServiceSurface> {
  if (PLANNED_WITHOUT_ROUTES.has(serviceName)) {
    return { routes: [], grpc: [] };
  }

  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });
  const logger = new Logger('docs', 'error');

  if (serviceName === 'cloud-storage') {
    const blobRoot = await mkdtemp(join(tmpdir(), 'kinglet-blob-'));

    try {
      const service = new CloudStorageService(storage, logger, {
        blobPath: blobRoot,
        storageType: 'memory',
      });
      await service.initialize();

      return {
        routes: dedupeRoutes(service.getRoutes().map(toExtractedRoute)),
        grpc: await registeredGrpcMethods(service),
      };
    } finally {
      await rm(blobRoot, { recursive: true, force: true });
    }
  }

  const factory = SERVICE_FACTORIES[serviceName];

  if (!factory) {
    throw new Error(
      `No route extractor registered for service "${serviceName}". Add it to SERVICE_FACTORIES in scripts/lib/extract-service-routes.ts.`
    );
  }

  const service = factory(storage, logger);

  await service.initialize();

  const routes = service.getRoutes().map(toExtractedRoute);
  const withLocations = USES_SHARED_V1_LOCATIONS.has(serviceName)
    ? [...routes, ...getSharedV1LocationRoutes(logger)]
    : routes;

  return {
    routes: dedupeRoutes(withLocations),
    grpc: await registeredGrpcMethods(service),
  };
}

export async function extractRoutesForAllServices(
  serviceNames: readonly string[]
): Promise<Map<string, ExtractedRoute[]>> {
  const routesByService = new Map<string, ExtractedRoute[]>();

  for (const serviceName of serviceNames) {
    routesByService.set(serviceName, (await extractServiceSurface(serviceName)).routes);
  }

  return routesByService;
}

export async function extractServiceSurfaces(
  serviceNames: readonly string[]
): Promise<Map<string, ServiceSurface>> {
  const surfaces = new Map<string, ServiceSurface>();

  for (const serviceName of serviceNames) {
    surfaces.set(serviceName, await extractServiceSurface(serviceName));
  }

  return surfaces;
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
