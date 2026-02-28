/**
 * Tests for Cloud Scheduler types, schemas, and helper functions
 */

import { test, expect, describe } from 'bun:test';
import {
  parseJobName,
  buildJobName,
  jobRecordToResponse,
  requestToJobRecord,
  normalizeHttpMethod,
  JobState,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_TIMEZONE,
  CreateJobRequestSchema,
  UpdateJobRequestSchema,
  SCHEDULER_JOBS_TABLE,
} from './types.ts';
import type { JobRecord } from './types.ts';

describe('Cloud Scheduler Types', () => {
  describe('parseJobName', () => {
    test('should parse a valid job resource name', () => {
      const result = parseJobName('projects/my-project/locations/us-central1/jobs/my-job');

      expect(result).toEqual({
        project: 'my-project',
        location: 'us-central1',
        jobId: 'my-job',
      });
    });

    test('should parse job names with hyphens and numbers', () => {
      const result = parseJobName('projects/proj-123/locations/europe-west1/jobs/job-456');

      expect(result).toEqual({
        project: 'proj-123',
        location: 'europe-west1',
        jobId: 'job-456',
      });
    });

    test('should throw for invalid job name format', () => {
      expect(() => parseJobName('invalid/name')).toThrow();
      expect(() => parseJobName('')).toThrow();
      expect(() => parseJobName('projects/p/locations/l')).toThrow();
    });
  });

  describe('buildJobName', () => {
    test('should build a valid resource name', () => {
      const name = buildJobName('my-project', 'us-central1', 'my-job');

      expect(name).toBe('projects/my-project/locations/us-central1/jobs/my-job');
    });

    test('should be the inverse of parseJobName', () => {
      const original = 'projects/test-project/locations/us-east1/jobs/test-job';
      const parsed = parseJobName(original);
      const rebuilt = buildJobName(parsed.project, parsed.location, parsed.jobId);

      expect(rebuilt).toBe(original);
    });
  });

  describe('Constants', () => {
    test('should define job states', () => {
      expect(JobState.ENABLED).toBe('ENABLED');
      expect(JobState.PAUSED).toBe('PAUSED');
      expect(JobState.DISABLED).toBe('DISABLED');
      expect(JobState.UPDATE_FAILED).toBe('UPDATE_FAILED');
    });

    test('should define default retry config', () => {
      expect(DEFAULT_RETRY_CONFIG.retryCount).toBe(0);
      expect(DEFAULT_RETRY_CONFIG.maxRetryDuration).toBe('0s');
      expect(DEFAULT_RETRY_CONFIG.minBackoffDuration).toBe('5s');
      expect(DEFAULT_RETRY_CONFIG.maxBackoffDuration).toBe('3600s');
    });

    test('should define default timezone as UTC', () => {
      expect(DEFAULT_TIMEZONE).toBe('UTC');
    });

    test('should define the table name', () => {
      expect(SCHEDULER_JOBS_TABLE).toBe('scheduler_jobs');
    });
  });

  describe('jobRecordToResponse', () => {
    test('should convert a job record to a GCP API response', () => {
      const record: JobRecord = {
        id: 'internal-uuid',
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        name: 'projects/p/locations/l/jobs/j',
        description: 'Test job',
        schedule: '* * * * *',
        timeZone: 'UTC',
        state: 'ENABLED',
        httpTarget: JSON.stringify({
          uri: 'https://example.com/callback',
          httpMethod: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from('{"key":"value"}').toString('base64'),
        }),
        retryConfig: JSON.stringify(DEFAULT_RETRY_CONFIG),
        attemptDeadline: '180s',
        lastAttemptTime: null,
        scheduleTime: '2024-01-01T00:01:00Z',
        userUpdateTime: '2024-01-01T00:00:00Z',
      };

      const response = jobRecordToResponse(record);

      expect(response.name).toBe('projects/p/locations/l/jobs/j');
      expect(response.description).toBe('Test job');
      expect(response.schedule).toBe('* * * * *');
      expect(response.timeZone).toBe('UTC');
      expect(response.state).toBe('ENABLED');
      expect(response.httpTarget.uri).toBe('https://example.com/callback');
      expect(response.httpTarget.httpMethod).toBe('POST');
      expect(response.retryConfig).toEqual(DEFAULT_RETRY_CONFIG);
      expect(response.attemptDeadline).toBe('180s');
      expect(response.scheduleTime).toBe('2024-01-01T00:01:00Z');
      expect(response.userUpdateTime).toBe('2024-01-01T00:00:00Z');
      expect(response.lastAttemptTime).toBeUndefined();
    });

    test('should include lastAttemptTime when present', () => {
      const record: JobRecord = {
        id: 'id',
        createdAt: new Date(),
        updatedAt: new Date(),
        name: 'projects/p/locations/l/jobs/j',
        description: '',
        schedule: '* * * * *',
        timeZone: 'UTC',
        state: 'ENABLED',
        httpTarget: JSON.stringify({ uri: 'https://example.com', httpMethod: 'GET' }),
        retryConfig: JSON.stringify(DEFAULT_RETRY_CONFIG),
        attemptDeadline: '180s',
        lastAttemptTime: '2024-06-15T12:00:00Z',
        scheduleTime: '2024-06-15T12:01:00Z',
        userUpdateTime: '2024-06-15T12:00:00Z',
      };

      const response = jobRecordToResponse(record);

      expect(response.lastAttemptTime).toBe('2024-06-15T12:00:00Z');
    });
  });

  describe('requestToJobRecord', () => {
    test('should convert a create request body to a job record', () => {
      const body = {
        description: 'My cron job',
        schedule: '0 9 * * 1-5',
        timeZone: 'America/New_York',
        httpTarget: {
          uri: 'https://example.com/run',
          httpMethod: 'POST' as const,
          headers: { Authorization: 'Bearer token' },
          body: Buffer.from('hello').toString('base64'),
        },
      };

      const record = requestToJobRecord(
        'projects/p/locations/l/jobs/my-job',
        body,
        '2024-01-01T09:00:00Z'
      );

      expect(record.name).toBe('projects/p/locations/l/jobs/my-job');
      expect(record.description).toBe('My cron job');
      expect(record.schedule).toBe('0 9 * * 1-5');
      expect(record.timeZone).toBe('America/New_York');
      expect(record.state).toBe('ENABLED');
      expect(JSON.parse(record.httpTarget)).toEqual(body.httpTarget);
      expect(record.scheduleTime).toBe('2024-01-01T09:00:00Z');
      expect(record.attemptDeadline).toBe('180s');
    });

    test('should apply defaults for optional fields', () => {
      const body = {
        schedule: '* * * * *',
        httpTarget: {
          uri: 'https://example.com',
          httpMethod: 'GET' as const,
        },
      };

      const record = requestToJobRecord(
        'projects/p/locations/l/jobs/j',
        body,
        '2024-01-01T00:00:00Z'
      );

      expect(record.timeZone).toBe('UTC');
      expect(record.description).toBe('');
      expect(record.attemptDeadline).toBe('180s');
      expect(JSON.parse(record.retryConfig)).toEqual(DEFAULT_RETRY_CONFIG);
    });
  });

  describe('CreateJobRequestSchema', () => {
    test('should validate a valid create request', () => {
      const input = {
        schedule: '* * * * *',
        httpTarget: {
          uri: 'https://example.com/callback',
          httpMethod: 'POST',
        },
      };

      const result = CreateJobRequestSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    test('should require schedule', () => {
      const input = {
        httpTarget: {
          uri: 'https://example.com',
          httpMethod: 'GET',
        },
      };

      const result = CreateJobRequestSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    test('should require httpTarget', () => {
      const input = {
        schedule: '* * * * *',
      };

      const result = CreateJobRequestSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    test('should require httpTarget.uri', () => {
      const input = {
        schedule: '* * * * *',
        httpTarget: {
          httpMethod: 'GET',
        },
      };

      const result = CreateJobRequestSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    test('should require httpTarget.httpMethod', () => {
      const input = {
        schedule: '* * * * *',
        httpTarget: {
          uri: 'https://example.com',
        },
      };

      const result = CreateJobRequestSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    test('should accept optional fields', () => {
      const input = {
        description: 'A job',
        schedule: '0 9 * * *',
        timeZone: 'America/New_York',
        httpTarget: {
          uri: 'https://example.com',
          httpMethod: 'POST',
          headers: { 'X-Custom': 'value' },
          body: Buffer.from('payload').toString('base64'),
        },
        retryConfig: {
          retryCount: 3,
          maxRetryDuration: '300s',
          minBackoffDuration: '10s',
          maxBackoffDuration: '600s',
        },
        attemptDeadline: '60s',
      };

      const result = CreateJobRequestSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    test('should reject invalid httpMethod', () => {
      const input = {
        schedule: '* * * * *',
        httpTarget: {
          uri: 'https://example.com',
          httpMethod: 'INVALID',
        },
      };

      const result = CreateJobRequestSchema.safeParse(input);

      expect(result.success).toBe(false);
    });
  });

  describe('normalizeHttpMethod', () => {
    test('should pass through valid string methods unchanged', () => {
      expect(normalizeHttpMethod('GET')).toBe('GET');
      expect(normalizeHttpMethod('POST')).toBe('POST');
      expect(normalizeHttpMethod('PUT')).toBe('PUT');
      expect(normalizeHttpMethod('DELETE')).toBe('DELETE');
      expect(normalizeHttpMethod('PATCH')).toBe('PATCH');
      expect(normalizeHttpMethod('HEAD')).toBe('HEAD');
      expect(normalizeHttpMethod('OPTIONS')).toBe('OPTIONS');
    });

    test('should convert protobuf integer enum values to string methods', () => {
      expect(normalizeHttpMethod(1)).toBe('POST');
      expect(normalizeHttpMethod(2)).toBe('GET');
      expect(normalizeHttpMethod(3)).toBe('HEAD');
      expect(normalizeHttpMethod(4)).toBe('PUT');
      expect(normalizeHttpMethod(5)).toBe('DELETE');
      expect(normalizeHttpMethod(6)).toBe('PATCH');
      expect(normalizeHttpMethod(7)).toBe('OPTIONS');
    });

    test('should default unspecified (0) to POST', () => {
      expect(normalizeHttpMethod(0)).toBe('POST');
    });

    test('should throw for unknown integer values', () => {
      expect(() => normalizeHttpMethod(99)).toThrow();
    });

    test('should throw for unknown string values', () => {
      expect(() => normalizeHttpMethod('INVALID')).toThrow();
    });
  });

  describe('CreateJobRequestSchema with protobuf integers', () => {
    test('should accept integer httpMethod and normalize to string', () => {
      const input = {
        schedule: '* * * * *',
        httpTarget: {
          uri: 'https://example.com',
          httpMethod: 1, // POST as protobuf int
        },
      };

      const result = CreateJobRequestSchema.safeParse(input);

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.httpTarget.httpMethod).toBe('POST');
      }
    });

    test('should accept HTTP_METHOD_UNSPECIFIED (0) and default to POST', () => {
      const input = {
        schedule: '* * * * *',
        httpTarget: {
          uri: 'https://example.com',
          httpMethod: 0,
        },
      };

      const result = CreateJobRequestSchema.safeParse(input);

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.httpTarget.httpMethod).toBe('POST');
      }
    });
  });

  describe('UpdateJobRequestSchema', () => {
    test('should allow partial updates', () => {
      const input = {
        description: 'Updated description',
      };

      const result = UpdateJobRequestSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    test('should allow updating schedule', () => {
      const input = {
        schedule: '0 */2 * * *',
      };

      const result = UpdateJobRequestSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    test('should allow updating httpTarget', () => {
      const input = {
        httpTarget: {
          uri: 'https://new-endpoint.com',
          httpMethod: 'PUT',
        },
      };

      const result = UpdateJobRequestSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    test('should reject invalid httpMethod in update', () => {
      const input = {
        httpTarget: {
          uri: 'https://example.com',
          httpMethod: 'INVALID',
        },
      };

      const result = UpdateJobRequestSchema.safeParse(input);

      expect(result.success).toBe(false);
    });
  });
});
