/**
 * Subscription Service - business logic for Pub/Sub subscriptions, publish, pull, and ack
 */

import type { MessageRepository } from './message-repository.ts';
import type { SnapshotRepository } from './snapshot-repository.ts';
import type { SubscriptionRepository } from './subscription-repository.ts';
import type { TopicRepository } from './topic-repository.ts';
import type {
  ListSubscriptionsResponse,
  ListTopicSubscriptionsResponse,
  PublishResponse,
  PullResponse,
  SubscriptionResponse,
} from './types.ts';
import {
  buildSubscriptionName,
  CreateSubscriptionRequestSchema,
  DEFAULT_ACK_DEADLINE_SECONDS,
  DEFAULT_MESSAGE_RETENTION,
  PublishRequestSchema,
  PubSubError,
  subscriptionRecordToResponse,
} from './types.ts';

export class SubscriptionService {
  private subRepo: SubscriptionRepository;
  private topicRepo: TopicRepository;
  private messageRepo: MessageRepository;
  private snapshotRepo: SnapshotRepository | undefined;

  constructor(
    subRepo: SubscriptionRepository,
    topicRepo: TopicRepository,
    messageRepo: MessageRepository,
    snapshotRepo?: SnapshotRepository
  ) {
    this.subRepo = subRepo;
    this.topicRepo = topicRepo;
    this.messageRepo = messageRepo;
    this.snapshotRepo = snapshotRepo;
  }

  async createSubscription(
    project: string,
    subscription: string,
    body: unknown
  ): Promise<SubscriptionResponse> {
    const parsed = CreateSubscriptionRequestSchema.safeParse(body ?? {});

    if (!parsed.success) {
      throw new PubSubError(
        'INVALID_ARGUMENT',
        `Invalid subscription request: ${parsed.error.message}`
      );
    }

    const data = parsed.data;

    // Verify topic exists
    const topic = await this.topicRepo.getTopicByName(data.topic);

    if (!topic) {
      throw new PubSubError('NOT_FOUND', `Topic ${data.topic} not found`);
    }

    const name = buildSubscriptionName(project, subscription);

    // Check for duplicates
    const existing = await this.subRepo.getSubscriptionByName(name);

    if (existing) {
      throw new PubSubError('ALREADY_EXISTS', `Subscription ${name} already exists`);
    }

    const record = await this.subRepo.createSubscription({
      name,
      topic: data.topic,
      pushConfig: data.pushConfig ? JSON.stringify(data.pushConfig) : null,
      bigqueryConfig: data.bigqueryConfig ? JSON.stringify(data.bigqueryConfig) : null,
      cloudStorageConfig: data.cloudStorageConfig ? JSON.stringify(data.cloudStorageConfig) : null,
      ackDeadlineSeconds: data.ackDeadlineSeconds ?? DEFAULT_ACK_DEADLINE_SECONDS,
      retainAckedMessages: data.retainAckedMessages ? 1 : 0,
      messageRetentionDuration: data.messageRetentionDuration ?? DEFAULT_MESSAGE_RETENTION,
      labels: data.labels ? JSON.stringify(data.labels) : null,
      enableMessageOrdering: data.enableMessageOrdering ? 1 : 0,
      expirationPolicy: data.expirationPolicy ? JSON.stringify(data.expirationPolicy) : null,
      filter: data.filter ?? null,
      deadLetterPolicy: data.deadLetterPolicy ? JSON.stringify(data.deadLetterPolicy) : null,
      retryPolicy: data.retryPolicy ? JSON.stringify(data.retryPolicy) : null,
      detached: 0,
      enableExactlyOnceDelivery: data.enableExactlyOnceDelivery ? 1 : 0,
      topicMessageRetentionDuration: null,
      state: 'ACTIVE',
    });

    return subscriptionRecordToResponse(record);
  }

  async getSubscription(name: string): Promise<SubscriptionResponse> {
    const record = await this.subRepo.getSubscriptionByName(name);

    if (!record) {
      throw new PubSubError('NOT_FOUND', `Subscription ${name} not found`);
    }

    return subscriptionRecordToResponse(record);
  }

  async listSubscriptions(
    project: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListSubscriptionsResponse> {
    const result = await this.subRepo.listSubscriptions(project, pageSize, pageToken);

    const response: ListSubscriptionsResponse = {
      subscriptions: result.subscriptions.map(subscriptionRecordToResponse),
    };

    if (result.nextPageToken) {
      response.nextPageToken = result.nextPageToken;
    }

    return response;
  }

  async updateSubscription(name: string, body: unknown): Promise<SubscriptionResponse> {
    const updateBody = body as {
      subscription?: Record<string, unknown>;
      updateMask?: string;
    };

    const subData = updateBody?.subscription ?? {};
    const updateMask = updateBody?.updateMask;

    const updates: Record<string, unknown> = {};

    if (updateMask) {
      const fields = updateMask.split(',').map(f => f.trim());

      for (const field of fields) {
        switch (field) {
          case 'ackDeadlineSeconds':
            if (subData.ackDeadlineSeconds != null) {
              updates.ackDeadlineSeconds = subData.ackDeadlineSeconds;
            }
            break;
          case 'labels':
            updates.labels = subData.labels ? JSON.stringify(subData.labels) : null;
            break;
          case 'pushConfig':
            updates.pushConfig = subData.pushConfig ? JSON.stringify(subData.pushConfig) : null;
            break;
          case 'retainAckedMessages':
            updates.retainAckedMessages = subData.retainAckedMessages ? 1 : 0;
            break;
          case 'messageRetentionDuration':
            updates.messageRetentionDuration = (subData.messageRetentionDuration as string) ?? null;
            break;
          case 'expirationPolicy':
            updates.expirationPolicy = subData.expirationPolicy
              ? JSON.stringify(subData.expirationPolicy)
              : null;
            break;
          case 'deadLetterPolicy':
            updates.deadLetterPolicy = subData.deadLetterPolicy
              ? JSON.stringify(subData.deadLetterPolicy)
              : null;
            break;
          case 'retryPolicy':
            updates.retryPolicy = subData.retryPolicy ? JSON.stringify(subData.retryPolicy) : null;
            break;
          case 'enableExactlyOnceDelivery':
            updates.enableExactlyOnceDelivery = subData.enableExactlyOnceDelivery ? 1 : 0;
            break;
        }
      }
    }

    const updated = await this.subRepo.updateSubscription(name, updates);

    if (!updated) {
      throw new PubSubError('NOT_FOUND', `Subscription ${name} not found`);
    }

    return subscriptionRecordToResponse(updated);
  }

  async deleteSubscription(name: string): Promise<void> {
    const deleted = await this.subRepo.deleteSubscription(name);

    if (!deleted) {
      throw new PubSubError('NOT_FOUND', `Subscription ${name} not found`);
    }

    // Clean up delivered messages
    await this.messageRepo.deleteMessagesBySubscription(name);
  }

  async publish(topicName: string, body: unknown): Promise<PublishResponse> {
    const parsed = PublishRequestSchema.safeParse(body ?? {});

    if (!parsed.success) {
      throw new PubSubError('INVALID_ARGUMENT', `Invalid publish request: ${parsed.error.message}`);
    }

    // Verify topic exists
    const topic = await this.topicRepo.getTopicByName(topicName);

    if (!topic) {
      throw new PubSubError('NOT_FOUND', `Topic ${topicName} not found`);
    }

    // Find all active (non-detached) subscriptions for this topic
    const activeSubs = await this.subRepo.findActiveSubscriptionsForTopic(topicName);
    const subNames = activeSubs.map(s => s.name);

    const messageIds = await this.messageRepo.publishMessages(
      topicName,
      parsed.data.messages,
      subNames
    );

    return { messageIds };
  }

  async pull(subscriptionName: string, body: unknown): Promise<PullResponse> {
    const pullBody = body as { maxMessages?: number; returnImmediately?: boolean } | undefined;
    const maxMessages = pullBody?.maxMessages ?? 100;

    // Verify subscription exists
    const sub = await this.subRepo.getSubscriptionByName(subscriptionName);

    if (!sub) {
      throw new PubSubError('NOT_FOUND', `Subscription ${subscriptionName} not found`);
    }

    if (sub.detached) {
      throw new PubSubError('FAILED_PRECONDITION', `Subscription ${subscriptionName} is detached`);
    }

    const receivedMessages = await this.messageRepo.pullMessages(
      subscriptionName,
      maxMessages,
      sub.ackDeadlineSeconds
    );

    return { receivedMessages };
  }

  async acknowledge(subscriptionName: string, body: unknown): Promise<void> {
    const ackBody = body as { ackIds: string[] };

    // Verify subscription exists
    const sub = await this.subRepo.getSubscriptionByName(subscriptionName);

    if (!sub) {
      throw new PubSubError('NOT_FOUND', `Subscription ${subscriptionName} not found`);
    }

    await this.messageRepo.acknowledgeMessages(subscriptionName, ackBody.ackIds);
  }

  async modifyAckDeadline(subscriptionName: string, body: unknown): Promise<void> {
    const modBody = body as { ackIds: string[]; ackDeadlineSeconds: number };

    // Verify subscription exists
    const sub = await this.subRepo.getSubscriptionByName(subscriptionName);

    if (!sub) {
      throw new PubSubError('NOT_FOUND', `Subscription ${subscriptionName} not found`);
    }

    await this.messageRepo.modifyAckDeadline(
      subscriptionName,
      modBody.ackIds,
      modBody.ackDeadlineSeconds
    );
  }

  async modifyPushConfig(subscriptionName: string, body: unknown): Promise<void> {
    const pushBody = body as { pushConfig?: Record<string, unknown> };

    const sub = await this.subRepo.getSubscriptionByName(subscriptionName);

    if (!sub) {
      throw new PubSubError('NOT_FOUND', `Subscription ${subscriptionName} not found`);
    }

    await this.subRepo.updateSubscription(subscriptionName, {
      pushConfig: pushBody.pushConfig ? JSON.stringify(pushBody.pushConfig) : null,
    });
  }

  async detachSubscription(subscriptionName: string): Promise<void> {
    const sub = await this.subRepo.getSubscriptionByName(subscriptionName);

    if (!sub) {
      throw new PubSubError('NOT_FOUND', `Subscription ${subscriptionName} not found`);
    }

    await this.subRepo.updateSubscription(subscriptionName, { detached: 1 });
  }

  async seek(subscriptionName: string, body: unknown): Promise<void> {
    const seekBody = body as { time?: string; snapshot?: string };

    const sub = await this.subRepo.getSubscriptionByName(subscriptionName);

    if (!sub) {
      throw new PubSubError('NOT_FOUND', `Subscription ${subscriptionName} not found`);
    }

    if (seekBody.time) {
      await this.messageRepo.resetDeliveredMessagesByTime(subscriptionName, seekBody.time);
    } else if (seekBody.snapshot && this.snapshotRepo) {
      const snapshot = await this.snapshotRepo.getSnapshotByName(seekBody.snapshot);

      if (!snapshot) {
        throw new PubSubError('NOT_FOUND', `Snapshot ${seekBody.snapshot} not found`);
      }

      // Use snapshot creation time as the seek point
      const snapshotTime = snapshot.createdAt.toISOString();

      await this.messageRepo.resetDeliveredMessagesByTime(subscriptionName, snapshotTime);
    }
  }

  async listTopicSubscriptions(topicName: string): Promise<ListTopicSubscriptionsResponse> {
    // Verify topic exists
    const topic = await this.topicRepo.getTopicByName(topicName);

    if (!topic) {
      throw new PubSubError('NOT_FOUND', `Topic ${topicName} not found`);
    }

    const subs = await this.subRepo.listSubscriptionsByTopic(topicName);

    return {
      subscriptions: subs.map(s => s.name),
    };
  }
}
