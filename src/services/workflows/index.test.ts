/**
 * Cloud Workflows Service - Integration Tests
 */

import { describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { CloudWorkflowsService } from './index.ts';

describe('CloudWorkflowsService', () => {
  test('initializes without error', async () => {
    const storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    const service = new CloudWorkflowsService(storage, new Logger('test', 'error'));
    await service.initialize();

    expect(service.getWorkflowService()).toBeDefined();
  });

  test('returns routes with correct count and IDs', async () => {
    const storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    const service = new CloudWorkflowsService(storage, new Logger('test', 'error'));
    await service.initialize();

    const routes = service.getRoutes();

    expect(routes).toHaveLength(11);

    const ids = routes.map(r => r.id);

    expect(ids).toContain('workflows.create');
    expect(ids).toContain('workflows.get');
    expect(ids).toContain('workflows.list');
    expect(ids).toContain('workflows.update');
    expect(ids).toContain('workflows.delete');
    expect(ids).toContain('workflows.revisions.list');
    expect(ids).toContain('workflows.operations.list');
    expect(ids).toContain('workflows.operations.get');
    expect(ids).toContain('workflows.operations.delete');
    expect(ids).toContain('workflows.locations.list');
    expect(ids).toContain('workflows.locations.get');
  });

  test('throws if getRoutes called before initialize', () => {
    const storage = new StorageManager();

    const service = new CloudWorkflowsService(storage, new Logger('test', 'error'));

    expect(() => service.getRoutes()).toThrow('not initialized');
  });

  test('stops cleanly', async () => {
    const storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    const service = new CloudWorkflowsService(storage, new Logger('test', 'error'));
    await service.initialize();

    await expect(service.stop()).resolves.toBeUndefined();
  });
});
