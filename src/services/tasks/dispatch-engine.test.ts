/**
 * Tests for DispatchEngine
 */

import { test, expect, describe, beforeEach, mock } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { QueueRepository } from './queue-repository.ts';
import { TaskRepository } from './task-repository.ts';
import { DispatchEngine } from './dispatch-engine.ts';
import { Logger } from '@/shared/utils/logger.ts';
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
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from('{"key":"value"}').toString('base64'),
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

describe('DispatchEngine', () => {
  let storage: StorageManager;
  let queueRepo: QueueRepository;
  let taskRepo: TaskRepository;
  let mockHttpClient: ReturnType<typeof mock>;
  let engine: DispatchEngine;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    queueRepo = new QueueRepository(storage);
    await queueRepo.initialize();

    taskRepo = new TaskRepository(storage);
    await taskRepo.initialize();

    mockHttpClient = mock(() => Promise.resolve(new Response('OK', { status: 200 })));

    engine = new DispatchEngine(queueRepo, taskRepo, new Logger('Test'), mockHttpClient);
  });

  describe('tick', () => {
    test('should dispatch pending tasks from running queues', async () => {
      await queueRepo.createQueue(makeQueueData());
      await taskRepo.createTask(makeTaskData());

      await engine.tick();

      expect(mockHttpClient).toHaveBeenCalled();

      const task = await taskRepo.getTaskByName('projects/p/locations/l/queues/q/tasks/t1');

      expect(task?.status).toBe(TaskStatus.TOMBSTONE);
    });

    test('should skip paused queues', async () => {
      await queueRepo.createQueue(makeQueueData({ state: QueueState.PAUSED }));
      await taskRepo.createTask(makeTaskData());

      await engine.tick();

      expect(mockHttpClient).not.toHaveBeenCalled();
    });

    test('should skip tasks with future scheduleTime', async () => {
      await queueRepo.createQueue(makeQueueData());
      await taskRepo.createTask(makeTaskData({ scheduleTime: '2099-12-31T23:59:59Z' }));

      await engine.tick();

      expect(mockHttpClient).not.toHaveBeenCalled();
    });

    test('should not dispatch when no tasks are pending', async () => {
      await queueRepo.createQueue(makeQueueData());

      await engine.tick();

      expect(mockHttpClient).not.toHaveBeenCalled();
    });
  });

  describe('dispatchTask', () => {
    test('should tombstone task on successful dispatch', async () => {
      const queue = await queueRepo.createQueue(makeQueueData());
      const task = await taskRepo.createTask(makeTaskData());

      await engine.dispatchTask(task, queue);

      expect(mockHttpClient).toHaveBeenCalledTimes(1);

      const result = await taskRepo.getTaskByName(task.name);

      expect(result).not.toBeNull();
      expect(result?.status).toBe(TaskStatus.TOMBSTONE);
      expect(result?.tombstoneExpiry).not.toBeNull();
      expect(result?.responseCount).toBe(1);
    });

    test('should use correct HTTP method and URL', async () => {
      const queue = await queueRepo.createQueue(makeQueueData());
      const task = await taskRepo.createTask(makeTaskData());

      await engine.dispatchTask(task, queue);

      const [url, init] = mockHttpClient.mock.calls[0] as [string, RequestInit];

      expect(url).toBe('https://example.com/handler');
      expect(init.method).toBe('POST');
    });

    test('should pass AbortSignal in request init', async () => {
      const queue = await queueRepo.createQueue(makeQueueData());
      const task = await taskRepo.createTask(makeTaskData());

      await engine.dispatchTask(task, queue);

      const [, init] = mockHttpClient.mock.calls[0] as [string, RequestInit];

      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    test('should handle dispatch failure and retry with responseCount', async () => {
      mockHttpClient = mock(() => Promise.resolve(new Response('Error', { status: 500 })));

      engine = new DispatchEngine(queueRepo, taskRepo, new Logger('Test'), mockHttpClient);

      const retryConfig = { ...DEFAULT_RETRY_CONFIG, maxAttempts: 3 };
      const queue = await queueRepo.createQueue(
        makeQueueData({ retryConfig: JSON.stringify(retryConfig) })
      );
      const task = await taskRepo.createTask(makeTaskData());

      await engine.dispatchTask(task, queue);

      const updated = await taskRepo.getTaskByName(task.name);

      expect(updated).not.toBeNull();
      expect(updated?.status).toBe(TaskStatus.PENDING);
      expect(updated?.dispatchCount).toBe(1);
      expect(updated?.responseCount).toBe(1);
      expect(updated?.lastAttempt).not.toBeNull();
    });

    test('should mark as FAILED when maxAttempts exhausted', async () => {
      mockHttpClient = mock(() => Promise.resolve(new Response('Error', { status: 500 })));

      engine = new DispatchEngine(queueRepo, taskRepo, new Logger('Test'), mockHttpClient);

      const retryConfig = { ...DEFAULT_RETRY_CONFIG, maxAttempts: 1 };
      const queue = await queueRepo.createQueue(
        makeQueueData({ retryConfig: JSON.stringify(retryConfig) })
      );
      const task = await taskRepo.createTask(makeTaskData());

      await engine.dispatchTask(task, queue);

      const updated = await taskRepo.getTaskByName(task.name);

      expect(updated?.status).toBe(TaskStatus.FAILED);
      expect(updated?.responseCount).toBe(1);
    });

    test('should update firstAttempt on first dispatch', async () => {
      mockHttpClient = mock(() => Promise.resolve(new Response('Error', { status: 500 })));

      engine = new DispatchEngine(queueRepo, taskRepo, new Logger('Test'), mockHttpClient);

      const retryConfig = { ...DEFAULT_RETRY_CONFIG, maxAttempts: 5 };
      const queueWithRetries = await queueRepo.createQueue(
        makeQueueData({
          name: 'projects/p/locations/l/queues/q2',
          retryConfig: JSON.stringify(retryConfig),
        })
      );
      const task2 = await taskRepo.createTask(
        makeTaskData({
          name: 'projects/p/locations/l/queues/q2/tasks/t2',
          queueName: 'projects/p/locations/l/queues/q2',
        })
      );

      await engine.dispatchTask(task2, queueWithRetries);

      const updated = await taskRepo.getTaskByName(task2.name);

      expect(updated?.firstAttempt).not.toBeNull();
    });

    test('should handle network errors gracefully', async () => {
      mockHttpClient = mock(() => Promise.reject(new Error('Network error')));

      engine = new DispatchEngine(queueRepo, taskRepo, new Logger('Test'), mockHttpClient);

      const retryConfig = { ...DEFAULT_RETRY_CONFIG, maxAttempts: 1 };
      const queue = await queueRepo.createQueue(
        makeQueueData({ retryConfig: JSON.stringify(retryConfig) })
      );
      const task = await taskRepo.createTask(makeTaskData());

      await engine.dispatchTask(task, queue);

      const updated = await taskRepo.getTaskByName(task.name);

      expect(updated?.status).toBe(TaskStatus.FAILED);
    });

    test('should handle abort timeout as failure', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');

      mockHttpClient = mock(() => Promise.reject(abortError));

      engine = new DispatchEngine(queueRepo, taskRepo, new Logger('Test'), mockHttpClient);

      const retryConfig = { ...DEFAULT_RETRY_CONFIG, maxAttempts: 1 };
      const queue = await queueRepo.createQueue(
        makeQueueData({ retryConfig: JSON.stringify(retryConfig) })
      );
      const task = await taskRepo.createTask(makeTaskData());

      await engine.dispatchTask(task, queue);

      const updated = await taskRepo.getTaskByName(task.name);

      expect(updated?.status).toBe(TaskStatus.FAILED);
      expect(updated?.responseCount).toBe(1);
    });
  });

  describe('start/stop lifecycle', () => {
    test('should start and stop without errors', async () => {
      engine.start(10000);
      await engine.stop();
    });

    test('should not start twice', () => {
      engine.start(10000);
      engine.start(10000);

      void engine.stop();
    });
  });

  describe('cleanupBucket', () => {
    test('should remove bucket for deleted queue', async () => {
      const queue = await queueRepo.createQueue(makeQueueData());

      await taskRepo.createTask(makeTaskData());

      await engine.tick();

      expect(mockHttpClient).toHaveBeenCalled();

      engine.cleanupBucket(queue.name);

      // Create new queue+task with same name to verify bucket is recreated fresh
      mockHttpClient.mockReset();
      mockHttpClient.mockImplementation(() => Promise.resolve(new Response('OK', { status: 200 })));

      await queueRepo.createQueue(makeQueueData({ name: 'projects/p/locations/l/queues/q-new' }));
      await taskRepo.createTask(
        makeTaskData({
          name: 'projects/p/locations/l/queues/q-new/tasks/t2',
          queueName: 'projects/p/locations/l/queues/q-new',
        })
      );

      await engine.tick();

      expect(mockHttpClient).toHaveBeenCalled();
    });
  });

  describe('retry backoff', () => {
    test('should compute exponential backoff with maxDoublings cap', () => {
      const minBackoff = 0.1;
      const maxBackoff = 3600;
      const maxDoublings = 3;

      expect(engine.computeBackoffSeconds(0, minBackoff, maxBackoff, maxDoublings)).toBe(0.1);
      expect(engine.computeBackoffSeconds(1, minBackoff, maxBackoff, maxDoublings)).toBe(0.2);
      expect(engine.computeBackoffSeconds(2, minBackoff, maxBackoff, maxDoublings)).toBe(0.4);
      expect(engine.computeBackoffSeconds(3, minBackoff, maxBackoff, maxDoublings)).toBe(0.8);
      expect(engine.computeBackoffSeconds(4, minBackoff, maxBackoff, maxDoublings)).toBe(0.8);
    });

    test('should cap at maxBackoff', () => {
      const minBackoff = 100;
      const maxBackoff = 200;
      const maxDoublings = 16;

      expect(engine.computeBackoffSeconds(2, minBackoff, maxBackoff, maxDoublings)).toBe(200);
    });
  });
});
