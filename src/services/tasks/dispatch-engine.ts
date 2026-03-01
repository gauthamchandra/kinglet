/**
 * Dispatch Engine - rate-limited task dispatcher for Cloud Tasks
 *
 * Polls for dispatchable tasks across all RUNNING queues and
 * dispatches them with token-bucket rate limiting and retry support.
 */

import type { Logger } from '@/shared/utils/logger.ts';
import type { QueueRepository } from './queue-repository.ts';
import type { TaskRepository } from './task-repository.ts';
import { TokenBucket } from './token-bucket.ts';
import {
  parseDurationSeconds,
  TaskStatus,
  DEFAULT_RETRY_CONFIG,
  TaskRetryConfigSchema,
} from './types.ts';
import type { QueueRecord, TaskRecord, TaskRetryConfig, TaskHttpRequest } from './types.ts';

const DEFAULT_DISPATCH_TIMEOUT_MS = 600_000; // 10 minutes fallback

type HttpClient = (url: string, init: RequestInit) => Promise<Response>;

export class DispatchEngine {
  private queueRepo: QueueRepository;
  private taskRepo: TaskRepository;
  private logger: Logger;
  private httpClient: HttpClient;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private buckets: Map<string, TokenBucket> = new Map();
  private tombstoneCleanupCounter = 0;
  private static readonly TOMBSTONE_CLEANUP_INTERVAL = 60;

  constructor(
    queueRepo: QueueRepository,
    taskRepo: TaskRepository,
    logger: Logger,
    httpClient?: HttpClient
  ) {
    this.queueRepo = queueRepo;
    this.taskRepo = taskRepo;
    this.logger = logger;
    this.httpClient = httpClient ?? fetch;
  }

  start(pollIntervalMs: number = 1000): void {
    if (this.timerId !== null) {
      return;
    }

    this.logger.info(`Starting dispatch engine with ${pollIntervalMs}ms poll interval`);

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

    this.logger.info('Dispatch engine stopped');
  }

  async tick(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const runningQueues = await this.queueRepo.findRunningQueues();

      const dispatchPromises: Promise<void>[] = [];

      for (const queue of runningQueues) {
        const bucket = this.getOrCreateBucket(queue);

        bucket.refill();

        const tasks = await this.taskRepo.findDispatchableTasks(queue.name, 10);

        for (const task of tasks) {
          if (!bucket.acquire()) {
            break; // Rate limited, try again next tick
          }

          dispatchPromises.push(this.dispatchTask(task, queue).finally(() => bucket.release()));
        }
      }

      await Promise.all(dispatchPromises);

      this.tombstoneCleanupCounter++;

      if (this.tombstoneCleanupCounter >= DispatchEngine.TOMBSTONE_CLEANUP_INTERVAL) {
        this.tombstoneCleanupCounter = 0;

        try {
          const cleaned = await this.taskRepo.cleanupExpiredTombstones();

          if (cleaned > 0) {
            this.logger.info(`Cleaned up ${cleaned} expired tombstones`);
          }
        } catch (err) {
          this.logger.error('Error cleaning up tombstones', err);
        }
      }
    } catch (err) {
      this.logger.error('Error during tick', err);
    } finally {
      this.running = false;
    }
  }

  async dispatchTask(task: TaskRecord, queue: QueueRecord): Promise<void> {
    const retryConfig = this.parseRetryConfig(queue.retryConfig);
    const maxAttempts = retryConfig.maxAttempts === -1 ? Infinity : retryConfig.maxAttempts;
    const minBackoffSec = parseDurationSeconds(retryConfig.minBackoff);
    const maxBackoffSec = parseDurationSeconds(retryConfig.maxBackoff);

    const attempt = task.dispatchCount;

    let httpRequest: TaskHttpRequest;

    try {
      httpRequest = JSON.parse(task.httpRequest) as TaskHttpRequest;
    } catch (err) {
      this.logger.error(`Task ${task.name} has invalid httpRequest JSON`, err);

      return;
    }

    const timeoutMs = this.getDispatchTimeoutMs(task.dispatchDeadline);

    await this.taskRepo.updateTask(task.name, {
      status: TaskStatus.DISPATCHING,
      dispatchCount: task.dispatchCount + 1,
    });

    const dispatchTime = new Date().toISOString();

    const success = await this.executeHttpRequest(task.name, httpRequest, timeoutMs);

    const responseTime = new Date().toISOString();

    const attemptRecord = JSON.stringify({
      scheduleTime: task.scheduleTime,
      dispatchTime,
      responseTime,
      responseStatus: success ? 200 : 500,
    });

    if (success) {
      this.logger.info(`Task ${task.name} dispatched successfully`);

      const tombstoneTtlSeconds = parseDurationSeconds(queue.tombstoneTtl);
      const tombstoneExpiry = new Date(Date.now() + tombstoneTtlSeconds * 1000).toISOString();

      await this.taskRepo.updateTask(task.name, {
        status: TaskStatus.TOMBSTONE,
        tombstoneExpiry,
        responseCount: task.responseCount + 1,
        lastAttempt: attemptRecord,
        ...(task.firstAttempt === null ? { firstAttempt: attemptRecord } : {}),
      });

      return;
    }

    const nextAttempt = attempt + 1;

    if (nextAttempt >= maxAttempts) {
      this.logger.warn(`Task ${task.name} exhausted ${maxAttempts} attempts, marking as FAILED`);

      await this.taskRepo.updateTask(task.name, {
        status: TaskStatus.FAILED,
        responseCount: task.responseCount + 1,
        lastAttempt: attemptRecord,
        ...(task.firstAttempt === null ? { firstAttempt: attemptRecord } : {}),
      });

      return;
    }

    const backoffSec = this.computeBackoffSeconds(
      attempt,
      minBackoffSec,
      maxBackoffSec,
      retryConfig.maxDoublings
    );

    const nextScheduleTime = new Date(Date.now() + backoffSec * 1000).toISOString();

    this.logger.info(
      `Task ${task.name} failed, retrying in ${backoffSec}s (attempt ${nextAttempt + 1}/${maxAttempts})`
    );

    await this.taskRepo.updateTask(task.name, {
      status: TaskStatus.PENDING,
      scheduleTime: nextScheduleTime,
      responseCount: task.responseCount + 1,
      lastAttempt: attemptRecord,
      ...(task.firstAttempt === null ? { firstAttempt: attemptRecord } : {}),
    });
  }

  /**
   * Compute exponential backoff: minBackoff * 2^min(attempt, maxDoublings), capped at maxBackoff
   */
  computeBackoffSeconds(
    attempt: number,
    minBackoff: number,
    maxBackoff: number,
    maxDoublings: number
  ): number {
    const exponent = Math.min(attempt, maxDoublings);
    const backoff = minBackoff * Math.pow(2, exponent);

    return Math.min(backoff, maxBackoff);
  }

  cleanupBucket(queueName: string): void {
    this.buckets.delete(queueName);
  }

  private getOrCreateBucket(queue: QueueRecord): TokenBucket {
    let bucket = this.buckets.get(queue.name);

    if (!bucket) {
      const rateLimits = JSON.parse(queue.rateLimits) as {
        maxDispatchesPerSecond: number;
        maxBurstSize: number;
        maxConcurrentDispatches: number;
      };

      bucket = new TokenBucket({
        maxTokens: rateLimits.maxBurstSize,
        refillRate: rateLimits.maxDispatchesPerSecond,
        maxConcurrent: rateLimits.maxConcurrentDispatches,
      });

      this.buckets.set(queue.name, bucket);
    }

    return bucket;
  }

  private parseRetryConfig(retryConfigJson: string): TaskRetryConfig {
    try {
      const parsed = TaskRetryConfigSchema.safeParse(JSON.parse(retryConfigJson));

      return parsed.success ? parsed.data : DEFAULT_RETRY_CONFIG;
    } catch {
      return DEFAULT_RETRY_CONFIG;
    }
  }

  private getDispatchTimeoutMs(dispatchDeadline: string): number {
    try {
      return parseDurationSeconds(dispatchDeadline) * 1000;
    } catch {
      return DEFAULT_DISPATCH_TIMEOUT_MS;
    }
  }

  private async executeHttpRequest(
    taskName: string,
    httpRequest: TaskHttpRequest,
    timeoutMs: number
  ): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const requestInit: RequestInit = {
        method: httpRequest.httpMethod,
        headers: httpRequest.headers ?? {},
        signal: controller.signal,
      };

      if (httpRequest.body) {
        requestInit.body = Buffer.from(httpRequest.body, 'base64').toString('utf-8');
      }

      const response = await this.httpClient(httpRequest.url, requestInit);

      if (response.ok) {
        this.logger.info(`Task ${taskName} executed successfully (${response.status})`);

        return true;
      }

      this.logger.warn(`Task ${taskName} returned non-2xx status: ${response.status}`);

      return false;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        this.logger.warn(`Task ${taskName} timed out after ${timeoutMs}ms`);
      } else {
        this.logger.error(`Task ${taskName} execution failed`, err);
      }

      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
