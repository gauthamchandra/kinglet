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

function getNestedValue(obj: Record<string, unknown>, segments: string[]): unknown {
  let curr: unknown = obj;

  for (const seg of segments) {
    if (curr == null || typeof curr !== 'object') return undefined;

    curr = (curr as Record<string, unknown>)[seg];
  }

  return curr;
}

function setNestedValue(obj: Record<string, unknown>, segments: string[], value: unknown): void {
  if (segments.length === 0) return;

  const leafKey = segments[segments.length - 1];

  if (leafKey === undefined) return;

  let curr = obj;

  for (const key of segments.slice(0, -1)) {
    if (curr[key] == null || typeof curr[key] !== 'object') {
      curr[key] = {};
    }

    curr = curr[key] as Record<string, unknown>;
  }

  curr[leafKey] = value;
}

/**
 * Merge a single sub-field for topic update masks (e.g. `schemaSettings.encoding`).
 *
 * `subField` may itself be a dotted path (e.g. `cloudStorage.minimumObjectCreateTime`),
 * in which case the value is read/written at the correct nested depth so that
 * sibling fields at every level are preserved.
 *
 * If `updates[topField]` was already set by a previous nested-path entry for
 * the same parent, that intermediate value is used as the base instead of
 * re-reading from `existing`, so multiple nested paths for the same parent
 * field accumulate correctly.
 */
function applyNestedTopicSubUpdate(
  topField: string,
  subField: string,
  incoming: Record<string, unknown>,
  existing: Record<string, unknown>,
  updates: Record<string, unknown>
): void {
  const baseStr =
    topField in updates
      ? (updates[topField] as string)
      : ((existing[topField] as string | null | undefined) ?? null);

  const base: Record<string, unknown> = baseStr
    ? (JSON.parse(baseStr) as Record<string, unknown>)
    : {};

  const incomingTop = (incoming[topField] as Record<string, unknown> | undefined) ?? {};
  const subSegments = subField.split('.');
  const value = getNestedValue(incomingTop, subSegments);

  setNestedValue(base, subSegments, value);
  updates[topField] = JSON.stringify(base);
}

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
      throw new PubSubError('ALREADY_EXISTS', `Topic ${name} already exists`, name);
    }

    const record = topicRequestToRecord(name, parsed.data as Record<string, unknown>);
    const created = await this.repo.createTopic(record);

    return topicRecordToResponse(created);
  }

  async getTopic(name: string): Promise<TopicResponse> {
    const record = await this.repo.getTopicByName(name);

    if (!record) {
      throw new PubSubError('NOT_FOUND', `Topic ${name} not found`, name);
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

      // For nested paths we need the existing record to merge only the sub-field.
      const hasNestedPaths = fields.some(f => f.includes('.'));
      let existingRecord: Record<string, unknown> | null = null;

      if (hasNestedPaths) {
        existingRecord = (await this.repo.getTopicByName(name)) as Record<string, unknown> | null;

        if (!existingRecord) {
          throw new PubSubError('NOT_FOUND', `Topic ${name} not found`, name);
        }
      }

      for (const field of fields) {
        const dotIdx = field.indexOf('.');

        if (dotIdx >= 0) {
          const topField = field.substring(0, dotIdx);
          const subField = field.substring(dotIdx + 1);

          applyNestedTopicSubUpdate(topField, subField, topicData, existingRecord ?? {}, updates);
          continue;
        }

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
      throw new PubSubError('NOT_FOUND', `Topic ${name} not found`, name);
    }

    return topicRecordToResponse(updated);
  }

  async deleteTopic(name: string): Promise<void> {
    const deleted = await this.repo.deleteTopic(name);

    if (!deleted) {
      throw new PubSubError('NOT_FOUND', `Topic ${name} not found`, name);
    }

    await this.messageRepo.deleteMessagesByTopic(name);
  }
}
