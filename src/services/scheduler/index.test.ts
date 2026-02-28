/**
 * Tests for SchedulerService - entry point integration test
 */

import { test, expect, describe, afterEach } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { SchedulerService } from './index.ts';

describe('SchedulerService', () => {
  let storage: StorageManager;
  let service: SchedulerService;
  const logger = new Logger('test', 'error');

  afterEach(async () => {
    if (service) {
      await service.stop();
    }
  });

  test('should initialize without error', async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    service = new SchedulerService(storage, logger);

    await expect(service.initialize()).resolves.toBeUndefined();
  });

  test('should return route definitions after initialization', async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    service = new SchedulerService(storage, logger);
    await service.initialize();

    const routes = service.getRoutes();

    expect(routes.length).toBe(8);
    expect(routes[0]?.id).toContain('scheduler');
  });

  test('should start and stop cleanly', async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    service = new SchedulerService(storage, logger);
    await service.initialize();

    service.start();

    await expect(service.stop()).resolves.toBeUndefined();
  });

  test('should expose the job service for direct access', async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    service = new SchedulerService(storage, logger);
    await service.initialize();

    const jobService = service.getJobService();

    expect(jobService).toBeDefined();

    // Test that the service is functional by creating a job
    const result = await jobService.createJob('test-project', 'us-central1', 'test-job', {
      schedule: '* * * * *',
      httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
    });

    expect(result.name).toBe('projects/test-project/locations/us-central1/jobs/test-job');
  });

  test('should expose the execution engine for manual triggering', async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    service = new SchedulerService(storage, logger);
    await service.initialize();

    const engine = service.getExecutionEngine();

    expect(engine).toBeDefined();
  });
});
