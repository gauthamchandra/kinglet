/**
 * Tests for TaskService
 */

import { test, expect, describe, beforeEach, mock } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { QueueRepository } from './queue-repository.ts';
import { TaskRepository } from './task-repository.ts';
import { QueueService, TasksError } from './queue-service.ts';
import { TaskService } from './task-service.ts';

describe('TaskService', () => {
  let storage: StorageManager;
  let queueRepo: QueueRepository;
  let taskRepo: TaskRepository;
  let queueService: QueueService;
  let service: TaskService;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    queueRepo = new QueueRepository(storage);
    await queueRepo.initialize();

    taskRepo = new TaskRepository(storage);
    await taskRepo.initialize();

    queueService = new QueueService(queueRepo);
    service = new TaskService(taskRepo, queueRepo);

    await queueService.createQueue('p', 'l', 'q', {});
  });

  describe('createTask', () => {
    test('should create a task with auto-generated ID', async () => {
      const result = await service.createTask('p', 'l', 'q', {
        task: {
          httpRequest: {
            url: 'https://example.com/handler',
            httpMethod: 'POST',
          },
        },
      });

      expect(result.name).toMatch(/^projects\/p\/locations\/l\/queues\/q\/tasks\//);
      expect(result.httpRequest?.url).toBe('https://example.com/handler');
      expect(result.httpRequest?.httpMethod).toBe('POST');
      expect(result.scheduleTime).toBeTypeOf('string');
      expect(result.dispatchCount).toBe(0);
    });

    test('should create a task with custom ID', async () => {
      const result = await service.createTask('p', 'l', 'q', {
        task: {
          name: 'projects/p/locations/l/queues/q/tasks/custom-id',
          httpRequest: {
            url: 'https://example.com',
            httpMethod: 'GET',
          },
        },
      });

      expect(result.name).toBe('projects/p/locations/l/queues/q/tasks/custom-id');
    });

    test('should create a task with provided scheduleTime', async () => {
      const result = await service.createTask('p', 'l', 'q', {
        task: {
          httpRequest: {
            url: 'https://example.com',
            httpMethod: 'POST',
          },
          scheduleTime: '2025-06-01T00:00:00Z',
        },
      });

      expect(result.scheduleTime).toBe('2025-06-01T00:00:00Z');
    });

    test('should return BASIC view when requested', async () => {
      const result = await service.createTask('p', 'l', 'q', {
        task: {
          httpRequest: {
            url: 'https://example.com',
            httpMethod: 'POST',
            body: Buffer.from('data').toString('base64'),
          },
        },
        responseView: 'BASIC',
      });

      expect(result.httpRequest?.body).toBeUndefined();
    });

    test('should throw NOT_FOUND for non-existent queue', async () => {
      const promise = service.createTask('p', 'l', 'nonexistent', {
        task: {
          httpRequest: {
            url: 'https://example.com',
            httpMethod: 'POST',
          },
        },
      });

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });

    test('should throw ALREADY_EXISTS for duplicate task name', async () => {
      await service.createTask('p', 'l', 'q', {
        task: {
          name: 'projects/p/locations/l/queues/q/tasks/unique',
          httpRequest: {
            url: 'https://example.com',
            httpMethod: 'POST',
          },
        },
      });

      const promise = service.createTask('p', 'l', 'q', {
        task: {
          name: 'projects/p/locations/l/queues/q/tasks/unique',
          httpRequest: {
            url: 'https://example.com',
            httpMethod: 'POST',
          },
        },
      });

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
    });

    test('should throw ALREADY_EXISTS when tombstone dedup match exists', async () => {
      await service.createTask('p', 'l', 'q', {
        task: {
          name: 'projects/p/locations/l/queues/q/tasks/dedup-test',
          httpRequest: {
            url: 'https://example.com',
            httpMethod: 'POST',
          },
        },
      });

      await service.deleteTask('projects/p/locations/l/queues/q/tasks/dedup-test');

      const promise = service.createTask('p', 'l', 'q', {
        task: {
          name: 'projects/p/locations/l/queues/q/tasks/dedup-test',
          httpRequest: {
            url: 'https://example.com',
            httpMethod: 'POST',
          },
        },
      });

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
    });

    test('should throw INVALID_ARGUMENT for invalid body', async () => {
      const promise = service.createTask('p', 'l', 'q', { task: {} });

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
    });

    test('should throw FAILED_PRECONDITION for DISABLED queue', async () => {
      await queueRepo.updateQueue('projects/p/locations/l/queues/q', {
        state: 'DISABLED',
      });

      const promise = service.createTask('p', 'l', 'q', {
        task: {
          httpRequest: {
            url: 'https://example.com',
            httpMethod: 'POST',
          },
        },
      });

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
    });
  });

  describe('getTask', () => {
    test('should return a task by name', async () => {
      await service.createTask('p', 'l', 'q', {
        task: {
          name: 'projects/p/locations/l/queues/q/tasks/t1',
          httpRequest: {
            url: 'https://example.com',
            httpMethod: 'GET',
          },
        },
      });

      const result = await service.getTask('projects/p/locations/l/queues/q/tasks/t1');

      expect(result.name).toBe('projects/p/locations/l/queues/q/tasks/t1');
    });

    test('should respect responseView', async () => {
      await service.createTask('p', 'l', 'q', {
        task: {
          name: 'projects/p/locations/l/queues/q/tasks/t1',
          httpRequest: {
            url: 'https://example.com',
            httpMethod: 'POST',
            body: Buffer.from('data').toString('base64'),
          },
        },
      });

      const basic = await service.getTask('projects/p/locations/l/queues/q/tasks/t1', 'BASIC');

      expect(basic.httpRequest?.body).toBeUndefined();

      const full = await service.getTask('projects/p/locations/l/queues/q/tasks/t1', 'FULL');

      expect(full.httpRequest?.body).toBeTypeOf('string');
    });

    test('should throw NOT_FOUND for missing task', async () => {
      const promise = service.getTask('projects/p/locations/l/queues/q/tasks/nonexistent');

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });
  });

  describe('listTasks', () => {
    test('should list tasks for a queue', async () => {
      await service.createTask('p', 'l', 'q', {
        task: {
          name: 'projects/p/locations/l/queues/q/tasks/t1',
          httpRequest: { url: 'https://example.com', httpMethod: 'POST' },
        },
      });
      await service.createTask('p', 'l', 'q', {
        task: {
          name: 'projects/p/locations/l/queues/q/tasks/t2',
          httpRequest: { url: 'https://example.com', httpMethod: 'POST' },
        },
      });

      const result = await service.listTasks('projects/p/locations/l/queues/q');

      expect(result.tasks.length).toBe(2);
    });
  });

  describe('deleteTask', () => {
    test('should mark task as tombstone', async () => {
      await service.createTask('p', 'l', 'q', {
        task: {
          name: 'projects/p/locations/l/queues/q/tasks/to-delete',
          httpRequest: { url: 'https://example.com', httpMethod: 'POST' },
        },
      });

      await service.deleteTask('projects/p/locations/l/queues/q/tasks/to-delete');

      const listed = await service.listTasks('projects/p/locations/l/queues/q');

      expect(listed.tasks.length).toBe(0);

      const tombstone = await taskRepo.findTombstone(
        'projects/p/locations/l/queues/q/tasks/to-delete'
      );

      expect(tombstone).not.toBeNull();
      expect(tombstone?.status).toBe('TOMBSTONE');
      expect(tombstone?.tombstoneExpiry).toBeTypeOf('string');
    });

    test('should throw NOT_FOUND for missing task', async () => {
      const promise = service.deleteTask('projects/p/locations/l/queues/q/tasks/nonexistent');

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });
  });

  describe('runTask', () => {
    test('should call dispatch callback', async () => {
      const dispatchCallback = mock(() => Promise.resolve());

      service.setDispatchCallback(dispatchCallback);

      await service.createTask('p', 'l', 'q', {
        task: {
          name: 'projects/p/locations/l/queues/q/tasks/run-me',
          httpRequest: { url: 'https://example.com', httpMethod: 'POST' },
        },
      });

      const result = await service.runTask('projects/p/locations/l/queues/q/tasks/run-me');

      expect(result.name).toBe('projects/p/locations/l/queues/q/tasks/run-me');
      expect(dispatchCallback).toHaveBeenCalled();
    });

    test('should throw NOT_FOUND for missing task', async () => {
      const promise = service.runTask('projects/p/locations/l/queues/q/tasks/nonexistent');

      await expect(promise).rejects.toBeInstanceOf(TasksError);
      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });
  });
});
