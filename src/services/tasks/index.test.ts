/**
 * Tests for CloudTasksService
 *
 * Validates that the service entry point correctly wires together
 * repositories, services, handlers, and the dispatch engine.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { CloudTasksService } from './index.ts';
import { QueueRepository } from './queue-repository.ts';
import { TaskRepository } from './task-repository.ts';
import {
  QueueState,
  TaskStatus,
  DEFAULT_RATE_LIMITS,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_TASK_TTL,
  DEFAULT_TOMBSTONE_TTL,
  DEFAULT_DISPATCH_DEADLINE,
} from './types.ts';
import type { QueueRecord, TaskRecord } from './types.ts';
import type { BaseRecord } from '@/core/storage/types.ts';

function makeQueueData(
  overrides: Partial<Omit<QueueRecord, keyof BaseRecord>> = {}
): Omit<QueueRecord, keyof BaseRecord> {
  return {
    name: 'projects/p/locations/l/queues/q',
    state: QueueState.RUNNING,
    rateLimits: JSON.stringify(DEFAULT_RATE_LIMITS),
    retryConfig: JSON.stringify(DEFAULT_RETRY_CONFIG),
    purgeTime: null,
    taskTtl: DEFAULT_TASK_TTL,
    tombstoneTtl: DEFAULT_TOMBSTONE_TTL,
    stackdriverLoggingConfig: null,
    httpTarget: null,
    ...overrides,
  };
}

function makeTaskData(
  overrides: Partial<Omit<TaskRecord, keyof BaseRecord>> = {}
): Omit<TaskRecord, keyof BaseRecord> {
  return {
    name: 'projects/p/locations/l/queues/q/tasks/t1',
    queueName: 'projects/p/locations/l/queues/q',
    httpRequest: JSON.stringify({
      url: 'https://example.com/handler',
      httpMethod: 'POST',
    }),
    scheduleTime: '2024-01-01T00:00:00Z',
    dispatchDeadline: DEFAULT_DISPATCH_DEADLINE,
    dispatchCount: 0,
    responseCount: 0,
    firstAttempt: null,
    lastAttempt: null,
    status: TaskStatus.PENDING,
    tombstoneExpiry: null,
    ...overrides,
  };
}

describe('CloudTasksService', () => {
  let storage: StorageManager;
  let service: CloudTasksService;
  let queueRepo: QueueRepository;
  let taskRepo: TaskRepository;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    service = new CloudTasksService(storage, new Logger('test', 'error'));
    await service.initialize();

    queueRepo = new QueueRepository(storage);
    await queueRepo.initialize();

    taskRepo = new TaskRepository(storage);
    await taskRepo.initialize();
  });

  afterEach(async () => {
    await service.stop();
  });

  test('deleting a queue should clean up its token bucket and associated tasks', async () => {
    // 1. Create a queue and a task directly via repos (simulating prior state)
    const queue = await queueRepo.createQueue(makeQueueData());

    await taskRepo.createTask(makeTaskData());

    // 2. Verify task exists before deletion
    const taskBefore = await taskRepo.getTaskByName('projects/p/locations/l/queues/q/tasks/t1');

    expect(taskBefore).not.toBeNull();

    // 3. Delete the queue through the service's route handler
    //    We use the internal wiring by getting routes and finding delete
    const routes = service.getRoutes();
    const deleteRoute = routes.find(r => r.id === 'tasks.queues.delete');

    expect(deleteRoute).toBeDefined();

    if (!deleteRoute) return;

    // Build a fake request matching the route pattern
    const fakeRequest = {
      method: 'DELETE',
      path: `/v2/projects/p/locations/l/queues/q`,
      query: {},
      headers: {},
      params: { project: 'p', location: 'l', queueId: 'q' },
      body: undefined,
      originalRequest: new Request('http://localhost/v2/projects/p/locations/l/queues/q', {
        method: 'DELETE',
      }),
    };

    const fakeContext = {
      routeId: deleteRoute.id,
      startTime: Date.now(),
      metadata: {},
      logger: new Logger('test', 'error'),
    };

    const response = await deleteRoute.handler(fakeRequest, fakeContext);

    expect(response.status).toBe(200);

    // 4. Verify the queue is gone
    const deletedQueue = await queueRepo.getQueueByName(queue.name);

    expect(deletedQueue).toBeNull();

    // 5. Verify associated tasks were deleted (via deleteCallback wiring)
    const taskAfter = await taskRepo.getTaskByName('projects/p/locations/l/queues/q/tasks/t1');

    expect(taskAfter).toBeNull();
  });
});
