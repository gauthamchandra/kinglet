/**
 * Secret Manager service. REST and gRPC both call SecretManager.
 */

import path from 'node:path';
import { getProtoPath } from 'google-proto-files';
import type { GrpcServiceDefinition } from '@/core/gateway/grpc-server.ts';
import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import type { StorageManager } from '@/core/storage/manager.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { buildGrpcImplementation, buildRestRoutes } from './handlers.ts';
import { SecretRepository } from './repository.ts';
import { SecretManager } from './service.ts';

export class SecretsService {
  private readonly storage: StorageManager;

  private readonly logger: Logger;

  private readonly formatter: StandardResponseFormatter;

  private readonly responseUtils: ResponseUtils;

  private manager: SecretManager | null = null;

  constructor(storage: StorageManager, logger: Logger) {
    this.storage = storage;
    this.logger = logger;
    this.formatter = new StandardResponseFormatter(logger);
    this.responseUtils = new ResponseUtils(this.formatter);
  }

  async initialize(): Promise<void> {
    if (this.manager != null) {
      return;
    }

    const repository = new SecretRepository(this.storage);

    await repository.initialize();
    this.manager = new SecretManager(repository);
    this.logger.info('Secret Manager service initialized');
  }

  getRoutes(): RouteDefinition[] {
    return buildRestRoutes(this.managerOrThrow(), this.responseUtils, this.formatter);
  }

  getGrpcServices(): GrpcServiceDefinition[] {
    const protoPath = getProtoPath('cloud/secretmanager/v1/service.proto');
    const protoRoot = path.resolve(path.dirname(protoPath), '../../../..');

    return [
      {
        name: 'SecretManager',
        protoPath,
        packageName: 'google.cloud.secretmanager.v1',
        serviceName: 'SecretManagerService',
        implementation: buildGrpcImplementation(this.managerOrThrow()),
        includeDirs: [protoRoot],
      },
    ];
  }

  start(): void {
    this.managerOrThrow();
  }

  async stop(): Promise<void> {
    this.logger.info('Secret Manager service stopped');
  }

  private managerOrThrow(): SecretManager {
    if (this.manager == null) {
      throw new Error('SecretsService not initialized. Call initialize() first.');
    }

    return this.manager;
  }
}
