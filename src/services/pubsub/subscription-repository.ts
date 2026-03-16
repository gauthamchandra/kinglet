/**
 * Subscription Repository - persistence layer for Pub/Sub subscriptions
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import type { SubscriptionRecord } from './types.ts';
import { PUBSUB_SUBSCRIPTIONS_TABLE, pubsubSubscriptionsTableSchema } from './types.ts';

export interface ListSubscriptionsResult {
  subscriptions: SubscriptionRecord[];
  nextPageToken?: string;
}

export class SubscriptionRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(PUBSUB_SUBSCRIPTIONS_TABLE, pubsubSubscriptionsTableSchema);
  }

  async createSubscription(
    data: Omit<SubscriptionRecord, keyof BaseRecord>
  ): Promise<SubscriptionRecord> {
    return this.storage.create<SubscriptionRecord>(PUBSUB_SUBSCRIPTIONS_TABLE, data);
  }

  async getSubscriptionByName(name: string): Promise<SubscriptionRecord | null> {
    return this.storage.findFirst<SubscriptionRecord>(PUBSUB_SUBSCRIPTIONS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }

  async listSubscriptions(
    project: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListSubscriptionsResult> {
    const offset = pageToken ? parseInt(pageToken, 10) : 0;
    const limit = pageSize ?? 100;

    const result = await this.storage.find<SubscriptionRecord>(PUBSUB_SUBSCRIPTIONS_TABLE, {
      filter: {
        conditions: [
          { field: 'name', operator: 'like', value: `projects/${project}/subscriptions/%` },
        ],
      },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    const listResult: ListSubscriptionsResult = {
      subscriptions: result.data,
    };

    if (result.hasMore) {
      listResult.nextPageToken = String(offset + limit);
    }

    return listResult;
  }

  async listSubscriptionsByTopic(topicName: string): Promise<SubscriptionRecord[]> {
    const result = await this.storage.find<SubscriptionRecord>(PUBSUB_SUBSCRIPTIONS_TABLE, {
      filter: {
        conditions: [{ field: 'topic', operator: 'eq', value: topicName }],
      },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    return result.data;
  }

  async findActiveSubscriptionsForTopic(topicName: string): Promise<SubscriptionRecord[]> {
    const result = await this.storage.find<SubscriptionRecord>(PUBSUB_SUBSCRIPTIONS_TABLE, {
      filter: {
        conditions: [
          { field: 'topic', operator: 'eq', value: topicName },
          { field: 'detached', operator: 'eq', value: 0 },
        ],
      },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    return result.data;
  }

  async findPushSubscriptions(): Promise<SubscriptionRecord[]> {
    const result = await this.storage.find<SubscriptionRecord>(PUBSUB_SUBSCRIPTIONS_TABLE, {
      filter: {
        conditions: [{ field: 'detached', operator: 'eq', value: 0 }],
      },
    });

    // Filter to only subscriptions with a non-empty pushEndpoint
    return result.data.filter(sub => {
      if (!sub.pushConfig) return false;

      try {
        const config = JSON.parse(sub.pushConfig) as { pushEndpoint?: string };

        return !!config.pushEndpoint;
      } catch {
        return false;
      }
    });
  }

  async updateSubscription(
    name: string,
    data: Partial<Omit<SubscriptionRecord, keyof BaseRecord>>
  ): Promise<SubscriptionRecord | null> {
    const existing = await this.getSubscriptionByName(name);

    if (!existing) {
      return null;
    }

    return this.storage.updateById<SubscriptionRecord>(
      PUBSUB_SUBSCRIPTIONS_TABLE,
      existing.id,
      data
    );
  }

  async deleteSubscription(name: string): Promise<boolean> {
    const existing = await this.getSubscriptionByName(name);

    if (!existing) {
      return false;
    }

    return this.storage.deleteById(PUBSUB_SUBSCRIPTIONS_TABLE, existing.id);
  }
}
