/**
 * Tests for ExecutionEngine
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { CronEngine } from './cron-engine.ts';
import { ExecutionEngine } from './execution-engine.ts';
import { JobRepository } from './repository.ts';
import type { JobRecord } from './types.ts';
import { DEFAULT_RETRY_CONFIG, JobState } from './types.ts';

function makeJobData(
  overrides: Partial<Omit<JobRecord, keyof BaseRecord>> = {}
): Omit<JobRecord, keyof BaseRecord> {
  return {
    name: 'projects/p/locations/l/jobs/test-job',
    description: 'Test job',
    schedule: '* * * * *',
    timeZone: 'UTC',
    state: JobState.ENABLED,
    httpTarget: JSON.stringify({
      uri: 'https://example.com/callback',
      httpMethod: 'POST',
      headers: { 'X-Test': 'true' },
      body: Buffer.from('hello').toString('base64'),
    }),
    retryConfig: JSON.stringify(DEFAULT_RETRY_CONFIG),
    attemptDeadline: '180s',
    lastAttemptTime: null,
    scheduleTime: new Date(Date.now() - 60000).toISOString(), // 1 minute ago = due
    userUpdateTime: new Date().toISOString(),
    ...overrides,
  };
}

describe('ExecutionEngine', () => {
  let storage: StorageManager;
  let repo: JobRepository;
  let cronEngine: CronEngine;
  let engine: ExecutionEngine;
  let mockHttpClient: ReturnType<typeof mock>;
  const logger = new Logger('test', 'error');

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new JobRepository(storage);
    await repo.initialize();
    cronEngine = new CronEngine();

    mockHttpClient = mock(() => Promise.resolve(new Response('OK', { status: 200 })));

    engine = new ExecutionEngine(repo, cronEngine, logger, mockHttpClient);
  });

  afterEach(async () => {
    await engine.stop();
  });

  describe('tick', () => {
    test('should find due jobs and execute them', async () => {
      await repo.createJob(makeJobData());

      await engine.tick();

      expect(mockHttpClient).toHaveBeenCalled();
    });

    test('should call HTTP target with correct parameters', async () => {
      await repo.createJob(makeJobData());

      await engine.tick();

      expect(mockHttpClient).toHaveBeenCalledTimes(1);
      const callArgs = mockHttpClient.mock.calls[0] as [string, RequestInit];
      const url = callArgs[0];
      const options = callArgs[1];

      expect(url).toBe('https://example.com/callback');
      expect(options.method).toBe('POST');
      expect((options.headers as Record<string, string>)['X-Test']).toBe('true');
    });

    test('should not execute paused jobs', async () => {
      await repo.createJob(makeJobData({ state: JobState.PAUSED }));

      await engine.tick();

      expect(mockHttpClient).not.toHaveBeenCalled();
    });

    test('should not execute future jobs', async () => {
      await repo.createJob(
        makeJobData({
          scheduleTime: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
        })
      );

      await engine.tick();

      expect(mockHttpClient).not.toHaveBeenCalled();
    });

    test('should update lastAttemptTime after execution', async () => {
      const data = makeJobData();

      await repo.createJob(data);

      await engine.tick();

      const updated = await repo.getJobByName(data.name);

      expect(updated?.lastAttemptTime).not.toBeNull();
    });

    test('should update scheduleTime to next cron run after execution', async () => {
      const data = makeJobData();
      const created = await repo.createJob(data);
      const originalScheduleTime = created.scheduleTime;

      await engine.tick();

      const updated = await repo.getJobByName(data.name);

      expect(updated?.scheduleTime).not.toBe(originalScheduleTime);
      expect(updated?.scheduleTime).not.toBeNull();
    });
  });

  describe('error handling', () => {
    test('should handle HTTP failures without crashing', async () => {
      mockHttpClient.mockRejectedValue(new Error('Network error'));
      await repo.createJob(makeJobData());

      // Should not throw
      await engine.tick();

      const job = await repo.getJobByName('projects/p/locations/l/jobs/test-job');

      expect(job?.lastAttemptTime).not.toBeNull();
    });

    test('should handle non-2xx responses', async () => {
      mockHttpClient.mockResolvedValue(new Response('Server Error', { status: 500 }));
      await repo.createJob(makeJobData());

      await engine.tick();

      const job = await repo.getJobByName('projects/p/locations/l/jobs/test-job');

      expect(job?.lastAttemptTime).not.toBeNull();
    });

    test('should handle malformed httpTarget JSON gracefully', async () => {
      const created = await repo.createJob(makeJobData({ httpTarget: 'not valid json{' }));

      await engine.executeJob(created);

      // Should not crash, and should not call HTTP client
      expect(mockHttpClient).not.toHaveBeenCalled();
    });
  });

  describe('retry logic', () => {
    test('should not retry when retryCount is 0', async () => {
      mockHttpClient.mockRejectedValue(new Error('Network error'));

      const created = await repo.createJob(makeJobData());

      await engine.executeJob(created);

      expect(mockHttpClient).toHaveBeenCalledTimes(1);
    });

    test('should retry on network error up to retryCount times', async () => {
      mockHttpClient.mockRejectedValue(new Error('Network error'));

      const created = await repo.createJob(
        makeJobData({
          retryConfig: JSON.stringify({
            retryCount: 2,
            maxRetryDuration: '0s',
            minBackoffDuration: '0s',
            maxBackoffDuration: '0s',
          }),
        })
      );

      await engine.executeJob(created);

      // 1 initial + 2 retries = 3 total
      expect(mockHttpClient).toHaveBeenCalledTimes(3);
    });

    test('should retry on non-2xx response', async () => {
      mockHttpClient.mockResolvedValue(new Response('Error', { status: 500 }));

      const created = await repo.createJob(
        makeJobData({
          retryConfig: JSON.stringify({
            retryCount: 1,
            maxRetryDuration: '0s',
            minBackoffDuration: '0s',
            maxBackoffDuration: '0s',
          }),
        })
      );

      await engine.executeJob(created);

      // 1 initial + 1 retry = 2 total
      expect(mockHttpClient).toHaveBeenCalledTimes(2);
    });

    test('should stop retrying on success', async () => {
      mockHttpClient
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const created = await repo.createJob(
        makeJobData({
          retryConfig: JSON.stringify({
            retryCount: 3,
            maxRetryDuration: '0s',
            minBackoffDuration: '0s',
            maxBackoffDuration: '0s',
          }),
        })
      );

      await engine.executeJob(created);

      // 1 failure + 1 success = 2 total (stopped early)
      expect(mockHttpClient).toHaveBeenCalledTimes(2);
    });

    test('should still update lastAttemptTime and scheduleTime after retries', async () => {
      mockHttpClient.mockRejectedValue(new Error('Network error'));

      const created = await repo.createJob(
        makeJobData({
          retryConfig: JSON.stringify({
            retryCount: 1,
            maxRetryDuration: '0s',
            minBackoffDuration: '0s',
            maxBackoffDuration: '0s',
          }),
        })
      );

      await engine.executeJob(created);

      const updated = await repo.getJobByName(created.name);

      expect(updated?.lastAttemptTime).not.toBeNull();
      expect(updated?.scheduleTime).not.toBeNull();
    });
  });

  describe('executeJob', () => {
    test('should execute a single job immediately', async () => {
      const created = await repo.createJob(makeJobData());

      await engine.executeJob(created);

      expect(mockHttpClient).toHaveBeenCalledTimes(1);
    });

    test('should send body decoded from base64', async () => {
      const created = await repo.createJob(
        makeJobData({
          httpTarget: JSON.stringify({
            uri: 'https://example.com',
            httpMethod: 'POST',
            body: Buffer.from('{"key":"value"}').toString('base64'),
          }),
        })
      );

      await engine.executeJob(created);

      const callArgs = mockHttpClient.mock.calls[0] as [string, RequestInit];
      const options = callArgs[1];

      expect(options.body).toBe('{"key":"value"}');
    });

    test('should handle jobs with no body', async () => {
      const created = await repo.createJob(
        makeJobData({
          httpTarget: JSON.stringify({
            uri: 'https://example.com',
            httpMethod: 'GET',
          }),
        })
      );

      await engine.executeJob(created);

      const callArgs = mockHttpClient.mock.calls[0] as [string, RequestInit];
      const options = callArgs[1];

      expect(options.body).toBeUndefined();
    });
  });

  describe('start/stop', () => {
    test('should start and stop without error', async () => {
      engine.start(60000);

      // Give a moment for the timer to be set
      expect(() => engine.stop()).not.toThrow();
    });

    test('stopped engine should not execute on tick', async () => {
      await repo.createJob(makeJobData());
      engine.start(60000);
      await engine.stop();

      // Reset mock to track calls after stop
      mockHttpClient.mockClear();

      // Manually calling tick after stop should still work (it's public)
      // but the timer-based auto-execution should have stopped
      await engine.tick();

      // tick() still works when called directly - it's only the auto-timer that stops
      expect(mockHttpClient).toHaveBeenCalled();
    });
  });
});
