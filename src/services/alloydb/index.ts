/**
 * AlloyDB for PostgreSQL service module.
 *
 * <p>Specification: `https://alloydb.googleapis.com/$discovery/rest?version=v1`
 * (revision 20260805).
 *
 * <p><b>NOTE:</b> this release emulates the control plane only — 23 of the API's
 * 40 methods. Nothing listens on a PostgreSQL port, so `Instance.ipAddress` and
 * `ConnectionInfo.ipAddress` report a loopback placeholder to keep the response
 * shape right. Backups and every replication/maintenance custom verb
 * (`promote`, `failover`, `restore`, `switchover`, `upgrade`, `injectFault`,
 * `restart`, `createsecondary`, `export`, `import`, `restoreFromCloudSQL`) are
 * deliberately absent rather than stubbed; see the README for the full list.
 *
 * <p>There is intentionally no `start()` or `stop()`: the service owns no
 * background work and no OS resources, and `StorageManager` is closed centrally.
 * The data plane change that introduces both is tracked separately.
 */

import type { ComposableOperationsStore } from '@/core/gateway/composable-operations.ts';
import { buildComposedOperationsRoutes } from '@/core/gateway/composable-operations.ts';
import type {
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import { buildOperationName, OperationsStore } from '@/core/operations/operations-store.ts';
import type { StorageManager } from '@/core/storage/manager.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { parsePageSize } from '@/shared/utils/pagination.ts';
import { ClusterHandlers } from './cluster-handlers.ts';
import { ClusterRepository } from './cluster-repository.ts';
import { ClusterService } from './cluster-service.ts';
import { readQueryString, respondWith } from './handler-support.ts';
import { InstanceHandlers } from './instance-handlers.ts';
import { InstanceRepository } from './instance-repository.ts';
import { InstanceService } from './instance-service.ts';
import { LocationHandlers } from './location-handlers.ts';
import { ALLOYDB_OPERATIONS_TABLE, AlloyDbError } from './types.ts';
import { UserHandlers } from './user-handlers.ts';
import { UserRepository } from './user-repository.ts';
import { UserService } from './user-service.ts';

/** The proto package AlloyDB's messages live in, stamped into LRO metadata. */
const ALLOYDB_API_TYPE_PREFIX = 'google.cloud.alloydb.v1';

const OPERATIONS_COLLECTION_PATH = '/v1/projects/:project/locations/:location/operations';
const OPERATION_PATH = `${OPERATIONS_COLLECTION_PATH}/:operationId`;

export class AlloyDbService {
  private readonly storage: StorageManager;
  private readonly responseUtils: ResponseUtils;

  private operationsStore: OperationsStore | null = null;
  private clusterHandlers: ClusterHandlers | null = null;
  private instanceHandlers: InstanceHandlers | null = null;
  private userHandlers: UserHandlers | null = null;
  private locationHandlers: LocationHandlers | null = null;

  constructor(storage: StorageManager, logger: Logger) {
    this.storage = storage;
    this.responseUtils = new ResponseUtils(new StandardResponseFormatter(logger));
  }

  async initialize(): Promise<void> {
    const clusters = new ClusterRepository(this.storage);
    const instances = new InstanceRepository(this.storage);
    const users = new UserRepository(this.storage);
    const operations = new OperationsStore(this.storage, {
      tableName: ALLOYDB_OPERATIONS_TABLE,
      apiTypePrefix: ALLOYDB_API_TYPE_PREFIX,
    });

    await Promise.all([
      clusters.initialize(),
      instances.initialize(),
      users.initialize(),
      operations.initialize(),
    ]);

    this.operationsStore = operations;
    this.clusterHandlers = new ClusterHandlers(
      new ClusterService(clusters, instances, users, operations),
      this.responseUtils
    );
    this.instanceHandlers = new InstanceHandlers(
      new InstanceService(instances, clusters, operations),
      this.responseUtils
    );
    this.userHandlers = new UserHandlers(new UserService(users, clusters), this.responseUtils);
    this.locationHandlers = new LocationHandlers(this.responseUtils);
  }

  /**
   * <p><b>IMPORTANT:</b> ordering is load-bearing. `RequestRouter` picks one
   * winner per path, so routes whose last segment is a literal sub-resource
   * (`.../instances/:instance/connectionInfo`,
   * `.../locations/:location/supportedDatabaseFlags`) must be registered before
   * the parameterised sibling that would otherwise absorb them.
   */
  getRoutes(): RouteDefinition[] {
    if (
      !this.clusterHandlers ||
      !this.instanceHandlers ||
      !this.userHandlers ||
      !this.locationHandlers
    ) {
      throw new Error('AlloyDbService.getRoutes() called before initialize()');
    }

    return [
      ...this.buildOperationsRoutes(),
      ...this.instanceHandlers.getRoutes(),
      ...this.userHandlers.getRoutes(),
      ...this.clusterHandlers.getRoutes(),
      ...this.locationHandlers.getRoutes(),
    ];
  }

  /**
   * Expose this service's operations store in the shape
   * {@link buildComposedOperationsRoutes} needs.
   *
   * <p>Workflows, Memorystore and now AlloyDB all publish `/operations` routes of
   * identical shape, and the router can only pick one winner per path. Without
   * being added to the composed set in `src/index.ts`, AlloyDB's LROs would be
   * silently shadowed by whichever service registered first.
   */
  getComposableOperationsStore(): ComposableOperationsStore {
    const store = this.getOperationsStoreOrThrow();

    return {
      getOperation: async name =>
        (await store.getOperation(name)) as Record<string, unknown> | null,
      listOperations: async (project, location, pageSize, pageToken) => {
        const result = await store.listOperations(project, location, pageSize, pageToken);

        return {
          operations: result.operations as unknown as Record<string, unknown>[],
          ...(result.nextPageToken === undefined ? {} : { nextPageToken: result.nextPageToken }),
        };
      },
      deleteOperation: name => store.deleteOperation(name),
      cancelOperation: name => store.cancelOperation(name),
    };
  }

  private buildOperationsRoutes(): RouteDefinition[] {
    return [
      {
        id: 'alloydb.operations.list',
        method: 'GET',
        path: OPERATIONS_COLLECTION_PATH,
        handler: req => this.handleListOperations(req),
      },
      {
        id: 'alloydb.operations.cancel',
        method: 'POST',
        path: `${OPERATION_PATH}:cancel`,
        handler: req => this.handleCancelOperation(req),
      },
      {
        id: 'alloydb.operations.get',
        method: 'GET',
        path: OPERATION_PATH,
        handler: req => this.handleGetOperation(req),
      },
      {
        id: 'alloydb.operations.delete',
        method: 'DELETE',
        path: OPERATION_PATH,
        handler: req => this.handleDeleteOperation(req),
      },
    ];
  }

  private handleListOperations(req: RouteRequest): Promise<RouteResponse> {
    return respondWith('Operation', this.responseUtils, async () => {
      const result = await this.getOperationsStoreOrThrow().listOperations(
        req.params.project ?? '',
        req.params.location ?? '',
        parsePageSize(req.query.pageSize),
        readQueryString(req.query.pageToken)
      );

      return result.nextPageToken === undefined
        ? { operations: result.operations }
        : { operations: result.operations, nextPageToken: result.nextPageToken };
    });
  }

  private handleGetOperation(req: RouteRequest): Promise<RouteResponse> {
    return respondWith('Operation', this.responseUtils, async () => {
      const name = operationNameFrom(req);
      const operation = await this.getOperationsStoreOrThrow().getOperation(name);

      if (!operation) {
        throw new AlloyDbError('NOT_FOUND', `Operation ${name} not found`, name, 'Operation');
      }

      return operation;
    });
  }

  private handleDeleteOperation(req: RouteRequest): Promise<RouteResponse> {
    return respondWith('Operation', this.responseUtils, async () => {
      const name = operationNameFrom(req);

      if (!(await this.getOperationsStoreOrThrow().deleteOperation(name))) {
        throw new AlloyDbError('NOT_FOUND', `Operation ${name} not found`, name, 'Operation');
      }

      return {};
    });
  }

  private handleCancelOperation(req: RouteRequest): Promise<RouteResponse> {
    return respondWith('Operation', this.responseUtils, async () => {
      const name = operationNameFrom(req);

      if (!(await this.getOperationsStoreOrThrow().cancelOperation(name))) {
        throw new AlloyDbError('NOT_FOUND', `Operation ${name} not found`, name, 'Operation');
      }

      return {};
    });
  }

  private getOperationsStoreOrThrow(): OperationsStore {
    if (!this.operationsStore) {
      throw new Error('AlloyDbService used before initialize()');
    }

    return this.operationsStore;
  }
}

function operationNameFrom(req: RouteRequest): string {
  return buildOperationName(
    req.params.project ?? '',
    req.params.location ?? '',
    req.params.operationId ?? ''
  );
}
