/**
 * Tests for SecretsManagerService lifecycle
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { SecretsManagerService } from './index.ts';

describe('SecretsManagerService', () => {
  let storage: StorageManager;
  let service: SecretsManagerService;
  const logger = new Logger('test', 'error');

  afterEach(async () => {
    if (service) {
      await service.stop();
    }
  });

  test('should throw when getRoutes called before initialize', () => {
    storage = new StorageManager();
    service = new SecretsManagerService(storage, logger);

    expect(() => service.getRoutes()).toThrow('not initialized');
  });

  test('should initialize without error', async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    service = new SecretsManagerService(storage, logger);

    await expect(service.initialize()).resolves.toBeUndefined();
  });

  test('should return routes after initialization', async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    service = new SecretsManagerService(storage, logger);
    await service.initialize();

    const routes = service.getRoutes();

    expect(routes.length).toBeGreaterThan(0);
  });

  test('start and stop should not throw', async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    service = new SecretsManagerService(storage, logger);
    await service.initialize();

    expect(() => service.start()).not.toThrow();
    await expect(service.stop()).resolves.toBeUndefined();
  });
});
