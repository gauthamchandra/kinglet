import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { createMockLogger } from '../../../test-utils/mock-logger.ts';
import { CloudStorageService } from './index.ts';

describe('CloudStorageService', () => {
  let storage: StorageManager;
  let service: CloudStorageService;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    service = new CloudStorageService(storage, createMockLogger());
  });

  afterEach(async () => {
    await service.stop();
  });

  test('initialize creates tables and wires components', async () => {
    await expect(service.initialize()).resolves.toBeUndefined();
  });

  test('getRoutes returns non-empty array after initialize', async () => {
    await service.initialize();
    const routes = service.getRoutes();

    expect(routes.length).toBeGreaterThan(0);
  });

  test('getRoutes throws before initialize', () => {
    expect(() => service.getRoutes()).toThrow('not initialized');
  });

  test('getRoutes returns combined bucket+object routes with unique IDs', async () => {
    await service.initialize();
    const routes = service.getRoutes();

    const ids = routes.map(r => r.id);
    expect(ids).toContain('storage.buckets.insert');
    expect(ids).toContain('storage.objects.insert');

    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  test('start and stop do not error', async () => {
    await service.initialize();
    service.start();
    await expect(service.stop()).resolves.toBeUndefined();
  });
});
