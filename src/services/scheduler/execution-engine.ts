/**
 * Execution Engine - timer-based job runner for Cloud Scheduler
 *
 * Polls for due jobs and executes HTTP or Pub/Sub targets.
 * TODO: Add App Engine target support
 */

import type { Logger } from '@/shared/utils/logger.ts';
import type { CronEngine } from './cron-engine.ts';
import type { JobRepository } from './repository.ts';
import type { HttpTarget, JobRecord, PubsubTarget, RetryConfig } from './types.ts';
import {
  DEFAULT_RETRY_CONFIG,
  HttpTargetSchema,
  mergeRetryConfig,
  normalizeHttpTarget,
  PubsubTargetSchema,
  parseDurationSeconds,
  RetryConfigSchema,
} from './types.ts';

type HttpClient = (url: string, init: RequestInit) => Promise<Response>;
type PubsubPublisher = (target: PubsubTarget) => Promise<boolean>;

export interface ExecutionEngineOptions {
  httpClient?: HttpClient;
  pubsubPublisher?: PubsubPublisher;
  kingletHttpPort?: number;
}

function resolveKingletHttpPort(): number {
  const fromEnv = process.env.HTTP_PORT ?? process.env.PORT;

  if (fromEnv != null) {
    const parsed = Number(fromEnv);

    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return 8765;
}

export function buildPubsubPublishUrl(topicName: string, port: number): string | null {
  const match = /^projects\/([^/]+)\/topics\/([^/]+)$/.exec(topicName);

  if (!match) {
    return null;
  }

  const [, project, topic] = match;

  return `http://127.0.0.1:${port}/v1/projects/${project}/topics/${topic}:publish`;
}

export function createDefaultPubsubPublisher(port: number): PubsubPublisher {
  return async (target: PubsubTarget): Promise<boolean> => {
    const url = buildPubsubPublishUrl(target.topicName, port);

    if (url == null) {
      return false;
    }

    const message: Record<string, unknown> = {};

    if (target.data != null) {
      message.data = target.data;
    }

    if (target.attributes != null) {
      message.attributes = target.attributes;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [message] }),
      });

      return response.ok;
    } catch {
      return false;
    }
  };
}

function parseRetryConfig(raw: string): RetryConfig {
  try {
    const parsed = RetryConfigSchema.safeParse(JSON.parse(raw));

    return parsed.success
      ? mergeRetryConfig(parsed.data, DEFAULT_RETRY_CONFIG)
      : DEFAULT_RETRY_CONFIG;
  } catch {
    return DEFAULT_RETRY_CONFIG;
  }
}

export class ExecutionEngine {
  private repo: JobRepository;
  private cronEngine: CronEngine;
  private logger: Logger;
  private httpClient: HttpClient;
  private pubsubPublisher: PubsubPublisher;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    repo: JobRepository,
    cronEngine: CronEngine,
    logger: Logger,
    options: ExecutionEngineOptions = {}
  ) {
    this.repo = repo;
    this.cronEngine = cronEngine;
    this.logger = logger;
    this.httpClient = options.httpClient ?? fetch;

    const port = options.kingletHttpPort ?? resolveKingletHttpPort();

    this.pubsubPublisher = options.pubsubPublisher ?? createDefaultPubsubPublisher(port);
  }

  start(pollIntervalMs: number = 60000): void {
    if (this.timerId !== null) {
      return;
    }

    this.logger.info(`Starting execution engine with ${pollIntervalMs}ms poll interval`);

    this.timerId = setInterval(() => {
      void this.tick();
    }, pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }

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
        try {
          await this.executeJob(job);
        } catch (err) {
          this.logger.error(`Error executing job ${job.name}`, err);
        }
      }
    } catch (err) {
      this.logger.error('Error during tick', err);
    } finally {
      this.running = false;
    }
  }

  async executeJob(job: JobRecord): Promise<void> {
    if (job.pubsubTarget) {
      await this.executePubsubJob(job);

      return;
    }

    if (!job.httpTarget) {
      this.logger.error(`Job ${job.name} has no execution target`);

      return;
    }

    let target: HttpTarget;

    try {
      const parsed = HttpTargetSchema.safeParse(JSON.parse(job.httpTarget));

      if (!parsed.success) {
        this.logger.error(`Job ${job.name} has invalid httpTarget: ${parsed.error.message}`);

        return;
      }

      target = normalizeHttpTarget(parsed.data);
    } catch (err) {
      this.logger.error(`Job ${job.name} has invalid httpTarget JSON`, err);

      return;
    }

    const retryConfig = parseRetryConfig(job.retryConfig);

    this.logger.info(`Executing job ${job.name} -> ${target.httpMethod} ${target.uri}`);

    await this.runWithRetries(job.name, retryConfig, () =>
      this.executeHttpRequest(job.name, target)
    );
    await this.updateJobSchedule(job);
  }

  private async executePubsubJob(job: JobRecord): Promise<void> {
    let target: PubsubTarget;

    try {
      const parsed = PubsubTargetSchema.safeParse(JSON.parse(job.pubsubTarget as string));

      if (!parsed.success) {
        this.logger.error(`Job ${job.name} has invalid pubsubTarget: ${parsed.error.message}`);

        return;
      }

      target = {
        topicName: parsed.data.topicName,
        ...(parsed.data.data != null ? { data: parsed.data.data } : {}),
        ...(parsed.data.attributes != null ? { attributes: parsed.data.attributes } : {}),
      };
    } catch (err) {
      this.logger.error(`Job ${job.name} has invalid pubsubTarget JSON`, err);

      return;
    }

    const retryConfig = parseRetryConfig(job.retryConfig);

    this.logger.info(`Executing job ${job.name} -> Pub/Sub ${target.topicName}`);

    await this.runWithRetries(job.name, retryConfig, () =>
      this.executePubsubPublish(job.name, target)
    );
    await this.updateJobSchedule(job);
  }

  private async runWithRetries(
    jobName: string,
    retryConfig: RetryConfig,
    attemptFn: () => Promise<boolean>
  ): Promise<void> {
    const maxAttempts = 1 + retryConfig.retryCount;
    const minBackoffMs = parseDurationSeconds(retryConfig.minBackoffDuration) * 1000;
    const maxBackoffMs = parseDurationSeconds(retryConfig.maxBackoffDuration) * 1000;
    const maxRetryDurationMs = parseDurationSeconds(retryConfig.maxRetryDuration) * 1000;
    const startTime = Date.now();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const success = await attemptFn();

      if (success) {
        return;
      }

      const isLastAttempt = attempt >= maxAttempts - 1;

      if (isLastAttempt) {
        return;
      }

      if (maxRetryDurationMs > 0 && Date.now() - startTime >= maxRetryDurationMs) {
        this.logger.warn(`Job ${jobName} exceeded maxRetryDuration, stopping retries`);

        return;
      }

      const cappedExponent = Math.min(attempt, retryConfig.maxDoublings);
      const backoffMs = Math.min(minBackoffMs * 2 ** cappedExponent, maxBackoffMs);

      this.logger.info(
        `Job ${jobName} retrying in ${backoffMs}ms (attempt ${attempt + 2}/${maxAttempts})`
      );

      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }

  private async executePubsubPublish(jobName: string, target: PubsubTarget): Promise<boolean> {
    try {
      const success = await this.pubsubPublisher(target);

      if (!success) {
        this.logger.warn(`Job ${jobName} Pub/Sub publish failed`);
      }

      return success;
    } catch (err) {
      this.logger.error(`Job ${jobName} Pub/Sub publish failed`, err);

      return false;
    }
  }

  private async updateJobSchedule(job: JobRecord): Promise<void> {
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
