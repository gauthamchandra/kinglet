/**
 * Network Security service — project-scoped address groups.
 *
 * Specification: `https://networksecurity.googleapis.com/$discovery/rest?version=v1`.
 */

import type { ComposableOperationsStore } from '@/core/gateway/composable-operations.ts';
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
import { readQueryString, respondWith } from './handler-support.ts';
import { AddressGroupHandlers } from './handlers.ts';
import { AddressGroupRepository } from './repository.ts';
import { AddressGroupService } from './service.ts';
import {
  NETWORKSECURITY_API_TYPE_PREFIX,
  NETWORKSECURITY_OPERATIONS_TABLE,
  NetworkSecurityError,
} from './types.ts';

const OPERATIONS_COLLECTION_PATH = '/v1/projects/:project/locations/:location/operations';
const OPERATION_PATH = `${OPERATIONS_COLLECTION_PATH}/:operationId`;

export class NetworkSecurityService {
  private readonly storage: StorageManager;
  private readonly logger: Logger;
  private readonly responseUtils: ResponseUtils;

  private operationsStore: OperationsStore | null = null;
  private addressGroupHandlers: AddressGroupHandlers | null = null;

  constructor(storage: StorageManager, logger: Logger) {
    this.storage = storage;
    this.logger = logger;
    this.responseUtils = new ResponseUtils(new StandardResponseFormatter(logger));
  }

  async initialize(): Promise<void> {
    if (this.operationsStore != null) {
      return;
    }

    const groups = new AddressGroupRepository(this.storage);
    const operations = new OperationsStore(this.storage, {
      tableName: NETWORKSECURITY_OPERATIONS_TABLE,
      apiTypePrefix: NETWORKSECURITY_API_TYPE_PREFIX,
    });

    await Promise.all([groups.initialize(), operations.initialize()]);

    this.operationsStore = operations;
    this.addressGroupHandlers = new AddressGroupHandlers(
      new AddressGroupService(groups, operations),
      this.responseUtils
    );

    this.logger.info('Network Security service initialized');
  }

  getRoutes(): RouteDefinition[] {
    if (this.addressGroupHandlers == null) {
      throw new Error('NetworkSecurityService.getRoutes() called before initialize()');
    }

    return [...this.buildOperationsRoutes(), ...this.addressGroupHandlers.getRoutes()];
  }

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

  start(): void {
    this.logger.info('Network Security service started');
  }

  async stop(): Promise<void> {
    this.logger.info('Network Security service stopped');
  }

  private buildOperationsRoutes(): RouteDefinition[] {
    return [
      {
        id: 'networksecurity.operations.list',
        method: 'GET',
        path: OPERATIONS_COLLECTION_PATH,
        handler: req => this.handleListOperations(req),
      },
      {
        id: 'networksecurity.operations.cancel',
        method: 'POST',
        path: `${OPERATION_PATH}:cancel`,
        handler: req => this.handleCancelOperation(req),
      },
      {
        id: 'networksecurity.operations.get',
        method: 'GET',
        path: OPERATION_PATH,
        handler: req => this.handleGetOperation(req),
      },
      {
        id: 'networksecurity.operations.delete',
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

      if (operation == null) {
        throw new NetworkSecurityError(
          'NOT_FOUND',
          `Operation ${name} not found`,
          name,
          'Operation'
        );
      }

      return operation;
    });
  }

  private handleDeleteOperation(req: RouteRequest): Promise<RouteResponse> {
    return respondWith('Operation', this.responseUtils, async () => {
      const name = operationNameFrom(req);

      if (!(await this.getOperationsStoreOrThrow().deleteOperation(name))) {
        throw new NetworkSecurityError(
          'NOT_FOUND',
          `Operation ${name} not found`,
          name,
          'Operation'
        );
      }

      return {};
    });
  }

  private handleCancelOperation(req: RouteRequest): Promise<RouteResponse> {
    return respondWith('Operation', this.responseUtils, async () => {
      const name = operationNameFrom(req);

      if (!(await this.getOperationsStoreOrThrow().cancelOperation(name))) {
        throw new NetworkSecurityError(
          'NOT_FOUND',
          `Operation ${name} not found`,
          name,
          'Operation'
        );
      }

      return {};
    });
  }

  private getOperationsStoreOrThrow(): OperationsStore {
    if (this.operationsStore == null) {
      throw new Error('NetworkSecurityService used before initialize()');
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
