/**
 * Cloud Storage Service - entry point
 *
 * Wires together all storage components: repositories, blob store,
 * services, and handlers.
 */

import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import { resolveBlobPath } from '@/core/storage/config.ts';
import type { StorageManager } from '@/core/storage/manager.ts';
import type { StorageType } from '@/core/storage/types.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import { BlobStore } from './blob-store.ts';
import { BucketHandlers } from './bucket-handlers.ts';
import { BucketRepository } from './bucket-repository.ts';
import { BucketService } from './bucket-service.ts';
import { HmacKeyHandlers } from './hmac-handlers.ts';
import { HmacKeyRepository } from './hmac-repository.ts';
import { HmacKeyService } from './hmac-service.ts';
import { IamHandlers } from './iam-handlers.ts';
import { IamPolicyRepository } from './iam-repository.ts';
import { IamService } from './iam-service.ts';
import { NotificationHandlers } from './notification-handlers.ts';
import { NotificationRepository } from './notification-repository.ts';
import { NotificationService } from './notification-service.ts';
import { ObjectHandlers } from './object-handlers.ts';
import { ObjectRepository } from './object-repository.ts';
import { ObjectService } from './object-service.ts';

export class CloudStorageService {
  private storage: StorageManager;
  private logger: Logger;
  private blobPath: string;
  private storageType: StorageType;
  private blobStore: BlobStore | null = null;
  private bucketRepo: BucketRepository | null = null;
  private objectRepo: ObjectRepository | null = null;
  private bucketService: BucketService | null = null;
  private objectService: ObjectService | null = null;
  private bucketHandlers: BucketHandlers | null = null;
  private objectHandlers: ObjectHandlers | null = null;
  private hmacRepo: HmacKeyRepository | null = null;
  private hmacService: HmacKeyService | null = null;
  private hmacHandlers: HmacKeyHandlers | null = null;
  private iamHandlers: IamHandlers | null = null;
  private notificationHandlers: NotificationHandlers | null = null;

  constructor(
    storage: StorageManager,
    logger: Logger,
    options: { blobPath: string; storageType: StorageType }
  ) {
    this.storage = storage;
    this.logger = logger;
    this.blobPath = options.blobPath;
    this.storageType = options.storageType;
  }

  async initialize(): Promise<void> {
    this.blobStore = new BlobStore(resolveBlobPath(this.blobPath), {
      trackWrittenPaths: this.storageType === 'memory',
    });

    this.bucketRepo = new BucketRepository(this.storage);
    await this.bucketRepo.initialize();

    this.objectRepo = new ObjectRepository(this.storage);
    await this.objectRepo.initialize();

    const iamRepo = new IamPolicyRepository(this.storage);
    await iamRepo.initialize();

    const notificationRepo = new NotificationRepository(this.storage);
    await notificationRepo.initialize();

    const writes = new ResourceMutex();

    this.bucketService = new BucketService(this.bucketRepo, this.objectRepo, iamRepo, writes);
    this.objectService = new ObjectService(
      this.objectRepo,
      this.bucketRepo,
      this.blobStore,
      iamRepo,
      writes
    );
    const iamService = new IamService(this.bucketRepo, iamRepo, writes, this.objectRepo);
    const notificationService = new NotificationService(notificationRepo, this.bucketRepo);

    this.bucketHandlers = new BucketHandlers(this.bucketService, this.logger);
    this.objectHandlers = new ObjectHandlers(this.objectService, this.logger);
    this.iamHandlers = new IamHandlers(iamService, this.logger);
    this.notificationHandlers = new NotificationHandlers(notificationService, this.logger);

    this.hmacRepo = new HmacKeyRepository(this.storage);
    await this.hmacRepo.initialize();
    this.hmacService = new HmacKeyService(this.hmacRepo);
    this.hmacHandlers = new HmacKeyHandlers(this.hmacService, this.logger);

    this.logger.info('Cloud Storage service initialized');
  }

  getRoutes(): RouteDefinition[] {
    if (
      !this.bucketHandlers ||
      !this.objectHandlers ||
      !this.iamHandlers ||
      !this.notificationHandlers ||
      !this.hmacHandlers
    ) {
      throw new Error('CloudStorageService not initialized. Call initialize() first.');
    }

    return [
      ...this.bucketHandlers.getRoutes(),
      ...this.objectHandlers.getRoutes(),
      ...this.iamHandlers.getRoutes(),
      ...this.notificationHandlers.getRoutes(),
      ...this.hmacHandlers.getRoutes(),
    ];
  }

  start(): void {
    // No background engine needed for storage
    this.logger.info('Cloud Storage service started');
  }

  async stop(storageType: StorageType): Promise<void> {
    // Memory drops the object rows on exit. Sqlite may share this directory, so
    // cleanup unlinks only the files this process stored and leaves the tree.
    // Sqlite stop deletes nothing.
    if (storageType === 'memory') {
      this.blobStore?.cleanup();
    }

    this.logger.info('Cloud Storage service stopped');
  }
}
