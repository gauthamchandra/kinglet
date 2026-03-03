/**
 * Tests for Cloud Tasks types, schemas, and helper functions
 */

import { test, expect, describe } from 'bun:test';
import {
  parseQueueName,
  buildQueueName,
  parseTaskName,
  buildTaskName,
  parseDurationSeconds,
  normalizeHttpMethod,
  queueRecordToResponse,
  requestToQueueRecord,
  taskRecordToResponse,
  requestToTaskRecord,
  QueueState,
  TaskStatus,
  DEFAULT_RATE_LIMITS,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_TASK_TTL,
  DEFAULT_TOMBSTONE_TTL,
  DEFAULT_DISPATCH_DEADLINE,
  TASKS_QUEUES_TABLE,
  TASKS_TABLE,
  RateLimitsSchema,
  TaskRetryConfigSchema,
  CreateQueueRequestSchema,
  UpdateQueueRequestSchema,
  TaskHttpRequestSchema,
  CreateTaskRequestSchema,
} from './types.ts';
import type { QueueRecord, TaskRecord } from './types.ts';

describe('Cloud Tasks Types', () => {
  describe('parseQueueName', () => {
    test('should parse a valid queue resource name', () => {
      const result = parseQueueName('projects/my-project/locations/us-central1/queues/my-queue');

      expect(result).toEqual({
        project: 'my-project',
        location: 'us-central1',
        queueId: 'my-queue',
      });
    });

    test('should parse queue names with hyphens and numbers', () => {
      const result = parseQueueName('projects/proj-123/locations/europe-west1/queues/queue-456');

      expect(result).toEqual({
        project: 'proj-123',
        location: 'europe-west1',
        queueId: 'queue-456',
      });
    });

    test('should throw for invalid queue name format', () => {
      expect(() => parseQueueName('invalid/name')).toThrow();
      expect(() => parseQueueName('')).toThrow();
      expect(() => parseQueueName('projects/p/locations/l')).toThrow();
    });
  });

  describe('buildQueueName', () => {
    test('should build a valid queue resource name', () => {
      const name = buildQueueName('my-project', 'us-central1', 'my-queue');

      expect(name).toBe('projects/my-project/locations/us-central1/queues/my-queue');
    });

    test('should be the inverse of parseQueueName', () => {
      const original = 'projects/test-project/locations/us-east1/queues/test-queue';
      const parsed = parseQueueName(original);
      const rebuilt = buildQueueName(parsed.project, parsed.location, parsed.queueId);

      expect(rebuilt).toBe(original);
    });
  });

  describe('parseTaskName', () => {
    test('should parse a valid task resource name', () => {
      const result = parseTaskName(
        'projects/my-project/locations/us-central1/queues/my-queue/tasks/my-task'
      );

      expect(result).toEqual({
        project: 'my-project',
        location: 'us-central1',
        queueId: 'my-queue',
        taskId: 'my-task',
      });
    });

    test('should parse task names with UUIDs', () => {
      const result = parseTaskName(
        'projects/p/locations/l/queues/q/tasks/550e8400-e29b-41d4-a716-446655440000'
      );

      expect(result).toEqual({
        project: 'p',
        location: 'l',
        queueId: 'q',
        taskId: '550e8400-e29b-41d4-a716-446655440000',
      });
    });

    test('should throw for invalid task name format', () => {
      expect(() => parseTaskName('invalid/name')).toThrow();
      expect(() => parseTaskName('')).toThrow();
      expect(() => parseTaskName('projects/p/locations/l/queues/q')).toThrow();
    });
  });

  describe('buildTaskName', () => {
    test('should build a valid task resource name', () => {
      const name = buildTaskName('my-project', 'us-central1', 'my-queue', 'my-task');

      expect(name).toBe('projects/my-project/locations/us-central1/queues/my-queue/tasks/my-task');
    });

    test('should be the inverse of parseTaskName', () => {
      const original = 'projects/p/locations/l/queues/q/tasks/t';
      const parsed = parseTaskName(original);
      const rebuilt = buildTaskName(parsed.project, parsed.location, parsed.queueId, parsed.taskId);

      expect(rebuilt).toBe(original);
    });
  });

  describe('Constants', () => {
    test('should define queue states', () => {
      expect(QueueState.STATE_UNSPECIFIED).toBe('STATE_UNSPECIFIED');
      expect(QueueState.RUNNING).toBe('RUNNING');
      expect(QueueState.PAUSED).toBe('PAUSED');
      expect(QueueState.DISABLED).toBe('DISABLED');
    });

    test('should define task statuses', () => {
      expect(TaskStatus.PENDING).toBe('PENDING');
      expect(TaskStatus.DISPATCHING).toBe('DISPATCHING');
      expect(TaskStatus.FAILED).toBe('FAILED');
      expect(TaskStatus.TOMBSTONE).toBe('TOMBSTONE');
    });

    test('should define default rate limits', () => {
      expect(DEFAULT_RATE_LIMITS.maxDispatchesPerSecond).toBe(500);
      expect(DEFAULT_RATE_LIMITS.maxBurstSize).toBe(100);
      expect(DEFAULT_RATE_LIMITS.maxConcurrentDispatches).toBe(1000);
    });

    test('should define default retry config', () => {
      expect(DEFAULT_RETRY_CONFIG.maxAttempts).toBe(100);
      expect(DEFAULT_RETRY_CONFIG.maxRetryDuration).toBe('0s');
      expect(DEFAULT_RETRY_CONFIG.minBackoff).toBe('0.100s');
      expect(DEFAULT_RETRY_CONFIG.maxBackoff).toBe('3600s');
      expect(DEFAULT_RETRY_CONFIG.maxDoublings).toBe(16);
    });

    test('should define default TTLs', () => {
      expect(DEFAULT_TASK_TTL).toBe('2678400s');
      expect(DEFAULT_TOMBSTONE_TTL).toBe('3600s');
    });

    test('should define default dispatch deadline', () => {
      expect(DEFAULT_DISPATCH_DEADLINE).toBe('600s');
    });

    test('should define table names', () => {
      expect(TASKS_QUEUES_TABLE).toBe('tasks_queues');
      expect(TASKS_TABLE).toBe('tasks_items');
    });
  });

  describe('parseDurationSeconds', () => {
    test('should parse integer seconds', () => {
      expect(parseDurationSeconds('5s')).toBe(5);
      expect(parseDurationSeconds('3600s')).toBe(3600);
      expect(parseDurationSeconds('0s')).toBe(0);
    });

    test('should parse fractional seconds', () => {
      expect(parseDurationSeconds('0.100s')).toBe(0.1);
      expect(parseDurationSeconds('1.5s')).toBe(1.5);
      expect(parseDurationSeconds('0.5s')).toBe(0.5);
    });

    test('should throw on invalid format', () => {
      expect(() => parseDurationSeconds('')).toThrow('Invalid duration format');
      expect(() => parseDurationSeconds('5')).toThrow('Invalid duration format');
      expect(() => parseDurationSeconds('5m')).toThrow('Invalid duration format');
      expect(() => parseDurationSeconds('abc')).toThrow('Invalid duration format');
    });
  });

  describe('normalizeHttpMethod', () => {
    test('should pass through valid string methods', () => {
      expect(normalizeHttpMethod('GET')).toBe('GET');
      expect(normalizeHttpMethod('POST')).toBe('POST');
      expect(normalizeHttpMethod('PUT')).toBe('PUT');
      expect(normalizeHttpMethod('DELETE')).toBe('DELETE');
      expect(normalizeHttpMethod('PATCH')).toBe('PATCH');
      expect(normalizeHttpMethod('HEAD')).toBe('HEAD');
      expect(normalizeHttpMethod('OPTIONS')).toBe('OPTIONS');
    });

    test('should handle case-insensitive string methods', () => {
      expect(normalizeHttpMethod('get')).toBe('GET');
      expect(normalizeHttpMethod('post')).toBe('POST');
    });

    test('should convert protobuf integer enum values', () => {
      expect(normalizeHttpMethod(0)).toBe('POST'); // HTTP_METHOD_UNSPECIFIED defaults to POST
      expect(normalizeHttpMethod(1)).toBe('POST');
      expect(normalizeHttpMethod(2)).toBe('GET');
      expect(normalizeHttpMethod(3)).toBe('HEAD');
      expect(normalizeHttpMethod(4)).toBe('PUT');
      expect(normalizeHttpMethod(5)).toBe('DELETE');
      expect(normalizeHttpMethod(6)).toBe('PATCH');
      expect(normalizeHttpMethod(7)).toBe('OPTIONS');
    });

    test('should throw for unknown integer values', () => {
      expect(() => normalizeHttpMethod(99)).toThrow();
    });

    test('should throw for unknown string values', () => {
      expect(() => normalizeHttpMethod('INVALID')).toThrow();
    });
  });

  describe('RateLimitsSchema', () => {
    test('should validate valid rate limits', () => {
      const input = {
        maxDispatchesPerSecond: 100,
        maxBurstSize: 50,
        maxConcurrentDispatches: 500,
      };

      const result = RateLimitsSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    test('should reject out-of-range maxDispatchesPerSecond', () => {
      const result = RateLimitsSchema.safeParse({
        maxDispatchesPerSecond: 0.001, // below 0.01 minimum
        maxBurstSize: 50,
        maxConcurrentDispatches: 500,
      });

      expect(result.success).toBe(false);
    });

    test('should reject out-of-range maxConcurrentDispatches', () => {
      const result = RateLimitsSchema.safeParse({
        maxDispatchesPerSecond: 100,
        maxBurstSize: 50,
        maxConcurrentDispatches: 6000, // above 5000 maximum
      });

      expect(result.success).toBe(false);
    });
  });

  describe('TaskRetryConfigSchema', () => {
    test('should validate valid retry config', () => {
      const input = {
        maxAttempts: 5,
        maxRetryDuration: '300s',
        minBackoff: '1s',
        maxBackoff: '60s',
        maxDoublings: 10,
      };

      const result = TaskRetryConfigSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    test('should accept -1 for unlimited maxAttempts', () => {
      const input = {
        maxAttempts: -1,
        maxRetryDuration: '0s',
        minBackoff: '0.100s',
        maxBackoff: '3600s',
        maxDoublings: 16,
      };

      const result = TaskRetryConfigSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    test('should reject maxAttempts below -1', () => {
      const result = TaskRetryConfigSchema.safeParse({
        maxAttempts: -2,
        maxRetryDuration: '0s',
        minBackoff: '0.100s',
        maxBackoff: '3600s',
        maxDoublings: 16,
      });

      expect(result.success).toBe(false);
    });
  });

  describe('CreateQueueRequestSchema', () => {
    test('should validate a minimal create request', () => {
      const input = {};

      const result = CreateQueueRequestSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    test('should accept optional fields', () => {
      const input = {
        rateLimits: {
          maxDispatchesPerSecond: 100,
          maxBurstSize: 50,
          maxConcurrentDispatches: 500,
        },
        retryConfig: {
          maxAttempts: 5,
          maxRetryDuration: '300s',
          minBackoff: '1s',
          maxBackoff: '60s',
          maxDoublings: 10,
        },
        stackdriverLoggingConfig: {
          samplingRatio: 0.5,
        },
      };

      const result = CreateQueueRequestSchema.safeParse(input);

      expect(result.success).toBe(true);
    });
  });

  describe('UpdateQueueRequestSchema', () => {
    test('should allow partial updates', () => {
      const input = {
        rateLimits: {
          maxDispatchesPerSecond: 200,
          maxBurstSize: 100,
          maxConcurrentDispatches: 1000,
        },
      };

      const result = UpdateQueueRequestSchema.safeParse(input);

      expect(result.success).toBe(true);
    });
  });

  describe('TaskHttpRequestSchema', () => {
    test('should validate a valid HTTP request', () => {
      const input = {
        url: 'https://example.com/callback',
        httpMethod: 'POST',
      };

      const result = TaskHttpRequestSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    test('should require url', () => {
      const input = {
        httpMethod: 'GET',
      };

      const result = TaskHttpRequestSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    test('should accept protobuf integer httpMethod', () => {
      const input = {
        url: 'https://example.com',
        httpMethod: 1, // POST as protobuf int
      };

      const result = TaskHttpRequestSchema.safeParse(input);

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.httpMethod).toBe('POST');
      }
    });

    test('should accept optional headers and body', () => {
      const input = {
        url: 'https://example.com',
        httpMethod: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from('{"key":"value"}').toString('base64'),
      };

      const result = TaskHttpRequestSchema.safeParse(input);

      expect(result.success).toBe(true);
    });
  });

  describe('CreateTaskRequestSchema', () => {
    test('should validate a task creation request', () => {
      const input = {
        task: {
          httpRequest: {
            url: 'https://example.com/handler',
            httpMethod: 'POST',
          },
        },
      };

      const result = CreateTaskRequestSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    test('should accept responseView', () => {
      const input = {
        task: {
          httpRequest: {
            url: 'https://example.com/handler',
            httpMethod: 'POST',
          },
        },
        responseView: 'FULL',
      };

      const result = CreateTaskRequestSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    test('should accept optional task name and scheduleTime', () => {
      const input = {
        task: {
          name: 'projects/p/locations/l/queues/q/tasks/custom-id',
          httpRequest: {
            url: 'https://example.com',
            httpMethod: 'GET',
          },
          scheduleTime: '2024-01-01T00:00:00Z',
          dispatchDeadline: '300s',
        },
      };

      const result = CreateTaskRequestSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    test('should require task.httpRequest', () => {
      const input = {
        task: {},
      };

      const result = CreateTaskRequestSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    test('should accept valid RFC 3339 scheduleTime with UTC', () => {
      const input = {
        task: {
          httpRequest: { url: 'https://example.com', httpMethod: 'POST' },
          scheduleTime: '2024-01-15T10:30:00Z',
        },
      };

      const result = CreateTaskRequestSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    test('should accept valid RFC 3339 scheduleTime with timezone offset', () => {
      const input = {
        task: {
          httpRequest: { url: 'https://example.com', httpMethod: 'POST' },
          scheduleTime: '2024-01-15T10:30:00+05:30',
        },
      };

      const result = CreateTaskRequestSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    test('should accept past scheduleTime (dispatches immediately per GCP behavior)', () => {
      const input = {
        task: {
          httpRequest: { url: 'https://example.com', httpMethod: 'POST' },
          scheduleTime: '2020-01-01T00:00:00Z',
        },
      };

      const result = CreateTaskRequestSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    test('should reject invalid scheduleTime strings', () => {
      const invalidTimes = ['not-a-date', 'tomorrow', '2024-13-01T00:00:00Z', '1234567890'];

      for (const scheduleTime of invalidTimes) {
        const input = {
          task: {
            httpRequest: { url: 'https://example.com', httpMethod: 'POST' },
            scheduleTime,
          },
        };

        const result = CreateTaskRequestSchema.safeParse(input);

        expect(result.success).toBe(false);
      }
    });

    test('should accept missing scheduleTime (defaults to now)', () => {
      const input = {
        task: {
          httpRequest: { url: 'https://example.com', httpMethod: 'POST' },
        },
      };

      const result = CreateTaskRequestSchema.safeParse(input);

      expect(result.success).toBe(true);
    });
  });

  describe('queueRecordToResponse', () => {
    test('should convert a queue record to API response', () => {
      const record: QueueRecord = {
        id: 'internal-uuid',
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        name: 'projects/p/locations/l/queues/q',
        state: 'RUNNING',
        rateLimits: JSON.stringify(DEFAULT_RATE_LIMITS),
        retryConfig: JSON.stringify(DEFAULT_RETRY_CONFIG),
        purgeTime: null,
        taskTtl: DEFAULT_TASK_TTL,
        tombstoneTtl: DEFAULT_TOMBSTONE_TTL,
        stackdriverLoggingConfig: null,
        httpTarget: null,
      };

      const response = queueRecordToResponse(record);

      expect(response.name).toBe('projects/p/locations/l/queues/q');
      expect(response.state).toBe('RUNNING');
      expect(response.rateLimits).toEqual(DEFAULT_RATE_LIMITS);
      expect(response.retryConfig).toEqual(DEFAULT_RETRY_CONFIG);
      expect(response.purgeTime).toBeUndefined();
      expect(response.stackdriverLoggingConfig).toBeUndefined();
    });

    test('should include purgeTime when present', () => {
      const record: QueueRecord = {
        id: 'id',
        createdAt: new Date(),
        updatedAt: new Date(),
        name: 'projects/p/locations/l/queues/q',
        state: 'RUNNING',
        rateLimits: JSON.stringify(DEFAULT_RATE_LIMITS),
        retryConfig: JSON.stringify(DEFAULT_RETRY_CONFIG),
        purgeTime: '2024-06-15T12:00:00Z',
        taskTtl: DEFAULT_TASK_TTL,
        tombstoneTtl: DEFAULT_TOMBSTONE_TTL,
        stackdriverLoggingConfig: null,
        httpTarget: null,
      };

      const response = queueRecordToResponse(record);

      expect(response.purgeTime).toBe('2024-06-15T12:00:00Z');
    });

    test('should throw descriptive error for corrupt rateLimits JSON', () => {
      const record: QueueRecord = {
        id: 'id',
        createdAt: new Date(),
        updatedAt: new Date(),
        name: 'projects/p/locations/l/queues/q',
        state: 'RUNNING',
        rateLimits: '{not valid json',
        retryConfig: JSON.stringify(DEFAULT_RETRY_CONFIG),
        purgeTime: null,
        taskTtl: DEFAULT_TASK_TTL,
        tombstoneTtl: DEFAULT_TOMBSTONE_TTL,
        stackdriverLoggingConfig: null,
        httpTarget: null,
      };

      expect(() => queueRecordToResponse(record)).toThrow(
        /Corrupt rateLimits JSON in record "projects\/p\/locations\/l\/queues\/q"/
      );
    });

    test('should throw descriptive error for corrupt retryConfig JSON', () => {
      const record: QueueRecord = {
        id: 'id',
        createdAt: new Date(),
        updatedAt: new Date(),
        name: 'projects/p/locations/l/queues/q',
        state: 'RUNNING',
        rateLimits: JSON.stringify(DEFAULT_RATE_LIMITS),
        retryConfig: 'corrupt',
        purgeTime: null,
        taskTtl: DEFAULT_TASK_TTL,
        tombstoneTtl: DEFAULT_TOMBSTONE_TTL,
        stackdriverLoggingConfig: null,
        httpTarget: null,
      };

      expect(() => queueRecordToResponse(record)).toThrow(/Corrupt retryConfig JSON in record/);
    });
  });

  describe('requestToQueueRecord', () => {
    test('should convert a create request to a queue record with defaults', () => {
      const record = requestToQueueRecord('projects/p/locations/l/queues/q', {});

      expect(record.name).toBe('projects/p/locations/l/queues/q');
      expect(record.state).toBe('RUNNING');
      expect(JSON.parse(record.rateLimits)).toEqual(DEFAULT_RATE_LIMITS);
      expect(JSON.parse(record.retryConfig)).toEqual(DEFAULT_RETRY_CONFIG);
      expect(record.taskTtl).toBe(DEFAULT_TASK_TTL);
      expect(record.tombstoneTtl).toBe(DEFAULT_TOMBSTONE_TTL);
      expect(record.purgeTime).toBeNull();
      expect(record.stackdriverLoggingConfig).toBeNull();
      expect(record.httpTarget).toBeNull();
    });

    test('should apply custom rate limits', () => {
      const record = requestToQueueRecord('projects/p/locations/l/queues/q', {
        rateLimits: {
          maxDispatchesPerSecond: 200,
          maxBurstSize: 50,
          maxConcurrentDispatches: 500,
        },
      });

      const rateLimits = JSON.parse(record.rateLimits);

      expect(rateLimits.maxDispatchesPerSecond).toBe(200);
      expect(rateLimits.maxBurstSize).toBe(50);
      expect(rateLimits.maxConcurrentDispatches).toBe(500);
    });
  });

  describe('taskRecordToResponse', () => {
    const makeTaskRecord = (): TaskRecord => ({
      id: 'internal-uuid',
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z'),
      name: 'projects/p/locations/l/queues/q/tasks/t',
      queueName: 'projects/p/locations/l/queues/q',
      httpRequest: JSON.stringify({
        url: 'https://example.com/handler',
        httpMethod: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from('{"key":"value"}').toString('base64'),
      }),
      scheduleTime: '2024-01-01T00:00:00Z',
      dispatchDeadline: '600s',
      dispatchCount: 0,
      responseCount: 0,
      firstAttempt: null,
      lastAttempt: null,
      status: 'PENDING',
      tombstoneExpiry: null,
    });

    test('should return FULL view by default', () => {
      const record = makeTaskRecord();
      const response = taskRecordToResponse(record);

      expect(response.name).toBe('projects/p/locations/l/queues/q/tasks/t');
      expect(response.httpRequest).toBeTypeOf('object');
      expect(response.httpRequest.body).toBeTypeOf('string');
      expect(response.scheduleTime).toBe('2024-01-01T00:00:00Z');
      expect(response.dispatchCount).toBe(0);
      expect(response.responseCount).toBe(0);
    });

    test('should return FULL view with FULL param', () => {
      const record = makeTaskRecord();
      const response = taskRecordToResponse(record, 'FULL');

      expect(response.httpRequest.body).toBeTypeOf('string');
      expect(response.firstAttempt).toBeUndefined();
      expect(response.lastAttempt).toBeUndefined();
    });

    test('BASIC view should omit body and attempts', () => {
      const record = makeTaskRecord();

      record.firstAttempt = JSON.stringify({
        scheduleTime: '2024-01-01T00:00:00Z',
        dispatchTime: '2024-01-01T00:00:01Z',
      });
      record.lastAttempt = JSON.stringify({
        scheduleTime: '2024-01-01T00:00:00Z',
        dispatchTime: '2024-01-01T00:00:01Z',
        responseTime: '2024-01-01T00:00:02Z',
        responseStatus: 200,
      });

      const response = taskRecordToResponse(record, 'BASIC');

      expect(response.name).toBe('projects/p/locations/l/queues/q/tasks/t');
      expect(response.httpRequest.body).toBeUndefined();
      expect(response.firstAttempt).toBeUndefined();
      expect(response.lastAttempt).toBeUndefined();
    });

    test('FULL view should include attempts when present', () => {
      const record = makeTaskRecord();

      record.firstAttempt = JSON.stringify({
        scheduleTime: '2024-01-01T00:00:00Z',
        dispatchTime: '2024-01-01T00:00:01Z',
      });
      record.lastAttempt = JSON.stringify({
        scheduleTime: '2024-01-01T00:00:00Z',
        dispatchTime: '2024-01-01T00:00:01Z',
        responseTime: '2024-01-01T00:00:02Z',
        responseStatus: 200,
      });

      const response = taskRecordToResponse(record, 'FULL');

      expect(response.firstAttempt).toBeTypeOf('object');
      expect(response.lastAttempt).toBeTypeOf('object');
      expect(response.lastAttempt?.responseStatus).toBe(200);
    });

    test('should throw descriptive error for corrupt httpRequest JSON', () => {
      const record = makeTaskRecord();

      record.httpRequest = '{broken';

      expect(() => taskRecordToResponse(record)).toThrow(
        /Corrupt httpRequest JSON in record "projects\/p\/locations\/l\/queues\/q\/tasks\/t"/
      );
    });

    test('should throw descriptive error for corrupt firstAttempt JSON', () => {
      const record = makeTaskRecord();

      record.firstAttempt = 'not-json';

      expect(() => taskRecordToResponse(record, 'FULL')).toThrow(
        /Corrupt firstAttempt JSON in record/
      );
    });
  });

  describe('requestToTaskRecord', () => {
    test('should convert a create request to a task record', () => {
      const record = requestToTaskRecord(
        'projects/p/locations/l/queues/q/tasks/t',
        'projects/p/locations/l/queues/q',
        {
          httpRequest: {
            url: 'https://example.com',
            httpMethod: 'POST',
          },
        },
        { taskTtl: DEFAULT_TASK_TTL, tombstoneTtl: DEFAULT_TOMBSTONE_TTL }
      );

      expect(record.name).toBe('projects/p/locations/l/queues/q/tasks/t');
      expect(record.queueName).toBe('projects/p/locations/l/queues/q');
      expect(record.status).toBe('PENDING');
      expect(record.dispatchCount).toBe(0);
      expect(record.responseCount).toBe(0);
      expect(record.firstAttempt).toBeNull();
      expect(record.lastAttempt).toBeNull();
      expect(record.tombstoneExpiry).toBeNull();
      expect(record.dispatchDeadline).toBe(DEFAULT_DISPATCH_DEADLINE);
    });

    test('should use provided scheduleTime', () => {
      const record = requestToTaskRecord(
        'projects/p/locations/l/queues/q/tasks/t',
        'projects/p/locations/l/queues/q',
        {
          httpRequest: {
            url: 'https://example.com',
            httpMethod: 'GET',
          },
          scheduleTime: '2025-06-01T00:00:00Z',
        },
        { taskTtl: DEFAULT_TASK_TTL, tombstoneTtl: DEFAULT_TOMBSTONE_TTL }
      );

      expect(record.scheduleTime).toBe('2025-06-01T00:00:00Z');
    });

    test('should use provided dispatchDeadline', () => {
      const record = requestToTaskRecord(
        'projects/p/locations/l/queues/q/tasks/t',
        'projects/p/locations/l/queues/q',
        {
          httpRequest: {
            url: 'https://example.com',
            httpMethod: 'POST',
          },
          dispatchDeadline: '300s',
        },
        { taskTtl: DEFAULT_TASK_TTL, tombstoneTtl: DEFAULT_TOMBSTONE_TTL }
      );

      expect(record.dispatchDeadline).toBe('300s');
    });
  });
});
