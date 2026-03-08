/**
 * Tests for JobRepository
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { JobRepository } from './repository.ts';
import type { JobRecord } from './types.ts';
import { DEFAULT_RETRY_CONFIG, JobState } from './types.ts';

function makeJobData(
  overrides: Partial<Omit<JobRecord, keyof BaseRecord>> = {}
): Omit<JobRecord, keyof BaseRecord> {
  return {
    name: 'projects/test-project/locations/us-central1/jobs/test-job',
    description: 'Test job',
    schedule: '* * * * *',
    timeZone: 'UTC',
    state: JobState.ENABLED,
    httpTarget: JSON.stringify({ uri: 'https://example.com', httpMethod: 'POST' }),
    retryConfig: JSON.stringify(DEFAULT_RETRY_CONFIG),
    attemptDeadline: '180s',
    lastAttemptTime: null,
    scheduleTime: '2024-01-01T00:01:00Z',
    userUpdateTime: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('JobRepository', () => {
  let storage: StorageManager;
  let repo: JobRepository;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new JobRepository(storage);
    await repo.initialize();
  });

  describe('createJob', () => {
    test('should create a job and return it with generated id', async () => {
      const data = makeJobData();
      const job = await repo.createJob(data);

      expect(job.id).toBeDefined();
      expect(job.name).toBe(data.name);
      expect(job.schedule).toBe('* * * * *');
      expect(job.state).toBe('ENABLED');
      expect(job.createdAt).toBeInstanceOf(Date);
      expect(job.updatedAt).toBeInstanceOf(Date);
    });

    test('should reject duplicate job names', async () => {
      const data = makeJobData();

      await repo.createJob(data);

      await expect(repo.createJob(data)).rejects.toThrow();
    });
  });

  describe('getJobByName', () => {
    test('should find a job by resource name', async () => {
      const data = makeJobData();

      await repo.createJob(data);

      const found = await repo.getJobByName(data.name);

      expect(found).not.toBeNull();
      expect(found?.name).toBe(data.name);
      expect(found?.schedule).toBe('* * * * *');
    });

    test('should return null for non-existent job', async () => {
      const found = await repo.getJobByName('projects/p/locations/l/jobs/nonexistent');

      expect(found).toBeNull();
    });
  });

  describe('listJobs', () => {
    test('should list all jobs for a project/location', async () => {
      await repo.createJob(makeJobData({ name: 'projects/p1/locations/us-central1/jobs/job-a' }));
      await repo.createJob(makeJobData({ name: 'projects/p1/locations/us-central1/jobs/job-b' }));
      await repo.createJob(makeJobData({ name: 'projects/p2/locations/us-central1/jobs/job-c' }));

      const result = await repo.listJobs('p1', 'us-central1');

      expect(result.jobs.length).toBe(2);
      expect(result.jobs.map(j => j.name)).toContain(
        'projects/p1/locations/us-central1/jobs/job-a'
      );
      expect(result.jobs.map(j => j.name)).toContain(
        'projects/p1/locations/us-central1/jobs/job-b'
      );
    });

    test('should support pagination with pageSize', async () => {
      await repo.createJob(makeJobData({ name: 'projects/p/locations/l/jobs/job-1' }));
      await repo.createJob(makeJobData({ name: 'projects/p/locations/l/jobs/job-2' }));
      await repo.createJob(makeJobData({ name: 'projects/p/locations/l/jobs/job-3' }));

      const page1 = await repo.listJobs('p', 'l', 2);

      expect(page1.jobs.length).toBe(2);
      expect(page1.nextPageToken).toBeDefined();
    });

    test('should support pagination with pageToken', async () => {
      await repo.createJob(makeJobData({ name: 'projects/p/locations/l/jobs/job-1' }));
      await repo.createJob(makeJobData({ name: 'projects/p/locations/l/jobs/job-2' }));
      await repo.createJob(makeJobData({ name: 'projects/p/locations/l/jobs/job-3' }));

      const page1 = await repo.listJobs('p', 'l', 2);
      const page2 = await repo.listJobs('p', 'l', 2, page1.nextPageToken);

      expect(page2.jobs.length).toBe(1);
      expect(page2.nextPageToken).toBeUndefined();
    });

    test('should return empty list for non-existent project', async () => {
      const result = await repo.listJobs('nonexistent', 'us-central1');

      expect(result.jobs.length).toBe(0);
    });
  });

  describe('updateJob', () => {
    test('should update a job by resource name', async () => {
      const data = makeJobData();

      await repo.createJob(data);

      const updated = await repo.updateJob(data.name, {
        description: 'Updated description',
        state: JobState.PAUSED,
      });

      expect(updated).not.toBeNull();
      expect(updated?.description).toBe('Updated description');
      expect(updated?.state).toBe('PAUSED');
    });

    test('should return null when updating non-existent job', async () => {
      const updated = await repo.updateJob('projects/p/locations/l/jobs/nonexistent', {
        description: 'new',
      });

      expect(updated).toBeNull();
    });

    test('should preserve unchanged fields', async () => {
      const data = makeJobData({ description: 'Original' });

      await repo.createJob(data);

      const updated = await repo.updateJob(data.name, {
        state: JobState.PAUSED,
      });

      expect(updated?.description).toBe('Original');
      expect(updated?.schedule).toBe('* * * * *');
    });
  });

  describe('deleteJob', () => {
    test('should delete a job by resource name', async () => {
      const data = makeJobData();

      await repo.createJob(data);

      const deleted = await repo.deleteJob(data.name);

      expect(deleted).toBe(true);

      const found = await repo.getJobByName(data.name);

      expect(found).toBeNull();
    });

    test('should return false for non-existent job', async () => {
      const deleted = await repo.deleteJob('projects/p/locations/l/jobs/nonexistent');

      expect(deleted).toBe(false);
    });
  });

  describe('findDueJobs', () => {
    test('should find ENABLED jobs where scheduleTime <= now', async () => {
      await repo.createJob(
        makeJobData({
          name: 'projects/p/locations/l/jobs/due-job',
          scheduleTime: '2024-01-01T00:00:00Z',
          state: JobState.ENABLED,
        })
      );
      await repo.createJob(
        makeJobData({
          name: 'projects/p/locations/l/jobs/future-job',
          scheduleTime: '2025-12-31T23:59:59Z',
          state: JobState.ENABLED,
        })
      );
      await repo.createJob(
        makeJobData({
          name: 'projects/p/locations/l/jobs/paused-job',
          scheduleTime: '2024-01-01T00:00:00Z',
          state: JobState.PAUSED,
        })
      );

      const dueJobs = await repo.findDueJobs(new Date('2024-06-15T00:00:00Z'));

      expect(dueJobs.length).toBe(1);
      expect(dueJobs[0]?.name).toBe('projects/p/locations/l/jobs/due-job');
    });

    test('should return empty array when no jobs are due', async () => {
      await repo.createJob(
        makeJobData({
          name: 'projects/p/locations/l/jobs/future-job',
          scheduleTime: '2099-01-01T00:00:00Z',
          state: JobState.ENABLED,
        })
      );

      const dueJobs = await repo.findDueJobs(new Date('2024-01-01T00:00:00Z'));

      expect(dueJobs.length).toBe(0);
    });

    test('should not return jobs with null scheduleTime', async () => {
      await repo.createJob(
        makeJobData({
          name: 'projects/p/locations/l/jobs/null-schedule',
          scheduleTime: null,
          state: JobState.ENABLED,
        })
      );

      const dueJobs = await repo.findDueJobs(new Date());

      expect(dueJobs.length).toBe(0);
    });
  });
});
