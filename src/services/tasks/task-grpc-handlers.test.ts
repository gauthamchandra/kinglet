/**
 * Unit tests for Cloud Tasks gRPC handlers
 *
 * Covers the gRPC callback layer: correct delegation to services and
 * correct gRPC status codes on error paths.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as grpc from '@grpc/grpc-js';
import type { QueueService } from './queue-service.ts';
import { TasksError } from './queue-service.ts';
import { CloudTasksGrpcHandlers } from './task-grpc-handlers.ts';
import type { TaskService } from './task-service.ts';

// ── Minimal mock factories ──

function makeQueueService(): QueueService {
  return {
    createQueue: mock(),
    getQueue: mock(),
    listQueues: mock(),
    updateQueue: mock(),
    deleteQueue: mock(),
    purgeQueue: mock(),
    pauseQueue: mock(),
    resumeQueue: mock(),
    setPurgeCallback: mock(),
    setDeleteCallback: mock(),
  } as unknown as QueueService;
}

function makeTaskService(): TaskService {
  return {
    createTask: mock(),
    getTask: mock(),
    listTasks: mock(),
    deleteTask: mock(),
    runTask: mock(),
    bufferTask: mock(),
    setDispatchCallback: mock(),
  } as unknown as TaskService;
}

function makeCallback<T>(): (err: grpc.ServiceError | null, response?: T) => void {
  return mock();
}

function makeCall<T>(request: T): grpc.ServerUnaryCall<T, unknown> {
  return {
    request,
    metadata: new grpc.Metadata(),
  } as grpc.ServerUnaryCall<T, unknown>;
}

type MockCalls<T extends unknown[]> = { mock: { calls: T[] } };

function firstCallArg0<T>(cb: unknown): T {
  const calls = (cb as MockCalls<[T]>).mock.calls;

  expect(calls.length).toBeGreaterThan(0);

  return (calls[0] as [T])[0];
}

// ── Tests ──

describe('CloudTasksGrpcHandlers', () => {
  let queueService: QueueService;
  let taskService: TaskService;
  let handlers: CloudTasksGrpcHandlers;

  beforeEach(() => {
    queueService = makeQueueService();
    taskService = makeTaskService();
    handlers = new CloudTasksGrpcHandlers(queueService, taskService);
  });

  describe('CreateTask', () => {
    test('delegates to taskService and returns proto-shaped task', async () => {
      const fakeTask = {
        name: 'projects/p/locations/l/queues/q/tasks/t1',
        scheduleTime: '2026-01-01T00:00:00.000Z',
        createTime: '2026-01-01T00:00:00.000Z',
        dispatchDeadline: '600s',
        dispatchCount: 0,
        responseCount: 0,
        view: 'FULL',
        httpRequest: {
          url: 'http://localhost/callback',
          httpMethod: 'POST',
        },
      };

      (taskService.createTask as ReturnType<typeof mock>).mockResolvedValue(fakeTask);

      const request = {
        parent: 'projects/p/locations/l/queues/q',
        task: {
          payloadType: 'httpRequest',
          httpRequest: { url: 'http://localhost/callback', httpMethod: 'POST' },
        },
      };

      const call = makeCall(request);
      const callback = makeCallback();

      await handlers.createTask(call, callback as Parameters<typeof handlers.createTask>[1]);

      expect(taskService.createTask).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledTimes(1);

      const callErr = firstCallArg0<null>(callback);
      const calls = (callback as unknown as MockCalls<[null, { name: string }]>).mock.calls;
      const callResult = calls[0]?.[1];

      expect(callErr).toBeNull();
      expect(callResult?.name).toBe(fakeTask.name);
    });
  });

  describe('GetQueue', () => {
    test('returns NOT_FOUND gRPC status for unknown queue (not a generic Error, not string-matched)', async () => {
      (queueService.getQueue as ReturnType<typeof mock>).mockRejectedValue(
        new TasksError('NOT_FOUND', 'Queue projects/p/locations/l/queues/missing not found')
      );

      const request = { name: 'projects/p/locations/l/queues/missing' };
      const call = makeCall(request);
      const callback = makeCallback();

      await handlers.getQueue(call, callback as Parameters<typeof handlers.getQueue>[1]);

      expect(callback).toHaveBeenCalledTimes(1);

      const callErr = firstCallArg0<grpc.ServiceError>(callback);

      expect(callErr.code).toBe(grpc.status.NOT_FOUND);
    });

    test('maps ALREADY_EXISTS to grpc.status.ALREADY_EXISTS', async () => {
      (queueService.createQueue as ReturnType<typeof mock>).mockRejectedValue(
        new TasksError('ALREADY_EXISTS', 'Queue already exists')
      );

      const request = {
        parent: 'projects/p/locations/l',
        queue: { name: 'projects/p/locations/l/queues/q' },
      };

      const call = makeCall(request);
      const callback = makeCallback();

      await handlers.createQueue(call, callback as Parameters<typeof handlers.createQueue>[1]);

      expect(callback).toHaveBeenCalledTimes(1);

      const callErr = firstCallArg0<grpc.ServiceError>(callback);

      expect(callErr.code).toBe(grpc.status.ALREADY_EXISTS);
    });

    test('maps INVALID_ARGUMENT to grpc.status.INVALID_ARGUMENT', async () => {
      (queueService.createQueue as ReturnType<typeof mock>).mockRejectedValue(
        new TasksError('INVALID_ARGUMENT', 'Bad queue body')
      );

      const request = {
        parent: 'projects/p/locations/l',
        queue: {},
      };

      const call = makeCall(request);
      const callback = makeCallback();

      await handlers.createQueue(call, callback as Parameters<typeof handlers.createQueue>[1]);

      expect(callback).toHaveBeenCalledTimes(1);

      const callErr = firstCallArg0<grpc.ServiceError>(callback);

      expect(callErr.code).toBe(grpc.status.INVALID_ARGUMENT);
    });

    test('maps FAILED_PRECONDITION to grpc.status.FAILED_PRECONDITION', async () => {
      (queueService.pauseQueue as ReturnType<typeof mock>).mockRejectedValue(
        new TasksError('FAILED_PRECONDITION', 'Queue already paused')
      );

      const request = { name: 'projects/p/locations/l/queues/q' };
      const call = makeCall(request);
      const callback = makeCallback();

      await handlers.pauseQueue(call, callback as Parameters<typeof handlers.pauseQueue>[1]);

      expect(callback).toHaveBeenCalledTimes(1);

      const callErr = firstCallArg0<grpc.ServiceError>(callback);

      expect(callErr.code).toBe(grpc.status.FAILED_PRECONDITION);
    });
  });

  describe('DeleteTask', () => {
    test('surfaces NOT_FOUND for unknown task', async () => {
      (taskService.deleteTask as ReturnType<typeof mock>).mockRejectedValue(
        new TasksError('NOT_FOUND', 'Task projects/p/locations/l/queues/q/tasks/missing not found')
      );

      const request = { name: 'projects/p/locations/l/queues/q/tasks/missing' };
      const call = makeCall(request);
      const callback = makeCallback();

      await handlers.deleteTask(call, callback as Parameters<typeof handlers.deleteTask>[1]);

      expect(callback).toHaveBeenCalledTimes(1);

      const callErr = firstCallArg0<grpc.ServiceError>(callback);

      expect(callErr.code).toBe(grpc.status.NOT_FOUND);
    });
  });

  describe('IAM stubs', () => {
    test('GetIamPolicy returns UNIMPLEMENTED', async () => {
      const request = { resource: 'projects/p/locations/l/queues/q' };
      const call = makeCall(request);
      const callback = makeCallback();

      await handlers.getIamPolicy(call, callback as Parameters<typeof handlers.getIamPolicy>[1]);

      expect(callback).toHaveBeenCalledTimes(1);

      const callErr = firstCallArg0<grpc.ServiceError>(callback);

      expect(callErr.code).toBe(grpc.status.UNIMPLEMENTED);
    });

    test('SetIamPolicy returns UNIMPLEMENTED', async () => {
      const request = { resource: 'projects/p/locations/l/queues/q', policy: {} };
      const call = makeCall(request);
      const callback = makeCallback();

      await handlers.setIamPolicy(call, callback as Parameters<typeof handlers.setIamPolicy>[1]);

      expect(callback).toHaveBeenCalledTimes(1);

      const callErr = firstCallArg0<grpc.ServiceError>(callback);

      expect(callErr.code).toBe(grpc.status.UNIMPLEMENTED);
    });

    test('TestIamPermissions returns UNIMPLEMENTED', async () => {
      const request = { resource: 'projects/p/locations/l/queues/q', permissions: [] };
      const call = makeCall(request);
      const callback = makeCallback();

      await handlers.testIamPermissions(
        call,
        callback as Parameters<typeof handlers.testIamPermissions>[1]
      );

      expect(callback).toHaveBeenCalledTimes(1);

      const callErr = firstCallArg0<grpc.ServiceError>(callback);

      expect(callErr.code).toBe(grpc.status.UNIMPLEMENTED);
    });
  });
});
