/**
 * Persistence for Pub/Sub subscriptions. CRUD lives in {@link ResourceRepository}.
 *
 * <p>Uniqueness is enforced in the service layer, so the repository does not
 * reject duplicate names — see {@link ResourceRepositoryOptions.rejectDuplicateNames}.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import { ResourceRepository } from '@/core/storage/resource-repository.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import type { SubscriptionRecord } from './types.ts';
import { PUBSUB_SUBSCRIPTIONS_TABLE, pubsubSubscriptionsTableSchema } from './types.ts';

export interface ListSubscriptionsResult {
  subscriptions: SubscriptionRecord[];
  nextPageToken?: string | undefined;
}

function buildSubscriptionListPrefix(project: string): string {
  return `projects/${project}/subscriptions/`;
}

export class SubscriptionRepository extends ResourceRepository<SubscriptionRecord> {
  constructor(storage: StorageManager) {
    super(storage, PUBSUB_SUBSCRIPTIONS_TABLE, pubsubSubscriptionsTableSchema, 'subscription', {
      rejectDuplicateNames: false,
    });
  }

  createSubscription(
    data: Omit<SubscriptionRecord, keyof BaseRecord>
  ): Promise<SubscriptionRecord> {
    return this.create(data);
  }

  getSubscriptionByName(name: string): Promise<SubscriptionRecord | null> {
    return this.getByName(name);
  }

  updateSubscription(
    name: string,
    data: Partial<Omit<SubscriptionRecord, keyof BaseRecord>>
  ): Promise<SubscriptionRecord | null> {
    return this.update(name, data);
  }

  deleteSubscription(name: string): Promise<boolean> {
    return this.delete(name);
  }

  async listSubscriptions(
    project: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListSubscriptionsResult> {
    const { records, nextPageToken } = await this.listByPrefix(
      buildSubscriptionListPrefix(project),
      pageSize,
      pageToken
    );

    return { subscriptions: records, nextPageToken };
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
}
