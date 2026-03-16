/**
 * Delivery Engine - background push delivery for Cloud Pub/Sub
 *
 * Polls for push subscriptions with pending messages and delivers
 * them to configured HTTP endpoints. Auto-acks on success, retries
 * with backoff on failure, and routes to dead-letter topics when
 * delivery attempts are exhausted.
 */

import { parseDurationSeconds } from '@/shared/utils/duration.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import type { MessageRepository, PublishMessageInput } from './message-repository.ts';
import type { SubscriptionRepository } from './subscription-repository.ts';
import type { DeadLetterPolicy, PushConfig, RetryPolicy } from './types.ts';

type HttpClient = (url: string, init: RequestInit) => Promise<Response>;
type PublishFn = (topicName: string, messages: PublishMessageInput[]) => Promise<void>;

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_CLEANUP_INTERVAL_TICKS = 60;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MIN_BACKOFF_SECONDS = 10;
const DEFAULT_MAX_BACKOFF_SECONDS = 600;

export interface DeliveryEngineOptions {
  httpClient?: HttpClient;
  publishFn?: PublishFn;
  cleanupIntervalTicks?: number;
}

export class DeliveryEngine {
  private subRepo: SubscriptionRepository;
  private messageRepo: MessageRepository;
  private logger: Logger;
  private httpClient: HttpClient;
  private publishFn: PublishFn | undefined;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private cleanupCounter = 0;
  private cleanupIntervalTicks: number;

  constructor(
    subRepo: SubscriptionRepository,
    messageRepo: MessageRepository,
    logger: Logger,
    options?: DeliveryEngineOptions
  ) {
    this.subRepo = subRepo;
    this.messageRepo = messageRepo;
    this.logger = logger;
    this.httpClient = options?.httpClient ?? fetch;
    this.publishFn = options?.publishFn;
    this.cleanupIntervalTicks = options?.cleanupIntervalTicks ?? DEFAULT_CLEANUP_INTERVAL_TICKS;
  }

  start(pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
    if (this.timerId !== null) {
      return;
    }

    this.logger.info(`Starting delivery engine with ${pollIntervalMs}ms poll interval`);

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

    this.logger.info('Delivery engine stopped');
  }

  async tick(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const pushSubscriptions = await this.subRepo.findPushSubscriptions();

      for (const sub of pushSubscriptions) {
        const pushConfig = this.parsePushConfig(sub.pushConfig);

        if (!pushConfig?.pushEndpoint) continue;

        const deadLetterPolicy = this.parseDeadLetterPolicy(sub.deadLetterPolicy);
        const retryPolicy = this.parseRetryPolicy(sub.retryPolicy);

        const deliverable = await this.messageRepo.findPushDeliverableMessages(
          sub.name,
          DEFAULT_BATCH_SIZE
        );

        for (const { delivered, message } of deliverable) {
          // Check if max delivery attempts exceeded
          if (
            deadLetterPolicy?.maxDeliveryAttempts != null &&
            delivered.deliveryAttempt >= deadLetterPolicy.maxDeliveryAttempts
          ) {
            await this.routeToDeadLetter(deadLetterPolicy, message, delivered.ackId, sub.name);
            continue;
          }

          await this.pushMessage(
            pushConfig.pushEndpoint,
            sub.name,
            delivered,
            message,
            retryPolicy
          );
        }
      }

      this.cleanupCounter++;

      if (this.cleanupCounter >= this.cleanupIntervalTicks) {
        this.cleanupCounter = 0;

        try {
          const cleaned = await this.messageRepo.cleanupAckedMessages();

          if (cleaned > 0) {
            this.logger.info(`Cleaned up ${cleaned} acked messages`);
          }
        } catch (err) {
          this.logger.error('Error cleaning up acked messages', err);
        }
      }
    } catch (err) {
      this.logger.error('Error during delivery tick', err);
    } finally {
      this.running = false;
    }
  }

  private async pushMessage(
    pushEndpoint: string,
    subscriptionName: string,
    delivered: { id: string; ackId: string; deliveryAttempt: number },
    message: {
      messageId: string;
      data: string | null;
      attributes: string | null;
      publishTime: string;
      orderingKey: string | null;
    },
    retryPolicy: RetryPolicy | undefined
  ): Promise<void> {
    const payload = this.buildPushPayload(subscriptionName, message);

    try {
      const response = await this.httpClient(pushEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        await this.messageRepo.acknowledgeMessages(subscriptionName, [delivered.ackId]);

        this.logger.info(
          `Pushed message ${message.messageId} to ${subscriptionName} (${response.status})`
        );
      } else {
        await this.handlePushFailure(delivered, retryPolicy);

        this.logger.warn(`Push to ${subscriptionName} failed with status ${response.status}`);
      }
    } catch (err) {
      await this.handlePushFailure(delivered, retryPolicy);

      this.logger.error(`Push to ${subscriptionName} failed with error`, err);
    }
  }

  private async handlePushFailure(
    delivered: { id: string; deliveryAttempt: number },
    retryPolicy: RetryPolicy | undefined
  ): Promise<void> {
    let backoffSeconds: number;

    try {
      backoffSeconds = this.computeBackoff(delivered.deliveryAttempt, retryPolicy);
    } catch {
      backoffSeconds = DEFAULT_MIN_BACKOFF_SECONDS * 2 ** delivered.deliveryAttempt;
      backoffSeconds = Math.min(backoffSeconds, DEFAULT_MAX_BACKOFF_SECONDS);
    }

    const newDeadline = new Date(Date.now() + backoffSeconds * 1000).toISOString();

    await this.messageRepo.incrementDeliveryAttempt(delivered.id, newDeadline);
  }

  private async routeToDeadLetter(
    deadLetterPolicy: DeadLetterPolicy,
    message: { data: string | null; attributes: string | null; orderingKey: string | null },
    ackId: string,
    subscriptionName: string
  ): Promise<void> {
    if (!deadLetterPolicy.deadLetterTopic || !this.publishFn) {
      // No dead-letter topic configured or no publish function, just ack
      await this.messageRepo.acknowledgeMessages(subscriptionName, [ackId]);

      return;
    }

    try {
      const dlMessage: PublishMessageInput = {
        data: message.data ?? undefined,
        attributes: message.attributes
          ? (JSON.parse(message.attributes) as Record<string, string>)
          : undefined,
        orderingKey: message.orderingKey ?? undefined,
      };

      await this.publishFn(deadLetterPolicy.deadLetterTopic, [dlMessage]);
      await this.messageRepo.acknowledgeMessages(subscriptionName, [ackId]);

      this.logger.info(`Routed message to dead-letter topic ${deadLetterPolicy.deadLetterTopic}`);
    } catch (err) {
      this.logger.error('Error routing to dead-letter topic', err);
    }
  }

  private buildPushPayload(
    subscriptionName: string,
    message: {
      messageId: string;
      data: string | null;
      attributes: string | null;
      publishTime: string;
      orderingKey: string | null;
    }
  ): Record<string, unknown> {
    const msg: Record<string, unknown> = {
      messageId: message.messageId,
      publishTime: message.publishTime,
    };

    if (message.data != null) {
      msg.data = message.data;
    }

    if (message.attributes) {
      try {
        msg.attributes = JSON.parse(message.attributes) as Record<string, string>;
      } catch {
        // Skip malformed attributes rather than crashing the delivery loop
      }
    }

    if (message.orderingKey) {
      msg.orderingKey = message.orderingKey;
    }

    return {
      message: msg,
      subscription: subscriptionName,
    };
  }

  private computeBackoff(attempt: number, retryPolicy: RetryPolicy | undefined): number {
    const minBackoff = retryPolicy?.minimumBackoff
      ? parseDurationSeconds(retryPolicy.minimumBackoff)
      : DEFAULT_MIN_BACKOFF_SECONDS;

    const maxBackoff = retryPolicy?.maximumBackoff
      ? parseDurationSeconds(retryPolicy.maximumBackoff)
      : DEFAULT_MAX_BACKOFF_SECONDS;

    const backoff = minBackoff * 2 ** attempt;

    return Math.min(backoff, maxBackoff);
  }

  private parsePushConfig(raw: string | null): PushConfig | undefined {
    if (!raw) return undefined;

    try {
      return JSON.parse(raw) as PushConfig;
    } catch {
      return undefined;
    }
  }

  private parseDeadLetterPolicy(raw: string | null): DeadLetterPolicy | undefined {
    if (!raw) return undefined;

    try {
      return JSON.parse(raw) as DeadLetterPolicy;
    } catch {
      return undefined;
    }
  }

  private parseRetryPolicy(raw: string | null): RetryPolicy | undefined {
    if (!raw) return undefined;

    try {
      return JSON.parse(raw) as RetryPolicy;
    } catch {
      return undefined;
    }
  }
}
