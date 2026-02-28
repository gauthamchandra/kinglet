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
import type { HttpTarget, JobRecord } from './types.ts';

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
    const target: HttpTarget = JSON.parse(job.httpTarget);

    this.logger.info(`Executing job ${job.name} -> ${target.httpMethod} ${target.uri}`);

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
        this.logger.info(`Job ${job.name} executed successfully (${response.status})`);
      } else {
        this.logger.warn(`Job ${job.name} returned non-2xx status: ${response.status}`);
      }
    } catch (err) {
      this.logger.error(`Job ${job.name} execution failed`, err);
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
}
