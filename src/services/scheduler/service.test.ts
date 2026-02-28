/**
 * Tests for JobService - business logic layer
 *
 * Uses real in-memory StorageManager + real CronEngine + real JobRepository (no mocks).
 */

import { test, expect, describe, beforeEach, mock } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { JobRepository } from './repository.ts';
import { CronEngine } from './cron-engine.ts';
import { JobService, SchedulerError } from './service.ts';
import type { JobRecord } from './types.ts';

describe('JobService', () => {
  let storage: StorageManager;
  let repo: JobRepository;
  let cron: CronEngine;
  let service: JobService;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new JobRepository(storage);
    await repo.initialize();
    cron = new CronEngine();
    service = new JobService(repo, cron);
  });

  describe('createJob', () => {
    test('should create a job and return GCP response', async () => {
      const result = await service.createJob('test-project', 'us-central1', 'my-job', {
        schedule: '* * * * *',
        httpTarget: { uri: 'https://example.com', httpMethod: 'POST' },
      });

      expect(result.name).toBe('projects/test-project/locations/us-central1/jobs/my-job');
      expect(result.state).toBe('ENABLED');
      expect(result.schedule).toBe('* * * * *');
      expect(result.httpTarget.uri).toBe('https://example.com');
      expect(result.scheduleTime).toBeDefined();
    });

    test('should compute initial scheduleTime from cron expression', async () => {
      const result = await service.createJob('p', 'l', 'j', {
        schedule: '0 9 * * *',
        timeZone: 'UTC',
        httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
      });

      expect(result.scheduleTime).toBeDefined();
      // scheduleTime should be a valid ISO date in the future
      const scheduleDate = new Date(result.scheduleTime as string);

      expect(scheduleDate.getTime()).toBeGreaterThan(Date.now() - 120000);
    });

    test('should reject invalid cron expression', async () => {
      await expect(
        service.createJob('p', 'l', 'j', {
          schedule: 'invalid-cron',
          httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
        })
      ).rejects.toThrow(SchedulerError);
    });

    test('should reject duplicate job names', async () => {
      await service.createJob('p', 'l', 'j', {
        schedule: '* * * * *',
        httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
      });

      try {
        await service.createJob('p', 'l', 'j', {
          schedule: '* * * * *',
          httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
        });
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(SchedulerError);
        expect((err as SchedulerError).code).toBe('ALREADY_EXISTS');
      }
    });

    test('should validate request body with Zod', async () => {
      await expect(
        service.createJob('p', 'l', 'j', {
          // Missing required fields
        } as never)
      ).rejects.toThrow(SchedulerError);
    });
  });

  describe('getJob', () => {
    test('should return a job by name', async () => {
      await service.createJob('p', 'l', 'j', {
        schedule: '* * * * *',
        httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
      });

      const result = await service.getJob('projects/p/locations/l/jobs/j');

      expect(result.name).toBe('projects/p/locations/l/jobs/j');
    });

    test('should throw NOT_FOUND for non-existent job', async () => {
      try {
        await service.getJob('projects/p/locations/l/jobs/nonexistent');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(SchedulerError);
        expect((err as SchedulerError).code).toBe('NOT_FOUND');
      }
    });
  });

  describe('listJobs', () => {
    test('should list jobs for a project/location', async () => {
      await service.createJob('p', 'l', 'job-1', {
        schedule: '* * * * *',
        httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
      });
      await service.createJob('p', 'l', 'job-2', {
        schedule: '* * * * *',
        httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
      });

      const result = await service.listJobs('p', 'l');

      expect(result.jobs.length).toBe(2);
    });

    test('should support pagination', async () => {
      await service.createJob('p', 'l', 'job-1', {
        schedule: '* * * * *',
        httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
      });
      await service.createJob('p', 'l', 'job-2', {
        schedule: '* * * * *',
        httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
      });

      const page1 = await service.listJobs('p', 'l', 1);

      expect(page1.jobs.length).toBe(1);
      expect(page1.nextPageToken).toBeDefined();
    });
  });

  describe('updateJob', () => {
    test('should update a job and return updated response', async () => {
      await service.createJob('p', 'l', 'j', {
        schedule: '* * * * *',
        description: 'Original',
        httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
      });

      const result = await service.updateJob('projects/p/locations/l/jobs/j', {
        description: 'Updated',
      });

      expect(result.description).toBe('Updated');
    });

    test('should recompute scheduleTime when schedule changes', async () => {
      await service.createJob('p', 'l', 'j', {
        schedule: '* * * * *',
        httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
      });

      const updated = await service.updateJob('projects/p/locations/l/jobs/j', {
        schedule: '0 9 * * *',
      });

      expect(updated.scheduleTime).toBeDefined();
      // The schedule time should have changed since the cron expression changed
      expect(updated.schedule).toBe('0 9 * * *');
    });

    test('should throw NOT_FOUND for non-existent job', async () => {
      try {
        await service.updateJob('projects/p/locations/l/jobs/nonexistent', {
          description: 'new',
        });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(SchedulerError);
        expect((err as SchedulerError).code).toBe('NOT_FOUND');
      }
    });
  });

  describe('deleteJob', () => {
    test('should delete a job', async () => {
      await service.createJob('p', 'l', 'j', {
        schedule: '* * * * *',
        httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
      });

      await service.deleteJob('projects/p/locations/l/jobs/j');

      await expect(service.getJob('projects/p/locations/l/jobs/j')).rejects.toThrow();
    });

    test('should throw NOT_FOUND for non-existent job', async () => {
      try {
        await service.deleteJob('projects/p/locations/l/jobs/nonexistent');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(SchedulerError);
        expect((err as SchedulerError).code).toBe('NOT_FOUND');
      }
    });
  });

  describe('pauseJob', () => {
    test('should pause an ENABLED job', async () => {
      await service.createJob('p', 'l', 'j', {
        schedule: '* * * * *',
        httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
      });

      const result = await service.pauseJob('projects/p/locations/l/jobs/j');

      expect(result.state).toBe('PAUSED');
    });

    test('should clear scheduleTime when pausing', async () => {
      await service.createJob('p', 'l', 'j', {
        schedule: '* * * * *',
        httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
      });

      const result = await service.pauseJob('projects/p/locations/l/jobs/j');

      expect(result.scheduleTime).toBeUndefined();
    });

    test('should throw FAILED_PRECONDITION when pausing already-paused job', async () => {
      await service.createJob('p', 'l', 'j', {
        schedule: '* * * * *',
        httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
      });
      await service.pauseJob('projects/p/locations/l/jobs/j');

      try {
        await service.pauseJob('projects/p/locations/l/jobs/j');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(SchedulerError);
        expect((err as SchedulerError).code).toBe('FAILED_PRECONDITION');
      }
    });
  });

  describe('resumeJob', () => {
    test('should resume a PAUSED job', async () => {
      await service.createJob('p', 'l', 'j', {
        schedule: '* * * * *',
        httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
      });
      await service.pauseJob('projects/p/locations/l/jobs/j');

      const result = await service.resumeJob('projects/p/locations/l/jobs/j');

      expect(result.state).toBe('ENABLED');
    });

    test('should recompute scheduleTime when resuming', async () => {
      await service.createJob('p', 'l', 'j', {
        schedule: '* * * * *',
        httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
      });
      await service.pauseJob('projects/p/locations/l/jobs/j');

      const result = await service.resumeJob('projects/p/locations/l/jobs/j');

      expect(result.scheduleTime).toBeDefined();
    });

    test('should throw FAILED_PRECONDITION when resuming non-paused job', async () => {
      await service.createJob('p', 'l', 'j', {
        schedule: '* * * * *',
        httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
      });

      try {
        await service.resumeJob('projects/p/locations/l/jobs/j');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(SchedulerError);
        expect((err as SchedulerError).code).toBe('FAILED_PRECONDITION');
      }
    });
  });

  describe('runJob', () => {
    test('should return the job for immediate execution', async () => {
      await service.createJob('p', 'l', 'j', {
        schedule: '* * * * *',
        httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
      });

      const result = await service.runJob('projects/p/locations/l/jobs/j');

      expect(result.name).toBe('projects/p/locations/l/jobs/j');
    });

    test('should invoke the onExecute callback when set', async () => {
      const executeFn = mock((_job: JobRecord) => Promise.resolve());

      service.setExecuteCallback(executeFn);

      await service.createJob('p', 'l', 'j', {
        schedule: '* * * * *',
        httpTarget: { uri: 'https://example.com', httpMethod: 'POST' },
      });

      await service.runJob('projects/p/locations/l/jobs/j');

      expect(executeFn).toHaveBeenCalledTimes(1);

      const calledWith = executeFn.mock.calls[0]?.[0];

      expect(calledWith?.name).toBe('projects/p/locations/l/jobs/j');
    });

    test('should still return the job even if no execute callback is set', async () => {
      await service.createJob('p', 'l', 'j', {
        schedule: '* * * * *',
        httpTarget: { uri: 'https://example.com', httpMethod: 'GET' },
      });

      const result = await service.runJob('projects/p/locations/l/jobs/j');

      expect(result.name).toBe('projects/p/locations/l/jobs/j');
    });

    test('should throw NOT_FOUND for non-existent job', async () => {
      try {
        await service.runJob('projects/p/locations/l/jobs/nonexistent');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(SchedulerError);
        expect((err as SchedulerError).code).toBe('NOT_FOUND');
      }
    });
  });
});
