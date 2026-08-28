/**
 * Topic Repository - persistence layer for Pub/Sub topics
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { DEFAULT_LIST_PAGE_SIZE, parseOffsetToken } from '@/shared/utils/pagination.ts';
import type { TopicRecord } from './types.ts';
import { PUBSUB_TOPICS_TABLE, pubsubTopicsTableSchema } from './types.ts';

export interface ListTopicsResult {
  topics: TopicRecord[];
  nextPageToken?: string;
}

export class TopicRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(PUBSUB_TOPICS_TABLE, pubsubTopicsTableSchema);
  }

  async createTopic(data: Omit<TopicRecord, keyof BaseRecord>): Promise<TopicRecord> {
    return this.storage.create<TopicRecord>(PUBSUB_TOPICS_TABLE, data);
  }

  async getTopicByName(name: string): Promise<TopicRecord | null> {
    return this.storage.findFirst<TopicRecord>(PUBSUB_TOPICS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }

  async listTopics(
    project: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListTopicsResult> {
    const offset = parseOffsetToken(pageToken);
    const limit = pageSize ?? DEFAULT_LIST_PAGE_SIZE;

    const result = await this.storage.find<TopicRecord>(PUBSUB_TOPICS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'like', value: `projects/${project}/topics/%` }],
      },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    const listResult: ListTopicsResult = {
      topics: result.data,
    };

    if (result.hasMore) {
      listResult.nextPageToken = String(offset + limit);
    }

    return listResult;
  }

  async updateTopic(
    name: string,
    data: Partial<Omit<TopicRecord, keyof BaseRecord>>
  ): Promise<TopicRecord | null> {
    const existing = await this.getTopicByName(name);

    if (!existing) {
      return null;
    }

    return this.storage.updateById<TopicRecord>(PUBSUB_TOPICS_TABLE, existing.id, data);
  }

  async deleteTopic(name: string): Promise<boolean> {
    const existing = await this.getTopicByName(name);

    if (!existing) {
      return false;
    }

    return this.storage.deleteById(PUBSUB_TOPICS_TABLE, existing.id);
  }
}
