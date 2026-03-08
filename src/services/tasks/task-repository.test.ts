/**
 * Tests for TaskRepository
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { TaskRepository } from './task-repository.ts';
import type { TaskRecord } from './types.ts';
import { DEFAULT_DISPATCH_DEADLINE, TaskStatus } from './types.ts';

function makeTaskData(
  overrides: Partial<Omit<TaskRecord, keyof BaseRecord>> = {}
): Omit<TaskRecord, keyof BaseRecord> {
  return {
    name: 'projects/p/locations/l/queues/q/tasks/test-task',
    queueName: 'projects/p/locations/l/queues/q',
    httpRequest: JSON.stringify({ url: 'https://example.com', httpMethod: 'POST' }),
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

describe('TaskRepository', () => {
  let storage: StorageManager;
  let repo: TaskRepository;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new TaskRepository(storage);
    await repo.initialize();
  });

  describe('createTask', () => {
    test('should create a task and return it with generated id', async () => {
      const data = makeTaskData();
      const task = await repo.createTask(data);

      expect(task.id).toBeTypeOf('string');
      expect(task.name).toBe(data.name);
      expect(task.status).toBe('PENDING');
      expect(task.createdAt).toBeInstanceOf(Date);
    });

    test('should reject duplicate task names', async () => {
      const data = makeTaskData();

      await repo.createTask(data);

      await expect(repo.createTask(data)).rejects.toThrow();
    });
  });

  describe('getTaskByName', () => {
    test('should find a task by resource name', async () => {
      const data = makeTaskData();

      await repo.createTask(data);

      const found = await repo.getTaskByName(data.name);

      expect(found).not.toBeNull();
      expect(found?.name).toBe(data.name);
    });

    test('should return null for non-existent task', async () => {
      const found = await repo.getTaskByName('projects/p/locations/l/queues/q/tasks/nonexistent');

      expect(found).toBeNull();
    });
  });

  describe('listTasks', () => {
    test('should list tasks for a queue', async () => {
      await repo.createTask(makeTaskData({ name: 'projects/p/locations/l/queues/q/tasks/t1' }));
      await repo.createTask(makeTaskData({ name: 'projects/p/locations/l/queues/q/tasks/t2' }));
      await repo.createTask(
        makeTaskData({
          name: 'projects/p/locations/l/queues/other/tasks/t3',
          queueName: 'projects/p/locations/l/queues/other',
        })
      );

      const result = await repo.listTasks('projects/p/locations/l/queues/q');

      expect(result.tasks.length).toBe(2);
    });

    test('should exclude tombstone tasks', async () => {
      await repo.createTask(makeTaskData({ name: 'projects/p/locations/l/queues/q/tasks/active' }));
      await repo.createTask(
        makeTaskData({
          name: 'projects/p/locations/l/queues/q/tasks/tombstone',
          status: TaskStatus.TOMBSTONE,
        })
      );

      const result = await repo.listTasks('projects/p/locations/l/queues/q');

      expect(result.tasks.length).toBe(1);
      expect(result.tasks[0]?.name).toBe('projects/p/locations/l/queues/q/tasks/active');
    });

    test('should support pagination', async () => {
      await repo.createTask(makeTaskData({ name: 'projects/p/locations/l/queues/q/tasks/t1' }));
      await repo.createTask(makeTaskData({ name: 'projects/p/locations/l/queues/q/tasks/t2' }));
      await repo.createTask(makeTaskData({ name: 'projects/p/locations/l/queues/q/tasks/t3' }));

      const page1 = await repo.listTasks('projects/p/locations/l/queues/q', 2);

      expect(page1.tasks.length).toBe(2);
      expect(page1.nextPageToken).toBeTypeOf('string');

      const page2 = await repo.listTasks('projects/p/locations/l/queues/q', 2, page1.nextPageToken);

      expect(page2.tasks.length).toBe(1);
      expect(page2.nextPageToken).toBeUndefined();
    });
  });

  describe('deleteTask', () => {
    test('should delete a task', async () => {
      const data = makeTaskData();

      await repo.createTask(data);

      const deleted = await repo.deleteTask(data.name);

      expect(deleted).toBe(true);

      const found = await repo.getTaskByName(data.name);

      expect(found).toBeNull();
    });

    test('should return false for non-existent task', async () => {
      const deleted = await repo.deleteTask('projects/p/locations/l/queues/q/tasks/nonexistent');

      expect(deleted).toBe(false);
    });
  });

  describe('deleteTasksByQueue', () => {
    test('should delete all tasks in a queue', async () => {
      await repo.createTask(makeTaskData({ name: 'projects/p/locations/l/queues/q/tasks/t1' }));
      await repo.createTask(makeTaskData({ name: 'projects/p/locations/l/queues/q/tasks/t2' }));

      const count = await repo.deleteTasksByQueue('projects/p/locations/l/queues/q');

      expect(count).toBe(2);

      const result = await repo.listTasks('projects/p/locations/l/queues/q');

      expect(result.tasks.length).toBe(0);
    });

    test('should not affect tasks in other queues', async () => {
      await repo.createTask(
        makeTaskData({
          name: 'projects/p/locations/l/queues/q1/tasks/t1',
          queueName: 'projects/p/locations/l/queues/q1',
        })
      );
      await repo.createTask(
        makeTaskData({
          name: 'projects/p/locations/l/queues/q2/tasks/t2',
          queueName: 'projects/p/locations/l/queues/q2',
        })
      );

      await repo.deleteTasksByQueue('projects/p/locations/l/queues/q1');

      const result = await repo.listTasks('projects/p/locations/l/queues/q2');

      expect(result.tasks.length).toBe(1);
    });
  });

  describe('findDispatchableTasks', () => {
    test('should find PENDING tasks with scheduleTime <= now', async () => {
      await repo.createTask(
        makeTaskData({
          name: 'projects/p/locations/l/queues/q/tasks/ready',
          scheduleTime: '2024-01-01T00:00:00Z',
          status: TaskStatus.PENDING,
        })
      );
      await repo.createTask(
        makeTaskData({
          name: 'projects/p/locations/l/queues/q/tasks/future',
          scheduleTime: '2099-12-31T23:59:59Z',
          status: TaskStatus.PENDING,
        })
      );
      await repo.createTask(
        makeTaskData({
          name: 'projects/p/locations/l/queues/q/tasks/dispatching',
          scheduleTime: '2024-01-01T00:00:00Z',
          status: TaskStatus.DISPATCHING,
        })
      );

      const tasks = await repo.findDispatchableTasks('projects/p/locations/l/queues/q', 10);

      expect(tasks.length).toBe(1);
      expect(tasks[0]?.name).toBe('projects/p/locations/l/queues/q/tasks/ready');
    });

    test('should respect limit', async () => {
      await repo.createTask(
        makeTaskData({
          name: 'projects/p/locations/l/queues/q/tasks/t1',
          scheduleTime: '2024-01-01T00:00:00Z',
        })
      );
      await repo.createTask(
        makeTaskData({
          name: 'projects/p/locations/l/queues/q/tasks/t2',
          scheduleTime: '2024-01-01T00:00:01Z',
        })
      );

      const tasks = await repo.findDispatchableTasks('projects/p/locations/l/queues/q', 1);

      expect(tasks.length).toBe(1);
    });
  });

  describe('updateTask', () => {
    test('should update task fields', async () => {
      const data = makeTaskData();

      await repo.createTask(data);

      const updated = await repo.updateTask(data.name, {
        status: TaskStatus.DISPATCHING,
        dispatchCount: 1,
      });

      expect(updated).not.toBeNull();
      expect(updated?.status).toBe('DISPATCHING');
      expect(updated?.dispatchCount).toBe(1);
    });

    test('should return null for non-existent task', async () => {
      const updated = await repo.updateTask('projects/p/locations/l/queues/q/tasks/nonexistent', {
        status: TaskStatus.FAILED,
      });

      expect(updated).toBeNull();
    });
  });

  describe('findTombstone', () => {
    test('should find active tombstone by name', async () => {
      const futureExpiry = new Date(Date.now() + 3600000).toISOString();

      await repo.createTask(
        makeTaskData({
          name: 'projects/p/locations/l/queues/q/tasks/dead',
          status: TaskStatus.TOMBSTONE,
          tombstoneExpiry: futureExpiry,
        })
      );

      const tombstone = await repo.findTombstone('projects/p/locations/l/queues/q/tasks/dead');

      expect(tombstone).not.toBeNull();
      expect(tombstone?.status).toBe('TOMBSTONE');
    });

    test('should return null for non-tombstone task', async () => {
      await repo.createTask(makeTaskData({ name: 'projects/p/locations/l/queues/q/tasks/alive' }));

      const tombstone = await repo.findTombstone('projects/p/locations/l/queues/q/tasks/alive');

      expect(tombstone).toBeNull();
    });
  });

  describe('cleanupExpiredTombstones', () => {
    test('should delete expired tombstones', async () => {
      const pastExpiry = new Date(Date.now() - 3600000).toISOString();
      const futureExpiry = new Date(Date.now() + 3600000).toISOString();

      await repo.createTask(
        makeTaskData({
          name: 'projects/p/locations/l/queues/q/tasks/expired',
          status: TaskStatus.TOMBSTONE,
          tombstoneExpiry: pastExpiry,
        })
      );
      await repo.createTask(
        makeTaskData({
          name: 'projects/p/locations/l/queues/q/tasks/active-tombstone',
          status: TaskStatus.TOMBSTONE,
          tombstoneExpiry: futureExpiry,
        })
      );

      const count = await repo.cleanupExpiredTombstones();

      expect(count).toBe(1);

      const expired = await repo.getTaskByName('projects/p/locations/l/queues/q/tasks/expired');

      expect(expired).toBeNull();

      const active = await repo.getTaskByName(
        'projects/p/locations/l/queues/q/tasks/active-tombstone'
      );

      expect(active).not.toBeNull();
    });
  });
});
