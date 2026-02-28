/**
 * Execution Engine - timer-based job runner for Cloud Scheduler
 *
 * Polls for due jobs and executes HTTP targets.
 * TODO: Add Pub/Sub target support
 * TODO: Add App Engine target support
 */

import type { Logger } from '@/shared/utils/logger.ts';
import type { JobRepository } from './repository.ts';
import type { CronEngine } from './cron-engine.ts';
import { parseDurationSeconds } from './types.ts';
import type { HttpTarget, RetryConfig, JobRecord } from './types.ts';

type HttpClient = (url: string, init: RequestInit) => Promise<Response>;

export class ExecutionEngine {
  private repo: JobRepository;
  private cronEngine: CronEngine;
  private logger: Logger;
  private httpClient: HttpClient;
  private timerId: number | null = null;
  private running = false;

  constructor(
    repo: JobRepository,
    cronEngine: CronEngine,
    logger: Logger,
    httpClient?: HttpClient
  ) {
    this.repo = repo;
    this.cronEngine = cronEngine;
    this.logger = logger;
    this.httpClient = httpClient ?? fetch;
  }

  start(pollIntervalMs: number = 60000): void {
    if (this.timerId !== null) {
      return;
    }

    this.logger.info(`Starting execution engine with ${pollIntervalMs}ms poll interval`);

    this.timerId = setInterval(() => {
      void this.tick();
    }, pollIntervalMs) as unknown as number;
  }

  async stop(): Promise<void> {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }

    // Wait for any in-flight execution to complete
    while (this.running) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    this.logger.info('Execution engine stopped');
  }

  async tick(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const dueJobs = await this.repo.findDueJobs(new Date());

      for (const job of dueJobs) {
        await this.executeJob(job);
      }
    } catch (err) {
      this.logger.error('Error during tick', err);
    } finally {
      this.running = false;
    }
  }

  async executeJob(job: JobRecord): Promise<void> {
    let target: HttpTarget;

    try {
      target = JSON.parse(job.httpTarget) as HttpTarget;
    } catch (err) {
      this.logger.error(`Job ${job.name} has invalid httpTarget JSON`, err);

      return;
    }

    let retryConfig: RetryConfig;

    try {
      retryConfig = JSON.parse(job.retryConfig) as RetryConfig;
    } catch {
      retryConfig = {
        retryCount: 0,
        maxRetryDuration: '0s',
        minBackoffDuration: '5s',
        maxBackoffDuration: '3600s',
      };
    }

    this.logger.info(`Executing job ${job.name} -> ${target.httpMethod} ${target.uri}`);

    const maxAttempts = 1 + retryConfig.retryCount;
    const minBackoffMs = parseDurationSeconds(retryConfig.minBackoffDuration) * 1000;
    const maxBackoffMs = parseDurationSeconds(retryConfig.maxBackoffDuration) * 1000;
    const maxRetryDurationMs = parseDurationSeconds(retryConfig.maxRetryDuration) * 1000;
    const startTime = Date.now();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const success = await this.executeHttpRequest(job.name, target);

      if (success) {
        break;
      }

      const isLastAttempt = attempt >= maxAttempts - 1;

      if (isLastAttempt) {
        break;
      }

      // Check if we've exceeded maxRetryDuration
      if (maxRetryDurationMs > 0 && Date.now() - startTime >= maxRetryDurationMs) {
        this.logger.warn(`Job ${job.name} exceeded maxRetryDuration, stopping retries`);
        break;
      }

      // Exponential backoff: minBackoff * 2^attempt, capped at maxBackoff
      const backoffMs = Math.min(minBackoffMs * Math.pow(2, attempt), maxBackoffMs);

      this.logger.info(
        `Job ${job.name} retrying in ${backoffMs}ms (attempt ${attempt + 2}/${maxAttempts})`
      );

      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }

    // Always update lastAttemptTime and compute next scheduleTime
    try {
      const nextRun = this.cronEngine.getNextRunTime(job.schedule, job.timeZone);

      await this.repo.updateJob(job.name, {
        lastAttemptTime: new Date().toISOString(),
        scheduleTime: nextRun.toISOString(),
      });
    } catch (err) {
      this.logger.error(`Failed to update job ${job.name} after execution`, err);
    }
  }

  private async executeHttpRequest(jobName: string, target: HttpTarget): Promise<boolean> {
    try {
      const requestInit: RequestInit = {
        method: target.httpMethod,
        headers: target.headers ?? {},
      };

      if (target.body) {
        requestInit.body = Buffer.from(target.body, 'base64').toString('utf-8');
      }

      const response = await this.httpClient(target.uri, requestInit);

      if (response.ok) {
        this.logger.info(`Job ${jobName} executed successfully (${response.status})`);

        return true;
      }

      this.logger.warn(`Job ${jobName} returned non-2xx status: ${response.status}`);

      return false;
    } catch (err) {
      this.logger.error(`Job ${jobName} execution failed`, err);

      return false;
    }
  }
}
