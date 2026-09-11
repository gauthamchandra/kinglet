/**
 * Subscription Service - business logic for Pub/Sub subscriptions, publish, pull, and ack
 */

import { parseDurationSeconds } from '@/shared/utils/duration.ts';
import { messageMatchesFilter, parseAttributeFilter } from './attribute-filter.ts';
import type { MessageRepository } from './message-repository.ts';
import type { SnapshotRepository } from './snapshot-repository.ts';
import type { SubscriptionRepository } from './subscription-repository.ts';
import type { TopicRepository } from './topic-repository.ts';
import type {
  ExpirationPolicy,
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
  defaultExpirationPolicy,
  PublishRequestSchema,
  PubSubError,
  serializePushConfig,
  subscriptionRecordToResponse,
} from './types.ts';

function retentionCutoffIso(retention: string | null | undefined): string | undefined {
  if (retention == null || retention === '') {
    return undefined;
  }

  try {
    const seconds = parseDurationSeconds(retention);

    return new Date(Date.now() - seconds * 1000).toISOString();
  } catch {
    return undefined;
  }
}

function paginateNames(
  names: string[],
  pageSize?: number,
  pageToken?: string
): { items: string[]; nextPageToken?: string } {
  const offset = pageToken != null && pageToken !== '' ? Number.parseInt(pageToken, 10) : 0;
  const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const limit = pageSize != null && pageSize > 0 ? pageSize : names.length;
  const items = names.slice(start, start + limit);
  const nextOffset = start + items.length;

  if (nextOffset < names.length) {
    return { items, nextPageToken: String(nextOffset) };
  }

  return { items };
}

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

    if (data.filter) {
      try {
        parseAttributeFilter(data.filter);
      } catch (err) {
        throw new PubSubError(
          'INVALID_ARGUMENT',
          err instanceof Error ? err.message : 'Invalid subscription filter'
        );
      }
    }

    // Verify topic exists
    const topic = await this.topicRepo.getTopicByName(data.topic);

    if (!topic) {
      throw new PubSubError('NOT_FOUND', `Topic ${data.topic} not found`, data.topic);
    }

    const name = buildSubscriptionName(project, subscription);

    // Check for duplicates
    const existing = await this.subRepo.getSubscriptionByName(name);

    if (existing) {
      throw new PubSubError('ALREADY_EXISTS', `Subscription ${name} already exists`, name);
    }

    const expiration = defaultExpirationPolicy(
      data.expirationPolicy as ExpirationPolicy | null | undefined
    );

    const record = await this.subRepo.createSubscription({
      name,
      topic: data.topic,
      pushConfig: serializePushConfig(data.pushConfig),
      bigqueryConfig: data.bigqueryConfig ? JSON.stringify(data.bigqueryConfig) : null,
      cloudStorageConfig: data.cloudStorageConfig ? JSON.stringify(data.cloudStorageConfig) : null,
      ackDeadlineSeconds: data.ackDeadlineSeconds ?? DEFAULT_ACK_DEADLINE_SECONDS,
      retainAckedMessages: data.retainAckedMessages ? 1 : 0,
      messageRetentionDuration: data.messageRetentionDuration ?? DEFAULT_MESSAGE_RETENTION,
      labels: data.labels ? JSON.stringify(data.labels) : null,
      enableMessageOrdering: data.enableMessageOrdering ? 1 : 0,
      expirationPolicy: expiration ? JSON.stringify(expiration) : null,
      filter: data.filter ?? null,
      deadLetterPolicy: data.deadLetterPolicy ? JSON.stringify(data.deadLetterPolicy) : null,
      retryPolicy: data.retryPolicy ? JSON.stringify(data.retryPolicy) : null,
      detached: 0,
      enableExactlyOnceDelivery: data.enableExactlyOnceDelivery ? 1 : 0,
      topicMessageRetentionDuration: topic.messageRetentionDuration,
      state: 'ACTIVE',
    });

    const retainAfter =
      retentionCutoffIso(topic.messageRetentionDuration) ??
      retentionCutoffIso(record.messageRetentionDuration);

    await this.messageRepo.fanOutExistingMessages(data.topic, name, {
      filter: record.filter,
      retainAfter,
      matchesFilter: messageMatchesFilter,
    });

    return subscriptionRecordToResponse(record);
  }

  async getSubscription(name: string): Promise<SubscriptionResponse> {
    const record = await this.subRepo.getSubscriptionByName(name);

    if (!record) {
      throw new PubSubError('NOT_FOUND', `Subscription ${name} not found`, name);
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

      for (const rawField of fields) {
        const field = rawField.includes('.') ? rawField.split('.').pop() : rawField;
        const normalized =
          field === 'push_config'
            ? 'pushConfig'
            : field === 'ack_deadline_seconds'
              ? 'ackDeadlineSeconds'
              : field === 'retain_acked_messages'
                ? 'retainAckedMessages'
                : field === 'message_retention_duration'
                  ? 'messageRetentionDuration'
                  : field === 'expiration_policy'
                    ? 'expirationPolicy'
                    : field === 'dead_letter_policy'
                      ? 'deadLetterPolicy'
                      : field === 'retry_policy'
                        ? 'retryPolicy'
                        : field === 'enable_exactly_once_delivery'
                          ? 'enableExactlyOnceDelivery'
                          : field === 'enable_message_ordering'
                            ? 'enableMessageOrdering'
                            : field === 'bigquery_config'
                              ? 'bigqueryConfig'
                              : field === 'cloud_storage_config'
                                ? 'cloudStorageConfig'
                                : field;

        switch (normalized) {
          case 'ackDeadlineSeconds':
            if (subData.ackDeadlineSeconds != null) {
              updates.ackDeadlineSeconds = subData.ackDeadlineSeconds;
            }
            break;
          case 'labels':
            updates.labels = subData.labels ? JSON.stringify(subData.labels) : null;
            break;
          case 'pushConfig':
            updates.pushConfig = serializePushConfig(subData.pushConfig);
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
          case 'filter':
            if (subData.filter) {
              try {
                parseAttributeFilter(subData.filter as string);
              } catch (err) {
                throw new PubSubError(
                  'INVALID_ARGUMENT',
                  err instanceof Error ? err.message : 'Invalid subscription filter'
                );
              }
            }

            updates.filter = (subData.filter as string | undefined) ?? null;
            break;
          case 'enableMessageOrdering':
            updates.enableMessageOrdering = subData.enableMessageOrdering ? 1 : 0;
            break;
          case 'bigqueryConfig':
            updates.bigqueryConfig = subData.bigqueryConfig
              ? JSON.stringify(subData.bigqueryConfig)
              : null;
            break;
          case 'cloudStorageConfig':
            updates.cloudStorageConfig = subData.cloudStorageConfig
              ? JSON.stringify(subData.cloudStorageConfig)
              : null;
            break;
        }
      }
    }

    const existing = await this.subRepo.getSubscriptionByName(name);

    if (!existing) {
      throw new PubSubError('NOT_FOUND', `Subscription ${name} not found`, name);
    }

    const updated = await this.subRepo.updateSubscription(name, updates);

    if (!updated) {
      throw new PubSubError('NOT_FOUND', `Subscription ${name} not found`, name);
    }

    if (Object.hasOwn(updates, 'pushConfig') && updated.pushConfig == null) {
      await this.messageRepo.releasePendingLeases(name);
    }

    return subscriptionRecordToResponse(updated);
  }

  async deleteSubscription(name: string): Promise<void> {
    const deleted = await this.subRepo.deleteSubscription(name);

    if (!deleted) {
      throw new PubSubError('NOT_FOUND', `Subscription ${name} not found`, name);
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
      throw new PubSubError('NOT_FOUND', `Topic ${topicName} not found`, topicName);
    }

    const activeSubs = await this.subRepo.findActiveSubscriptionsForTopic(topicName);
    const messageIds: string[] = [];

    for (const message of parsed.data.messages) {
      const matching = activeSubs
        .filter(sub => messageMatchesFilter(message.attributes, sub.filter))
        .map(sub => sub.name);

      const ids = await this.messageRepo.publishMessages(topicName, [message], matching);

      messageIds.push(...ids);
    }

    return { messageIds };
  }

  async pull(subscriptionName: string, body: unknown): Promise<PullResponse> {
    const pullBody = body as { maxMessages?: number; returnImmediately?: boolean } | undefined;
    const maxMessages = pullBody?.maxMessages ?? 100;

    // Verify subscription exists
    const sub = await this.subRepo.getSubscriptionByName(subscriptionName);

    if (!sub) {
      throw new PubSubError(
        'NOT_FOUND',
        `Subscription ${subscriptionName} not found`,
        subscriptionName
      );
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
      throw new PubSubError(
        'NOT_FOUND',
        `Subscription ${subscriptionName} not found`,
        subscriptionName
      );
    }

    await this.messageRepo.acknowledgeMessages(subscriptionName, ackBody.ackIds);
  }

  async modifyAckDeadline(subscriptionName: string, body: unknown): Promise<void> {
    const modBody = body as { ackIds: string[]; ackDeadlineSeconds: number };

    // Verify subscription exists
    const sub = await this.subRepo.getSubscriptionByName(subscriptionName);

    if (!sub) {
      throw new PubSubError(
        'NOT_FOUND',
        `Subscription ${subscriptionName} not found`,
        subscriptionName
      );
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
      throw new PubSubError(
        'NOT_FOUND',
        `Subscription ${subscriptionName} not found`,
        subscriptionName
      );
    }

    const nextPushConfig = serializePushConfig(pushBody.pushConfig);

    await this.subRepo.updateSubscription(subscriptionName, {
      pushConfig: nextPushConfig,
    });

    if (nextPushConfig == null) {
      await this.messageRepo.releasePendingLeases(subscriptionName);
    }
  }

  async detachSubscription(subscriptionName: string): Promise<void> {
    const sub = await this.subRepo.getSubscriptionByName(subscriptionName);

    if (!sub) {
      throw new PubSubError(
        'NOT_FOUND',
        `Subscription ${subscriptionName} not found`,
        subscriptionName
      );
    }

    await this.subRepo.updateSubscription(subscriptionName, { detached: 1 });
  }

  async seek(subscriptionName: string, body: unknown): Promise<void> {
    const seekBody = body as { time?: string; snapshot?: string };

    const sub = await this.subRepo.getSubscriptionByName(subscriptionName);

    if (!sub) {
      throw new PubSubError(
        'NOT_FOUND',
        `Subscription ${subscriptionName} not found`,
        subscriptionName
      );
    }

    if (seekBody.time) {
      await this.messageRepo.resetDeliveredMessagesByTime(
        subscriptionName,
        seekBody.time,
        sub.retainAckedMessages === 1
      );
    } else if (seekBody.snapshot && this.snapshotRepo) {
      const snapshot = await this.snapshotRepo.getSnapshotByName(seekBody.snapshot);

      if (!snapshot) {
        throw new PubSubError(
          'NOT_FOUND',
          `Snapshot ${seekBody.snapshot} not found`,
          seekBody.snapshot
        );
      }

      // Use snapshot creation time as the seek point
      const snapshotTime = snapshot.createdAt.toISOString();

      await this.messageRepo.resetDeliveredMessagesByTime(
        subscriptionName,
        snapshotTime,
        sub.retainAckedMessages === 1
      );
    }
  }

  async listTopicSubscriptions(
    topicName: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListTopicSubscriptionsResponse> {
    // Verify topic exists
    const topic = await this.topicRepo.getTopicByName(topicName);

    if (!topic) {
      throw new PubSubError('NOT_FOUND', `Topic ${topicName} not found`, topicName);
    }

    const subs = await this.subRepo.listSubscriptionsByTopic(topicName);
    const paged = paginateNames(
      subs.map(s => s.name),
      pageSize,
      pageToken
    );
    const response: ListTopicSubscriptionsResponse = {
      subscriptions: paged.items,
    };

    if (paged.nextPageToken) {
      response.nextPageToken = paged.nextPageToken;
    }

    return response;
  }
}
