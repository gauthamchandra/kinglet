/**
 * Tests for QueueRepository
 */

import { test, expect, describe, beforeEach } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { QueueRepository } from './queue-repository.ts';
import {
  QueueState,
  DEFAULT_RATE_LIMITS,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_TASK_TTL,
  DEFAULT_TOMBSTONE_TTL,
} from './types.ts';
import type { QueueRecord } from './types.ts';
import type { BaseRecord } from '@/core/storage/types.ts';

function makeQueueData(
  overrides: Partial<Omit<QueueRecord, keyof BaseRecord>> = {}
): Omit<QueueRecord, keyof BaseRecord> {
  return {
    name: 'projects/test-project/locations/us-central1/queues/test-queue',
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

describe('QueueRepository', () => {
  let storage: StorageManager;
  let repo: QueueRepository;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new QueueRepository(storage);
    await repo.initialize();
  });

  describe('createQueue', () => {
    test('should create a queue and return it with generated id', async () => {
      const data = makeQueueData();
      const queue = await repo.createQueue(data);

      expect(queue.id).toBeTypeOf('string');
      expect(queue.name).toBe(data.name);
      expect(queue.state).toBe('RUNNING');
      expect(queue.createdAt).toBeInstanceOf(Date);
      expect(queue.updatedAt).toBeInstanceOf(Date);
    });

    test('should reject duplicate queue names', async () => {
      const data = makeQueueData();

      await repo.createQueue(data);

      await expect(repo.createQueue(data)).rejects.toThrow();
    });
  });

  describe('getQueueByName', () => {
    test('should find a queue by resource name', async () => {
      const data = makeQueueData();

      await repo.createQueue(data);

      const found = await repo.getQueueByName(data.name);

      expect(found).not.toBeNull();
      expect(found?.name).toBe(data.name);
      expect(found?.state).toBe('RUNNING');
    });

    test('should return null for non-existent queue', async () => {
      const found = await repo.getQueueByName('projects/p/locations/l/queues/nonexistent');

      expect(found).toBeNull();
    });
  });

  describe('listQueues', () => {
    test('should list all queues for a project/location', async () => {
      await repo.createQueue(
        makeQueueData({ name: 'projects/p1/locations/us-central1/queues/queue-a' })
      );
      await repo.createQueue(
        makeQueueData({ name: 'projects/p1/locations/us-central1/queues/queue-b' })
      );
      await repo.createQueue(
        makeQueueData({ name: 'projects/p2/locations/us-central1/queues/queue-c' })
      );

      const result = await repo.listQueues('p1', 'us-central1');

      expect(result.queues.length).toBe(2);
      expect(result.queues.map(q => q.name)).toContain(
        'projects/p1/locations/us-central1/queues/queue-a'
      );
      expect(result.queues.map(q => q.name)).toContain(
        'projects/p1/locations/us-central1/queues/queue-b'
      );
    });

    test('should support pagination with pageSize', async () => {
      await repo.createQueue(makeQueueData({ name: 'projects/p/locations/l/queues/queue-1' }));
      await repo.createQueue(makeQueueData({ name: 'projects/p/locations/l/queues/queue-2' }));
      await repo.createQueue(makeQueueData({ name: 'projects/p/locations/l/queues/queue-3' }));

      const page1 = await repo.listQueues('p', 'l', 2);

      expect(page1.queues.length).toBe(2);
      expect(page1.nextPageToken).toBeTypeOf('string');
    });

    test('should support pagination with pageToken', async () => {
      await repo.createQueue(makeQueueData({ name: 'projects/p/locations/l/queues/queue-1' }));
      await repo.createQueue(makeQueueData({ name: 'projects/p/locations/l/queues/queue-2' }));
      await repo.createQueue(makeQueueData({ name: 'projects/p/locations/l/queues/queue-3' }));

      const page1 = await repo.listQueues('p', 'l', 2);
      const page2 = await repo.listQueues('p', 'l', 2, page1.nextPageToken);

      expect(page2.queues.length).toBe(1);
      expect(page2.nextPageToken).toBeUndefined();
    });

    test('should return empty list for non-existent project', async () => {
      const result = await repo.listQueues('nonexistent', 'us-central1');

      expect(result.queues.length).toBe(0);
    });
  });

  describe('updateQueue', () => {
    test('should update a queue by resource name', async () => {
      const data = makeQueueData();

      await repo.createQueue(data);

      const updated = await repo.updateQueue(data.name, {
        state: QueueState.PAUSED,
      });

      expect(updated).not.toBeNull();
      expect(updated?.state).toBe('PAUSED');
    });

    test('should return null when updating non-existent queue', async () => {
      const updated = await repo.updateQueue('projects/p/locations/l/queues/nonexistent', {
        state: QueueState.PAUSED,
      });

      expect(updated).toBeNull();
    });

    test('should preserve unchanged fields', async () => {
      const data = makeQueueData();

      await repo.createQueue(data);

      const updated = await repo.updateQueue(data.name, {
        state: QueueState.PAUSED,
      });

      expect(updated?.taskTtl).toBe(DEFAULT_TASK_TTL);
      expect(updated?.tombstoneTtl).toBe(DEFAULT_TOMBSTONE_TTL);
    });
  });

  describe('deleteQueue', () => {
    test('should delete a queue by resource name', async () => {
      const data = makeQueueData();

      await repo.createQueue(data);

      const deleted = await repo.deleteQueue(data.name);

      expect(deleted).toBe(true);

      const found = await repo.getQueueByName(data.name);

      expect(found).toBeNull();
    });

    test('should return false for non-existent queue', async () => {
      const deleted = await repo.deleteQueue('projects/p/locations/l/queues/nonexistent');

      expect(deleted).toBe(false);
    });
  });

  describe('findRunningQueues', () => {
    test('should find only RUNNING queues', async () => {
      await repo.createQueue(
        makeQueueData({
          name: 'projects/p/locations/l/queues/running-queue',
          state: QueueState.RUNNING,
        })
      );
      await repo.createQueue(
        makeQueueData({
          name: 'projects/p/locations/l/queues/paused-queue',
          state: QueueState.PAUSED,
        })
      );
      await repo.createQueue(
        makeQueueData({
          name: 'projects/p/locations/l/queues/disabled-queue',
          state: QueueState.DISABLED,
        })
      );

      const running = await repo.findRunningQueues();

      expect(running.length).toBe(1);
      expect(running[0]?.name).toBe('projects/p/locations/l/queues/running-queue');
    });

    test('should return empty array when no running queues', async () => {
      await repo.createQueue(
        makeQueueData({
          name: 'projects/p/locations/l/queues/paused',
          state: QueueState.PAUSED,
        })
      );

      const running = await repo.findRunningQueues();

      expect(running.length).toBe(0);
    });
  });
});
