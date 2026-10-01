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

  describe('pageSize normalization', () => {
    test('listQueues with pageSize=0 passes undefined to queueService', async () => {
      (queueService.listQueues as ReturnType<typeof mock>).mockResolvedValue({
        queues: [],
        nextPageToken: undefined,
      });

      const request = { parent: 'projects/p/locations/l', pageSize: 0 };
      const call = makeCall(request);
      const callback = makeCallback();

      await handlers.listQueues(call, callback as Parameters<typeof handlers.listQueues>[1]);

      expect(callback).toHaveBeenCalledTimes(1);

      const callErr = firstCallArg0<null>(callback);

      expect(callErr).toBeNull();

      const serviceCalls = (queueService.listQueues as ReturnType<typeof mock>).mock.calls;

      expect(serviceCalls.length).toBeGreaterThan(0);

      const pageSizeArg = (serviceCalls[0] as unknown[])[2];

      expect(pageSizeArg).toBeUndefined();
    });

    test('listTasks with pageSize=0 passes undefined to taskService', async () => {
      (taskService.listTasks as ReturnType<typeof mock>).mockResolvedValue({
        tasks: [],
        nextPageToken: undefined,
      });

      const request = { parent: 'projects/p/locations/l/queues/q', pageSize: 0 };
      const call = makeCall(request);
      const callback = makeCallback();

      await handlers.listTasks(call, callback as Parameters<typeof handlers.listTasks>[1]);

      expect(callback).toHaveBeenCalledTimes(1);

      const callErr = firstCallArg0<null>(callback);

      expect(callErr).toBeNull();

      const serviceCalls = (taskService.listTasks as ReturnType<typeof mock>).mock.calls;

      expect(serviceCalls.length).toBeGreaterThan(0);

      const pageSizeArg = (serviceCalls[0] as unknown[])[2];

      expect(pageSizeArg).toBeUndefined();
    });

    test('listQueues with explicit pageSize passes it through', async () => {
      (queueService.listQueues as ReturnType<typeof mock>).mockResolvedValue({
        queues: [],
        nextPageToken: undefined,
      });

      const request = { parent: 'projects/p/locations/l', pageSize: 25 };
      const call = makeCall(request);
      const callback = makeCallback();

      await handlers.listQueues(call, callback as Parameters<typeof handlers.listQueues>[1]);

      const serviceCalls = (queueService.listQueues as ReturnType<typeof mock>).mock.calls;

      expect((serviceCalls[0] as unknown[])[2]).toBe(25);
    });
  });

  describe('invalid resource name → INVALID_ARGUMENT', () => {
    test('listQueues with malformed parent returns INVALID_ARGUMENT', async () => {
      const request = { parent: 'bad-parent-format' };
      const call = makeCall(request);
      const callback = makeCallback();

      await handlers.listQueues(call, callback as Parameters<typeof handlers.listQueues>[1]);

      expect(callback).toHaveBeenCalledTimes(1);

      const callErr = firstCallArg0<grpc.ServiceError>(callback);

      expect(callErr.code).toBe(grpc.status.INVALID_ARGUMENT);
    });

    test('createQueue with malformed parent returns INVALID_ARGUMENT', async () => {
      const request = {
        parent: 'not-valid',
        queue: { name: 'projects/p/locations/l/queues/q' },
      };
      const call = makeCall(request);
      const callback = makeCallback();

      await handlers.createQueue(call, callback as Parameters<typeof handlers.createQueue>[1]);

      expect(callback).toHaveBeenCalledTimes(1);

      const callErr = firstCallArg0<grpc.ServiceError>(callback);

      expect(callErr.code).toBe(grpc.status.INVALID_ARGUMENT);
    });

    test('createTask with malformed parent returns INVALID_ARGUMENT', async () => {
      const request = {
        parent: 'not-valid',
        task: { httpRequest: { url: 'http://localhost/callback' } },
      };
      const call = makeCall(request);
      const callback = makeCallback();

      await handlers.createTask(call, callback as Parameters<typeof handlers.createTask>[1]);

      expect(callback).toHaveBeenCalledTimes(1);

      const callErr = firstCallArg0<grpc.ServiceError>(callback);

      expect(callErr.code).toBe(grpc.status.INVALID_ARGUMENT);
    });
  });

  describe('conversion helpers (exercised through handlers)', () => {
    test('taskResponseToProto converts ISO scheduleTime to proto Timestamp', async () => {
      const fakeTask = {
        name: 'projects/p/locations/l/queues/q/tasks/t',
        scheduleTime: '2026-01-01T00:00:00.000Z',
        createTime: '2026-01-01T00:00:00.000Z',
        dispatchDeadline: '600s',
        dispatchCount: 0,
        responseCount: 0,
        view: 'FULL',
      };

      (taskService.getTask as ReturnType<typeof mock>).mockResolvedValue(fakeTask);

      const call = makeCall({ name: fakeTask.name });
      const callback = makeCallback();

      await handlers.getTask(call, callback as Parameters<typeof handlers.getTask>[1]);

      expect(callback).toHaveBeenCalledTimes(1);

      const callErr = firstCallArg0<null>(callback);

      expect(callErr).toBeNull();

      type ProtoTask = {
        scheduleTime: { seconds: string; nanos: number };
        dispatchDeadline: { seconds: string; nanos: number };
      };
      const result = (callback as unknown as MockCalls<[null, ProtoTask]>).mock.calls[0]?.[1];

      expect(result?.scheduleTime.seconds).toBe('1767225600');
      expect(result?.scheduleTime.nanos).toBe(0);
      expect(result?.dispatchDeadline.seconds).toBe('600');
      expect(result?.dispatchDeadline.nanos).toBe(0);
    });

    test('taskResponseToProto converts fractional duration correctly', async () => {
      const fakeTask = {
        name: 'projects/p/locations/l/queues/q/tasks/t',
        scheduleTime: '2026-01-01T00:00:00.000Z',
        createTime: '2026-01-01T00:00:00.000Z',
        dispatchDeadline: '1.5s',
        dispatchCount: 0,
        responseCount: 0,
        view: 'FULL',
      };

      (taskService.getTask as ReturnType<typeof mock>).mockResolvedValue(fakeTask);

      const call = makeCall({ name: fakeTask.name });
      const callback = makeCallback();

      await handlers.getTask(call, callback as Parameters<typeof handlers.getTask>[1]);

      type ProtoTask = { dispatchDeadline: { seconds: string; nanos: number } };
      const result = (callback as unknown as MockCalls<[null, ProtoTask]>).mock.calls[0]?.[1];

      expect(result?.dispatchDeadline.seconds).toBe('1');
      expect(result?.dispatchDeadline.nanos).toBe(500000000);
    });

    test('createTask with Buffer body encodes to base64', async () => {
      const fakeTask = {
        name: 'projects/p/locations/l/queues/q/tasks/t',
        scheduleTime: '2026-01-01T00:00:00.000Z',
        createTime: '2026-01-01T00:00:00.000Z',
        dispatchDeadline: '600s',
        dispatchCount: 0,
        responseCount: 0,
        view: 'FULL',
      };

      (taskService.createTask as ReturnType<typeof mock>).mockResolvedValue(fakeTask);

      const rawBody = Buffer.from('hello');
      const request = {
        parent: 'projects/p/locations/l/queues/q',
        task: {
          payloadType: 'httpRequest',
          httpRequest: {
            url: 'http://localhost/callback',
            httpMethod: 'POST',
            body: rawBody as unknown as string,
          },
        },
      };

      const call = makeCall(request);
      const callback = makeCallback();

      await handlers.createTask(call, callback as Parameters<typeof handlers.createTask>[1]);

      const serviceCalls = (taskService.createTask as ReturnType<typeof mock>).mock.calls;

      expect(serviceCalls.length).toBeGreaterThan(0);

      type CreateBody = { task: { httpRequest: { body: string } } };
      const body = (serviceCalls[0] as unknown[])[3] as CreateBody;

      expect(body.task.httpRequest.body).toBe('aGVsbG8=');
    });

    test('createTask with numeric HTTP method 0 normalizes to POST', async () => {
      const fakeTask = {
        name: 'projects/p/locations/l/queues/q/tasks/t',
        scheduleTime: '2026-01-01T00:00:00.000Z',
        createTime: '2026-01-01T00:00:00.000Z',
        dispatchDeadline: '600s',
        dispatchCount: 0,
        responseCount: 0,
        view: 'FULL',
      };

      (taskService.createTask as ReturnType<typeof mock>).mockResolvedValue(fakeTask);

      const request = {
        parent: 'projects/p/locations/l/queues/q',
        task: {
          payloadType: 'httpRequest',
          httpRequest: {
            url: 'http://localhost/callback',
            httpMethod: 0,
          },
        },
      };

      const call = makeCall(request);
      const callback = makeCallback();

      await handlers.createTask(call, callback as Parameters<typeof handlers.createTask>[1]);

      const serviceCalls = (taskService.createTask as ReturnType<typeof mock>).mock.calls;

      expect(serviceCalls.length).toBeGreaterThan(0);

      type CreateBody = { task: { httpRequest: { httpMethod: string } } };
      const body = (serviceCalls[0] as unknown[])[3] as CreateBody;

      expect(body.task.httpRequest.httpMethod).toBe('POST');
    });

    test('normalizeResponseView collapses 0 and VIEW_UNSPECIFIED to undefined', async () => {
      (taskService.getTask as ReturnType<typeof mock>).mockResolvedValue({
        name: 'projects/p/locations/l/queues/q/tasks/t',
        scheduleTime: '2026-01-01T00:00:00.000Z',
        createTime: '2026-01-01T00:00:00.000Z',
        dispatchDeadline: '600s',
        dispatchCount: 0,
        responseCount: 0,
        view: 'BASIC',
      });

      const call = makeCall({ name: 'projects/p/locations/l/queues/q/tasks/t', responseView: '0' });
      const callback = makeCallback();

      await handlers.getTask(call, callback as Parameters<typeof handlers.getTask>[1]);

      const serviceCalls = (taskService.getTask as ReturnType<typeof mock>).mock.calls;

      expect(serviceCalls.length).toBeGreaterThan(0);

      const viewArg = (serviceCalls[0] as unknown[])[1];

      expect(viewArg).toBeUndefined();
    });

    test('normalizeResponseView maps FULL and "2" to FULL', async () => {
      (taskService.getTask as ReturnType<typeof mock>).mockResolvedValue({
        name: 'projects/p/locations/l/queues/q/tasks/t',
        scheduleTime: '2026-01-01T00:00:00.000Z',
        createTime: '2026-01-01T00:00:00.000Z',
        dispatchDeadline: '600s',
        dispatchCount: 0,
        responseCount: 0,
        view: 'FULL',
      });

      const call = makeCall({ name: 'projects/p/locations/l/queues/q/tasks/t', responseView: '2' });
      const callback = makeCallback();

      await handlers.getTask(call, callback as Parameters<typeof handlers.getTask>[1]);

      const serviceCalls = (taskService.getTask as ReturnType<typeof mock>).mock.calls;

      expect(serviceCalls.length).toBeGreaterThan(0);

      const viewArg = (serviceCalls[0] as unknown[])[1];

      expect(viewArg).toBe('FULL');
    });

    test('protoDurationToStr preserves full nanosecond precision', async () => {
      const fakeQueue = {
        name: 'projects/p/locations/l/queues/q',
        state: 'RUNNING',
        rateLimits: {
          maxDispatchesPerSecond: 500,
          maxBurstSize: 100,
          maxConcurrentDispatches: 1000,
        },
        retryConfig: {
          maxAttempts: 3,
          maxRetryDuration: '0s',
          minBackoff: '0.1s',
          maxBackoff: '3600s',
          maxDoublings: 16,
        },
        taskTtl: '604800s',
        tombstoneTtl: '86400s',
      };

      (queueService.getQueue as ReturnType<typeof mock>).mockResolvedValue(fakeQueue);

      const call = makeCall({ name: 'projects/p/locations/l/queues/q' });
      const callback = makeCallback();

      await handlers.getQueue(call, callback as Parameters<typeof handlers.getQueue>[1]);

      type ProtoQueue = {
        retryConfig: {
          minBackoff: { seconds: string; nanos: number };
          maxBackoff: { seconds: string; nanos: number };
        };
      };
      const result = (callback as ReturnType<typeof mock>).mock.calls[0] as [null, ProtoQueue];
      const minBackoff = result[1].retryConfig.minBackoff;

      expect(minBackoff.seconds).toBe('0');
      expect(minBackoff.nanos).toBe(100_000_000);
    });

    test('protoDurationToStr preserves all 9 nanosecond digits (no truncation)', async () => {
      const fakeQueue = {
        name: 'projects/p/locations/l/queues/q',
        state: 'RUNNING',
        rateLimits: {
          maxDispatchesPerSecond: 500,
          maxBurstSize: 100,
          maxConcurrentDispatches: 1000,
        },
        retryConfig: {
          maxAttempts: 3,
          maxRetryDuration: '0s',
          minBackoff: '15.000000500s',
          maxBackoff: '3600s',
          maxDoublings: 16,
        },
        taskTtl: '604800s',
        tombstoneTtl: '86400s',
      };

      (queueService.getQueue as ReturnType<typeof mock>).mockResolvedValue(fakeQueue);

      const call = makeCall({ name: 'projects/p/locations/l/queues/q' });
      const callback = makeCallback();

      await handlers.getQueue(call, callback as Parameters<typeof handlers.getQueue>[1]);

      type ProtoQueue = {
        retryConfig: { minBackoff: { seconds: string; nanos: number } };
      };
      const result = (callback as ReturnType<typeof mock>).mock.calls[0] as [null, ProtoQueue];
      const minBackoff = result[1].retryConfig.minBackoff;

      expect(minBackoff.seconds).toBe('15');
      expect(minBackoff.nanos).toBe(500);
    });
  });

  describe('createQueue', () => {
    test('rejects queue.name that belongs to a different parent', async () => {
      const call = makeCall({
        parent: 'projects/p/locations/us-central1',
        queue: {
          name: 'projects/other/locations/us-central1/queues/my-queue',
        },
      });
      const callback = makeCallback();

      await handlers.createQueue(call, callback as Parameters<typeof handlers.createQueue>[1]);

      const [err] = (callback as ReturnType<typeof mock>).mock.calls[0] as [grpc.ServiceError];

      expect(err.code).toBe(grpc.status.INVALID_ARGUMENT);
    });

    test('accepts queue.name matching the parent', async () => {
      const fakeQueue = {
        name: 'projects/p/locations/us-central1/queues/my-queue',
        state: 'RUNNING',
        rateLimits: {
          maxDispatchesPerSecond: 500,
          maxBurstSize: 100,
          maxConcurrentDispatches: 1000,
        },
        retryConfig: {
          maxAttempts: 3,
          maxRetryDuration: '0s',
          minBackoff: '0.1s',
          maxBackoff: '3600s',
          maxDoublings: 16,
        },
        taskTtl: '604800s',
        tombstoneTtl: '86400s',
      };

      (queueService.createQueue as ReturnType<typeof mock>).mockResolvedValue(fakeQueue);

      const call = makeCall({
        parent: 'projects/p/locations/us-central1',
        queue: {
          name: 'projects/p/locations/us-central1/queues/my-queue',
        },
      });
      const callback = makeCallback();

      await handlers.createQueue(call, callback as Parameters<typeof handlers.createQueue>[1]);

      const [err] = (callback as ReturnType<typeof mock>).mock.calls[0] as [
        grpc.ServiceError | null,
      ];

      expect(err).toBeNull();

      const serviceCalls = (queueService.createQueue as ReturnType<typeof mock>).mock.calls;

      expect((serviceCalls[0] as unknown[])[2]).toBe('my-queue');
    });

    test('omits zero-valued rate limit fields forwarded by proto-loader defaults', async () => {
      const fakeQueue = {
        name: 'projects/p/locations/us-central1/queues/q',
        state: 'RUNNING',
        rateLimits: {
          maxDispatchesPerSecond: 500,
          maxBurstSize: 100,
          maxConcurrentDispatches: 1000,
        },
        retryConfig: {
          maxAttempts: 3,
          maxRetryDuration: '0s',
          minBackoff: '0.1s',
          maxBackoff: '3600s',
          maxDoublings: 16,
        },
        taskTtl: '604800s',
        tombstoneTtl: '86400s',
      };

      (queueService.createQueue as ReturnType<typeof mock>).mockResolvedValue(fakeQueue);

      const call = makeCall({
        parent: 'projects/p/locations/us-central1',
        queue: {
          name: 'projects/p/locations/us-central1/queues/q',
          rateLimits: {
            maxConcurrentDispatches: 5,
            maxDispatchesPerSecond: 0,
            maxBurstSize: 0,
          },
        },
      });
      const callback = makeCallback();

      await handlers.createQueue(call, callback as Parameters<typeof handlers.createQueue>[1]);

      type CreateArgs = [string, string, string, Record<string, unknown>];
      const [, , , body] = (queueService.createQueue as ReturnType<typeof mock>).mock
        .calls[0] as CreateArgs;

      const rl = body.rateLimits as Record<string, number> | undefined;

      expect(rl).toBeDefined();
      expect(rl?.maxConcurrentDispatches).toBe(5);
      expect(rl?.maxDispatchesPerSecond).toBeUndefined();
      expect(rl?.maxBurstSize).toBeUndefined();
    });
  });

  describe('updateQueue', () => {
    test('converts proto snake_case update mask paths to camelCase', async () => {
      const fakeQueue = {
        name: 'projects/p/locations/l/queues/q',
        state: 'RUNNING',
        rateLimits: {
          maxDispatchesPerSecond: 500,
          maxBurstSize: 100,
          maxConcurrentDispatches: 1000,
        },
        retryConfig: {
          maxAttempts: 3,
          maxRetryDuration: '0s',
          minBackoff: '0.1s',
          maxBackoff: '3600s',
          maxDoublings: 16,
        },
        taskTtl: '604800s',
        tombstoneTtl: '86400s',
      };

      (queueService.updateQueue as ReturnType<typeof mock>).mockResolvedValue(fakeQueue);

      const call = makeCall({
        queue: {
          name: 'projects/p/locations/l/queues/q',
          rateLimits: { maxConcurrentDispatches: 10, maxDispatchesPerSecond: 0, maxBurstSize: 0 },
        },
        updateMask: { paths: ['rate_limits', 'retry_config'] },
      });
      const callback = makeCallback();

      await handlers.updateQueue(call, callback as Parameters<typeof handlers.updateQueue>[1]);

      type UpdateArgs = [string, Record<string, unknown>, string | undefined];
      const [, , maskStr] = (queueService.updateQueue as ReturnType<typeof mock>).mock
        .calls[0] as UpdateArgs;

      expect(maskStr).toBe('rateLimits,retryConfig');
    });

    test('passes undefined mask when no paths provided', async () => {
      const fakeQueue = {
        name: 'projects/p/locations/l/queues/q',
        state: 'RUNNING',
        rateLimits: {
          maxDispatchesPerSecond: 500,
          maxBurstSize: 100,
          maxConcurrentDispatches: 1000,
        },
        retryConfig: {
          maxAttempts: 3,
          maxRetryDuration: '0s',
          minBackoff: '0.1s',
          maxBackoff: '3600s',
          maxDoublings: 16,
        },
        taskTtl: '604800s',
        tombstoneTtl: '86400s',
      };

      (queueService.updateQueue as ReturnType<typeof mock>).mockResolvedValue(fakeQueue);

      const call = makeCall({
        queue: { name: 'projects/p/locations/l/queues/q' },
        updateMask: { paths: [] },
      });
      const callback = makeCallback();

      await handlers.updateQueue(call, callback as Parameters<typeof handlers.updateQueue>[1]);

      type UpdateArgs = [string, Record<string, unknown>, string | undefined];
      const [, , maskStr] = (queueService.updateQueue as ReturnType<typeof mock>).mock
        .calls[0] as UpdateArgs;

      expect(maskStr).toBeUndefined();
    });
  });
});
