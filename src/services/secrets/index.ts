/**
 * Secret Manager Service - entry point
 *
 * Wires together all secrets components: repository, encryption,
 * service, and handlers.
 */

import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import type { StorageManager } from '@/core/storage/manager.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { deriveKey } from './encryption.ts';
import { SecretsHandlers } from './handlers.ts';
import { SecretRepository } from './repository.ts';
import { SecretService } from './service.ts';

const DEFAULT_MASTER_KEY = 'localstack-dev-key';
const KEY_SALT = 'localstack-gcp-secrets';

export class SecretsManagerService {
  private storage: StorageManager;
  private logger: Logger;
  private repository: SecretRepository | null = null;
  private service: SecretService | null = null;
  private handlers: SecretsHandlers | null = null;

  constructor(storage: StorageManager, logger: Logger) {
    this.storage = storage;
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    this.repository = new SecretRepository(this.storage);
    await this.repository.initialize();

    const masterKey = process.env.SECRETS_MASTER_KEY ?? DEFAULT_MASTER_KEY;
    const encryptionKey = deriveKey(masterKey, KEY_SALT);

    this.service = new SecretService(this.repository, encryptionKey);
    this.handlers = new SecretsHandlers(this.service, this.logger);

    this.logger.info('Secret Manager service initialized');
  }

  getRoutes(): RouteDefinition[] {
    if (!this.handlers) {
      throw new Error('SecretsManagerService not initialized. Call initialize() first.');
    }

    return this.handlers.getRoutes();
  }

  start(): void {
    // No background engine needed for Secret Manager
  }

  async stop(): Promise<void> {
    this.logger.info('Secret Manager service stopped');
  }
}
