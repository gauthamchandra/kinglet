/**
 * Tests for QueueService
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { QueueRepository } from './queue-repository.ts';
import { QueueService, TasksError } from './queue-service.ts';
import { DEFAULT_RATE_LIMITS, DEFAULT_RETRY_CONFIG } from './types.ts';

describe('QueueService', () => {
  let storage: StorageManager;
  let repo: QueueRepository;
  let service: QueueService;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new QueueRepository(storage);
    await repo.initialize();
    service = new QueueService(repo);
  });

  describe('TasksError', () => {
    test('should have a code and message', () => {
      const err = new TasksError('NOT_FOUND', 'Queue not found');

      expect(err.code).toBe('NOT_FOUND');
      expect(err.message).toBe('Queue not found');
      expect(err.name).toBe('TasksError');
    });
  });

  describe('createQueue', () => {
    test('should create a queue with defaults', async () => {
      const result = await service.createQueue('my-project', 'us-central1', 'my-queue', {});

      expect(result.name).toBe('projects/my-project/locations/us-central1/queues/my-queue');
      expect(result.state).toBe('RUNNING');
      expect(result.rateLimits).toEqual(DEFAULT_RATE_LIMITS);
      expect(result.retryConfig).toEqual(DEFAULT_RETRY_CONFIG);
    });

    test('should create a queue with custom rate limits', async () => {
      const result = await service.createQueue('p', 'l', 'q', {
        rateLimits: {
          maxDispatchesPerSecond: 200,
          maxBurstSize: 50,
          maxConcurrentDispatches: 500,
        },
      });

      expect(result.rateLimits.maxDispatchesPerSecond).toBe(200);
      expect(result.rateLimits.maxBurstSize).toBe(50);
    });

    test('should throw ALREADY_EXISTS for duplicate queue', async () => {
      await service.createQueue('p', 'l', 'q', {});

      const promise = service.createQueue('p', 'l', 'q', {});

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
    });

    test('should throw INVALID_ARGUMENT for invalid body', async () => {
      const promise = service.createQueue('p', 'l', 'q', {
        rateLimits: { maxDispatchesPerSecond: 0.001 },
      });

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
    });
  });

  describe('getQueue', () => {
    test('should return a queue by name', async () => {
      await service.createQueue('p', 'l', 'q', {});

      const result = await service.getQueue('projects/p/locations/l/queues/q');

      expect(result.name).toBe('projects/p/locations/l/queues/q');
      expect(result.state).toBe('RUNNING');
    });

    test('should throw NOT_FOUND for missing queue', async () => {
      const promise = service.getQueue('projects/p/locations/l/queues/nonexistent');

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });
  });

  describe('listQueues', () => {
    test('should list queues for a project/location', async () => {
      await service.createQueue('p', 'l', 'q1', {});
      await service.createQueue('p', 'l', 'q2', {});

      const result = await service.listQueues('p', 'l');

      expect(result.queues.length).toBe(2);
    });

    test('should support pagination', async () => {
      await service.createQueue('p', 'l', 'q1', {});
      await service.createQueue('p', 'l', 'q2', {});
      await service.createQueue('p', 'l', 'q3', {});

      const page1 = await service.listQueues('p', 'l', 2);

      expect(page1.queues.length).toBe(2);
      expect(page1.nextPageToken).toBeTypeOf('string');
    });
  });

  describe('updateQueue', () => {
    test('should update queue fields', async () => {
      await service.createQueue('p', 'l', 'q', {});

      const result = await service.updateQueue('projects/p/locations/l/queues/q', {
        rateLimits: {
          maxDispatchesPerSecond: 300,
          maxBurstSize: 75,
          maxConcurrentDispatches: 1500,
        },
      });

      expect(result.rateLimits.maxDispatchesPerSecond).toBe(300);
    });

    test('should throw NOT_FOUND for missing queue', async () => {
      const promise = service.updateQueue('projects/p/locations/l/queues/nonexistent', {});

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });

    test('should throw INVALID_ARGUMENT for invalid body', async () => {
      await service.createQueue('p', 'l', 'q', {});

      const promise = service.updateQueue('projects/p/locations/l/queues/q', {
        rateLimits: { maxDispatchesPerSecond: 0.001 },
      });

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
    });
  });

  describe('deleteQueue', () => {
    test('should delete a queue', async () => {
      await service.createQueue('p', 'l', 'q', {});
      await service.deleteQueue('projects/p/locations/l/queues/q');

      const promise = service.getQueue('projects/p/locations/l/queues/q');

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });

    test('should call delete callback when set', async () => {
      const deleteCallback = mock(() => Promise.resolve());

      service.setDeleteCallback(deleteCallback);
      await service.createQueue('p', 'l', 'q', {});
      await service.deleteQueue('projects/p/locations/l/queues/q');

      expect(deleteCallback).toHaveBeenCalledWith('projects/p/locations/l/queues/q');
    });

    test('should throw NOT_FOUND for missing queue', async () => {
      const promise = service.deleteQueue('projects/p/locations/l/queues/nonexistent');

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });
  });

  describe('pauseQueue', () => {
    test('should pause a RUNNING queue', async () => {
      await service.createQueue('p', 'l', 'q', {});

      const result = await service.pauseQueue('projects/p/locations/l/queues/q');

      expect(result.state).toBe('PAUSED');
    });

    test('should throw FAILED_PRECONDITION for already paused queue', async () => {
      await service.createQueue('p', 'l', 'q', {});
      await service.pauseQueue('projects/p/locations/l/queues/q');

      const promise = service.pauseQueue('projects/p/locations/l/queues/q');

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
    });

    test('should throw NOT_FOUND for missing queue', async () => {
      const promise = service.pauseQueue('projects/p/locations/l/queues/nonexistent');

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });
  });

  describe('resumeQueue', () => {
    test('should resume a PAUSED queue', async () => {
      await service.createQueue('p', 'l', 'q', {});
      await service.pauseQueue('projects/p/locations/l/queues/q');

      const result = await service.resumeQueue('projects/p/locations/l/queues/q');

      expect(result.state).toBe('RUNNING');
    });

    test('should throw FAILED_PRECONDITION for non-paused queue', async () => {
      await service.createQueue('p', 'l', 'q', {});

      const promise = service.resumeQueue('projects/p/locations/l/queues/q');

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
    });

    test('should throw NOT_FOUND for missing queue', async () => {
      const promise = service.resumeQueue('projects/p/locations/l/queues/nonexistent');

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });
  });

  describe('purgeQueue', () => {
    test('should set purgeTime and call purge callback', async () => {
      const purgeCallback = mock(() => Promise.resolve());

      service.setPurgeCallback(purgeCallback);
      await service.createQueue('p', 'l', 'q', {});

      const result = await service.purgeQueue('projects/p/locations/l/queues/q');

      expect(result.purgeTime).toBeTypeOf('string');
      expect(purgeCallback).toHaveBeenCalledWith('projects/p/locations/l/queues/q');
    });

    test('should throw NOT_FOUND for missing queue', async () => {
      const promise = service.purgeQueue('projects/p/locations/l/queues/nonexistent');

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });
  });
});
