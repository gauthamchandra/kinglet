/**
 * Memorystore for Valkey service - entry point
 *
 * Wires together repositories, services, handlers, the LRO operations
 * store, and the data plane that spawns real `valkey-server` processes.
 */

import type { ComposableOperationsStore } from '@/core/gateway/composable-operations.ts';
import type { RouteContext, RouteDefinition, RouteRequest } from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import type { StorageManager } from '@/core/storage/manager.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { parsePageSize } from '@/shared/utils/pagination.ts';
import { AclPolicyHandlers } from './acl-policy-handlers.ts';
import { AclPolicyRepository } from './acl-policy-repository.ts';
import { AclPolicyService } from './acl-policy-service.ts';
import { BackupHandlers } from './backup-handlers.ts';
import { BackupRepository } from './backup-repository.ts';
import { BackupService } from './backup-service.ts';
import { InstanceHandlers } from './instance-handlers.ts';
import { InstanceRepository } from './instance-repository.ts';
import { InstanceService } from './instance-service.ts';
import { LocationHandlers } from './location-handlers.ts';
import { OperationsStore } from './operations.ts';
import { TokenAuthHandlers } from './token-auth-handlers.ts';
import { TokenAuthRepository } from './token-auth-repository.ts';
import { TokenAuthService } from './token-auth-service.ts';
import { buildMemorystoreOperationName } from './types.ts';
import type { ValkeyProcessManagerOptions } from './valkey-process-manager.ts';
import { ValkeyProcessManager } from './valkey-process-manager.ts';

export type MemorystoreDataPlaneOptions = Partial<ValkeyProcessManagerOptions>;

// Mirrors the config schema's default (see src/config/schema.ts): the data
// plane is on unless a caller opts out, so an emulated instance is something a
// Valkey client can actually connect to. Tests that only exercise the control
// plane pass `{ enabled: false }` explicitly to avoid spawning processes.
const DEFAULT_DATA_PLANE_OPTIONS: ValkeyProcessManagerOptions = {
  enabled: true,
  portRangeStart: 6380,
  portRangeEnd: 6479,
};

export class MemorystoreService {
  private storage: StorageManager;
  private logger: Logger;
  private dataPlaneOptions: ValkeyProcessManagerOptions;
  private responseUtils: ResponseUtils;

  private instanceRepository: InstanceRepository | null = null;
  private operationsStore: OperationsStore | null = null;
  private valkeyProcessManager: ValkeyProcessManager | null = null;

  private instanceHandlers: InstanceHandlers | null = null;
  private backupHandlers: BackupHandlers | null = null;
  private aclPolicyHandlers: AclPolicyHandlers | null = null;
  private tokenAuthHandlers: TokenAuthHandlers | null = null;
  private locationHandlers: LocationHandlers | null = null;

  constructor(
    storage: StorageManager,
    logger: Logger,
    dataPlaneOptions?: MemorystoreDataPlaneOptions
  ) {
    this.storage = storage;
    this.logger = logger;
    this.dataPlaneOptions = { ...DEFAULT_DATA_PLANE_OPTIONS, ...dataPlaneOptions };
    this.responseUtils = new ResponseUtils(new StandardResponseFormatter(logger));
  }

  async initialize(): Promise<void> {
    this.instanceRepository = new InstanceRepository(this.storage);
    await this.instanceRepository.initialize();

    const backupRepository = new BackupRepository(this.storage);
    await backupRepository.initialize();

    const aclPolicyRepository = new AclPolicyRepository(this.storage);
    await aclPolicyRepository.initialize();

    const tokenAuthRepository = new TokenAuthRepository(this.storage);
    await tokenAuthRepository.initialize();

    this.operationsStore = new OperationsStore(this.storage);
    await this.operationsStore.initialize();

    this.valkeyProcessManager = new ValkeyProcessManager(this.logger, this.dataPlaneOptions);

    const instanceService = new InstanceService(
      this.instanceRepository,
      this.operationsStore,
      this.valkeyProcessManager,
      backupRepository,
      tokenAuthRepository
    );
    const backupService = new BackupService(backupRepository, this.operationsStore);
    const aclPolicyService = new AclPolicyService(aclPolicyRepository, this.operationsStore);
    const tokenAuthService = new TokenAuthService(tokenAuthRepository, this.operationsStore);

    this.instanceHandlers = new InstanceHandlers(instanceService, this.logger);
    this.backupHandlers = new BackupHandlers(backupService, this.logger);
    this.aclPolicyHandlers = new AclPolicyHandlers(aclPolicyService, this.logger);
    this.tokenAuthHandlers = new TokenAuthHandlers(tokenAuthService, this.logger);
    this.locationHandlers = new LocationHandlers(this.logger);

    if (this.dataPlaneOptions.enabled) {
      await this.respawnPersistedActiveInstances();
    }

    this.logger.info('Memorystore for Valkey service initialized');
  }

  getRoutes(): RouteDefinition[] {
    if (
      !this.instanceHandlers ||
      !this.backupHandlers ||
      !this.aclPolicyHandlers ||
      !this.tokenAuthHandlers ||
      !this.locationHandlers
    ) {
      throw new Error('MemorystoreService not initialized. Call initialize() first.');
    }

    return [
      ...this.buildOperationsRoutes(),
      ...this.locationHandlers.getRoutes(),
      ...this.tokenAuthHandlers.getRoutes(),
      ...this.instanceHandlers.getRoutes(),
      ...this.backupHandlers.getRoutes(),
      ...this.aclPolicyHandlers.getRoutes(),
    ];
  }

  start(): void {
    this.logger.info('Memorystore for Valkey service started');
  }

  /**
   * Expose this service's operations store in the shape `buildComposedOperationsRoutes`
   * needs so a composed router (see src/index.ts) can serve Memorystore LROs even
   * when another service's `/operations` routes would otherwise shadow this one's.
   */
  getComposableOperationsStore(): ComposableOperationsStore {
    const store = this.getOperationsStoreOrThrow();

    return {
      getOperation: name => store.getOperation(name) as Promise<Record<string, unknown> | null>,
      listOperations: (project, location, pageSize, pageToken) =>
        store.listOperations(project, location, pageSize, pageToken) as unknown as Promise<{
          operations: Record<string, unknown>[];
          nextPageToken?: string;
        }>,
      deleteOperation: name => store.deleteOperation(name),
    };
  }

  async stop(): Promise<void> {
    await this.valkeyProcessManager?.stopAllServers();
    this.logger.info('Memorystore for Valkey service stopped');
  }

  private buildOperationsRoutes(): RouteDefinition[] {
    return [
      {
        id: 'memorystore.operations.cancel',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/operations/:operation:cancel',
        handler: (req, ctx) => this.handleCancelOperation(req, ctx),
      },
      {
        id: 'memorystore.operations.list',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/operations',
        handler: (req, ctx) => this.handleListOperations(req, ctx),
      },
      {
        id: 'memorystore.operations.get',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/operations/:operation',
        handler: (req, ctx) => this.handleGetOperation(req, ctx),
      },
      {
        id: 'memorystore.operations.delete',
        method: 'DELETE',
        path: '/v1/projects/:project/locations/:location/operations/:operation',
        handler: (req, ctx) => this.handleDeleteOperation(req, ctx),
      },
    ];
  }

  private async handleListOperations(req: RouteRequest, _ctx: RouteContext) {
    const { project, location } = req.params;
    const pageSize = parsePageSize(req.query.pageSize);
    const pageToken = (req.query.pageToken as string) || undefined;

    const result = await this.getOperationsStoreOrThrow().listOperations(
      project ?? '',
      location ?? '',
      pageSize,
      pageToken
    );

    const body: Record<string, unknown> = { operations: result.operations };

    if (result.nextPageToken) body.nextPageToken = result.nextPageToken;

    return this.responseUtils.success(body);
  }

  private async handleGetOperation(req: RouteRequest, _ctx: RouteContext) {
    const name = this.buildOperationNameFromParams(req.params);
    const result = await this.getOperationsStoreOrThrow().getOperation(name);

    if (!result) return this.responseUtils.notFound('Operation', name);

    return this.responseUtils.success(result);
  }

  private async handleDeleteOperation(req: RouteRequest, _ctx: RouteContext) {
    const name = this.buildOperationNameFromParams(req.params);
    const deleted = await this.getOperationsStoreOrThrow().deleteOperation(name);

    if (!deleted) return this.responseUtils.notFound('Operation', name);

    return this.responseUtils.success({});
  }

  private async handleCancelOperation(req: RouteRequest, _ctx: RouteContext) {
    const name = this.buildOperationNameFromParams(req.params);
    const cancelled = await this.getOperationsStoreOrThrow().cancelOperation(name);

    if (!cancelled) return this.responseUtils.notFound('Operation', name);

    return this.responseUtils.success({});
  }

  private buildOperationNameFromParams(params: Record<string, string>): string {
    return buildMemorystoreOperationName(
      params.project ?? '',
      params.location ?? '',
      params.operation ?? ''
    );
  }

  private getOperationsStoreOrThrow(): OperationsStore {
    if (!this.operationsStore) {
      throw new Error('MemorystoreService not initialized. Call initialize() first.');
    }

    return this.operationsStore;
  }

  private async respawnPersistedActiveInstances(): Promise<void> {
    if (!this.instanceRepository || !this.valkeyProcessManager) return;

    const instances = await this.instanceRepository.listAllInstances();

    for (const instance of instances.filter(i => i.state === 'ACTIVE')) {
      try {
        const endpoint = await this.valkeyProcessManager.startServerForInstance(instance.name);

        await this.instanceRepository.updateInstance(instance.name, {
          discoveryEndpoints: JSON.stringify([endpoint]),
        });
      } catch (error) {
        // One instance that cannot acquire a data-plane port (an exhausted
        // range, a readiness timeout) must degrade only itself, not take down
        // the emulator's startup for every other persisted instance.
        this.logger.warn(
          `Failed to respawn Memorystore instance's data plane, leaving it degraded`,
          error
        );
      }
    }
  }
}
