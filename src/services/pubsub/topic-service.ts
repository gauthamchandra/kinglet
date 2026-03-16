/**
 * Topic Service - business logic for Pub/Sub topic CRUD
 */

import type { MessageRepository } from './message-repository.ts';
import type { TopicRepository } from './topic-repository.ts';
import type { ListTopicsResponse, TopicResponse } from './types.ts';
import {
  buildTopicName,
  CreateTopicRequestSchema,
  PubSubError,
  topicRecordToResponse,
  topicRequestToRecord,
} from './types.ts';

export class TopicService {
  private repo: TopicRepository;
  private messageRepo: MessageRepository;

  constructor(repo: TopicRepository, messageRepo: MessageRepository) {
    this.repo = repo;
    this.messageRepo = messageRepo;
  }

  async createTopic(project: string, topic: string, body: unknown): Promise<TopicResponse> {
    const parsed = CreateTopicRequestSchema.safeParse(body ?? {});

    if (!parsed.success) {
      throw new PubSubError('INVALID_ARGUMENT', `Invalid topic request: ${parsed.error.message}`);
    }

    const name = buildTopicName(project, topic);

    const existing = await this.repo.getTopicByName(name);

    if (existing) {
      throw new PubSubError('ALREADY_EXISTS', `Topic ${name} already exists`);
    }

    const record = topicRequestToRecord(name, parsed.data as Record<string, unknown>);
    const created = await this.repo.createTopic(record);

    return topicRecordToResponse(created);
  }

  async getTopic(name: string): Promise<TopicResponse> {
    const record = await this.repo.getTopicByName(name);

    if (!record) {
      throw new PubSubError('NOT_FOUND', `Topic ${name} not found`);
    }

    return topicRecordToResponse(record);
  }

  async listTopics(
    project: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListTopicsResponse> {
    const result = await this.repo.listTopics(project, pageSize, pageToken);

    const response: ListTopicsResponse = {
      topics: result.topics.map(topicRecordToResponse),
    };

    if (result.nextPageToken) {
      response.nextPageToken = result.nextPageToken;
    }

    return response;
  }

  async updateTopic(name: string, body: unknown): Promise<TopicResponse> {
    const updateBody = body as {
      topic?: Record<string, unknown>;
      updateMask?: string;
    };

    const topicData = updateBody?.topic ?? {};
    const updateMask = updateBody?.updateMask;

    const updates: Record<string, unknown> = {};

    if (updateMask) {
      const fields = updateMask.split(',').map(f => f.trim());

      for (const field of fields) {
        switch (field) {
          case 'labels':
            updates.labels = topicData.labels ? JSON.stringify(topicData.labels) : null;
            break;
          case 'messageRetentionDuration':
            updates.messageRetentionDuration =
              (topicData.messageRetentionDuration as string) ?? null;
            break;
          case 'schemaSettings':
            updates.schemaSettings = topicData.schemaSettings
              ? JSON.stringify(topicData.schemaSettings)
              : null;
            break;
          case 'messageStoragePolicy':
            updates.messageStoragePolicy = topicData.messageStoragePolicy
              ? JSON.stringify(topicData.messageStoragePolicy)
              : null;
            break;
          case 'ingestionDataSourceSettings':
            updates.ingestionDataSourceSettings = topicData.ingestionDataSourceSettings
              ? JSON.stringify(topicData.ingestionDataSourceSettings)
              : null;
            break;
        }
      }
    }

    const updated = await this.repo.updateTopic(name, updates);

    if (!updated) {
      throw new PubSubError('NOT_FOUND', `Topic ${name} not found`);
    }

    return topicRecordToResponse(updated);
  }

  async deleteTopic(name: string): Promise<void> {
    const deleted = await this.repo.deleteTopic(name);

    if (!deleted) {
      throw new PubSubError('NOT_FOUND', `Topic ${name} not found`);
    }

    await this.messageRepo.deleteMessagesByTopic(name);
  }
}
