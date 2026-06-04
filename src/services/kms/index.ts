/**
 * Cloud KMS Service — entry point.
 *
 * Wires the three repositories (key rings, crypto keys, crypto key versions),
 * the management + crypto services, and the HTTP handlers. KMS has no background
 * processing, so start()/stop() are lifecycle no-ops kept for interface symmetry
 * with the other emulated services.
 */

import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import type { StorageManager } from '@/core/storage/manager.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { CryptoService } from './crypto-service.ts';
import { KmsHandlers } from './handlers.ts';
import { KeyManagementService } from './key-management-service.ts';
import {
  CryptoKeyRepository,
  CryptoKeyVersionRepository,
  KeyRingRepository,
} from './repository.ts';

export class CloudKmsService {
  private storage: StorageManager;
  private logger: Logger;
  private handlers: KmsHandlers | null = null;

  constructor(storage: StorageManager, logger: Logger) {
    this.storage = storage;
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    const keyRingRepo = new KeyRingRepository(this.storage);
    await keyRingRepo.initialize();

    const cryptoKeyRepo = new CryptoKeyRepository(this.storage);
    await cryptoKeyRepo.initialize();

    const versionRepo = new CryptoKeyVersionRepository(this.storage);
    await versionRepo.initialize();

    const management = new KeyManagementService(keyRingRepo, cryptoKeyRepo, versionRepo);
    const crypto = new CryptoService(cryptoKeyRepo, versionRepo);

    this.handlers = new KmsHandlers(management, crypto, this.logger);

    this.logger.info('Cloud KMS service initialized');
  }

  getRoutes(): RouteDefinition[] {
    if (!this.handlers) {
      throw new Error('CloudKmsService not initialized. Call initialize() first.');
    }

    return this.handlers.getRoutes();
  }

  start(): void {
    this.logger.info('Cloud KMS service started');
  }

  async stop(): Promise<void> {
    this.logger.info('Cloud KMS service stopped');
  }
}
