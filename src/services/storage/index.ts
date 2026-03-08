/**
 * Cloud Storage Service - entry point
 *
 * Wires together all storage components: repositories, blob store,
 * services, and handlers.
 */

import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import type { StorageManager } from '@/core/storage/manager.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { BlobStore } from './blob-store.ts';
import { BucketHandlers } from './bucket-handlers.ts';
import { BucketRepository } from './bucket-repository.ts';
import { BucketService } from './bucket-service.ts';
import { ObjectHandlers } from './object-handlers.ts';
import { ObjectRepository } from './object-repository.ts';
import { ObjectService } from './object-service.ts';

export class CloudStorageService {
  private storage: StorageManager;
  private logger: Logger;
  private blobStore: BlobStore | null = null;
  private bucketRepo: BucketRepository | null = null;
  private objectRepo: ObjectRepository | null = null;
  private bucketService: BucketService | null = null;
  private objectService: ObjectService | null = null;
  private bucketHandlers: BucketHandlers | null = null;
  private objectHandlers: ObjectHandlers | null = null;

  constructor(storage: StorageManager, logger: Logger) {
    this.storage = storage;
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    this.blobStore = new BlobStore();

    this.bucketRepo = new BucketRepository(this.storage);
    await this.bucketRepo.initialize();

    this.objectRepo = new ObjectRepository(this.storage);
    await this.objectRepo.initialize();

    this.bucketService = new BucketService(this.bucketRepo, this.objectRepo);
    this.objectService = new ObjectService(this.objectRepo, this.bucketRepo, this.blobStore);

    this.bucketHandlers = new BucketHandlers(this.bucketService, this.logger);
    this.objectHandlers = new ObjectHandlers(this.objectService, this.logger);

    this.logger.info('Cloud Storage service initialized');
  }

  getRoutes(): RouteDefinition[] {
    if (!this.bucketHandlers || !this.objectHandlers) {
      throw new Error('CloudStorageService not initialized. Call initialize() first.');
    }

    return [...this.bucketHandlers.getRoutes(), ...this.objectHandlers.getRoutes()];
  }

  start(): void {
    // No background engine needed for storage
    this.logger.info('Cloud Storage service started');
  }

  async stop(): Promise<void> {
    if (this.blobStore) {
      this.blobStore.cleanup();
    }

    this.logger.info('Cloud Storage service stopped');
  }
}
