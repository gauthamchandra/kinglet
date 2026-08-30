/**
 * Persistence for Pub/Sub topics. CRUD lives in {@link ResourceRepository}.
 *
 * <p>Uniqueness is enforced in the service layer, so the repository does not
 * reject duplicate names — see {@link ResourceRepositoryOptions.rejectDuplicateNames}.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import { ResourceRepository } from '@/core/storage/resource-repository.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import type { TopicRecord } from './types.ts';
import { PUBSUB_TOPICS_TABLE, pubsubTopicsTableSchema } from './types.ts';

export interface ListTopicsResult {
  topics: TopicRecord[];
  nextPageToken?: string | undefined;
}

function buildTopicListPrefix(project: string): string {
  return `projects/${project}/topics/`;
}

export class TopicRepository extends ResourceRepository<TopicRecord> {
  constructor(storage: StorageManager) {
    super(storage, PUBSUB_TOPICS_TABLE, pubsubTopicsTableSchema, 'topic', {
      rejectDuplicateNames: false,
    });
  }

  createTopic(data: Omit<TopicRecord, keyof BaseRecord>): Promise<TopicRecord> {
    return this.create(data);
  }

  getTopicByName(name: string): Promise<TopicRecord | null> {
    return this.getByName(name);
  }

  updateTopic(
    name: string,
    data: Partial<Omit<TopicRecord, keyof BaseRecord>>
  ): Promise<TopicRecord | null> {
    return this.update(name, data);
  }

  deleteTopic(name: string): Promise<boolean> {
    return this.delete(name);
  }

  async listTopics(
    project: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListTopicsResult> {
    const { records, nextPageToken } = await this.listByPrefix(
      buildTopicListPrefix(project),
      pageSize,
      pageToken
    );

    return { topics: records, nextPageToken };
  }
}
