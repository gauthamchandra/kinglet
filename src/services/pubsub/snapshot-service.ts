/**
 * Snapshot Service - business logic for Pub/Sub snapshots
 */

import type { SnapshotRepository } from './snapshot-repository.ts';
import type { SubscriptionRepository } from './subscription-repository.ts';
import type { TopicRepository } from './topic-repository.ts';
import type { ListTopicSnapshotsResponse, SnapshotResponse } from './types.ts';
import { buildSnapshotName, PubSubError } from './types.ts';

interface ListSnapshotsResponse {
  snapshots: SnapshotResponse[];
  nextPageToken?: string;
}

export class SnapshotService {
  private snapshotRepo: SnapshotRepository;
  private subRepo: SubscriptionRepository;
  private topicRepo: TopicRepository;

  constructor(
    snapshotRepo: SnapshotRepository,
    subRepo: SubscriptionRepository,
    topicRepo: TopicRepository
  ) {
    this.snapshotRepo = snapshotRepo;
    this.subRepo = subRepo;
    this.topicRepo = topicRepo;
  }

  async createSnapshot(
    project: string,
    snapshot: string,
    body: unknown
  ): Promise<SnapshotResponse> {
    const data = body as {
      subscription: string;
      labels?: Record<string, string>;
    };

    if (!data.subscription) {
      throw new PubSubError('INVALID_ARGUMENT', 'subscription is required');
    }

    // Verify subscription exists
    const sub = await this.subRepo.getSubscriptionByName(data.subscription);

    if (!sub) {
      throw new PubSubError(
        'NOT_FOUND',
        `Subscription ${data.subscription} not found`,
        data.subscription
      );
    }

    const name = buildSnapshotName(project, snapshot);

    // Check for duplicates
    const existing = await this.snapshotRepo.getSnapshotByName(name);

    if (existing) {
      throw new PubSubError('ALREADY_EXISTS', `Snapshot ${name} already exists`, name);
    }

    // Default expireTime: 7 days from now
    const expireTime = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const record = await this.snapshotRepo.createSnapshot({
      name,
      topic: sub.topic,
      expireTime,
      labels: data.labels ? JSON.stringify(data.labels) : null,
    });

    return this.toResponse(record);
  }

  async getSnapshot(name: string): Promise<SnapshotResponse> {
    const record = await this.snapshotRepo.getSnapshotByName(name);

    if (!record) {
      throw new PubSubError('NOT_FOUND', `Snapshot ${name} not found`, name);
    }

    return this.toResponse(record);
  }

  async listSnapshots(
    project: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListSnapshotsResponse> {
    const result = await this.snapshotRepo.listSnapshots(project, pageSize, pageToken);

    const response: ListSnapshotsResponse = {
      snapshots: result.snapshots.map(s => this.toResponse(s)),
    };

    if (result.nextPageToken) {
      response.nextPageToken = result.nextPageToken;
    }

    return response;
  }

  async updateSnapshot(name: string, body: unknown): Promise<SnapshotResponse> {
    const updateBody = body as {
      snapshot?: { expireTime?: string; labels?: Record<string, string> };
      updateMask?: string;
    };

    const snapData = updateBody?.snapshot ?? {};
    const updateMask = updateBody?.updateMask;

    const updates: Record<string, unknown> = {};

    if (updateMask) {
      const fields = updateMask.split(',').map(f => f.trim());

      for (const field of fields) {
        switch (field) {
          case 'expireTime':
            if (snapData.expireTime != null) {
              updates.expireTime = snapData.expireTime;
            }
            break;
          case 'labels':
            updates.labels = snapData.labels ? JSON.stringify(snapData.labels) : null;
            break;
        }
      }
    }

    const updated = await this.snapshotRepo.updateSnapshot(name, updates);

    if (!updated) {
      throw new PubSubError('NOT_FOUND', `Snapshot ${name} not found`, name);
    }

    return this.toResponse(updated);
  }

  async deleteSnapshot(name: string): Promise<void> {
    const deleted = await this.snapshotRepo.deleteSnapshot(name);

    if (!deleted) {
      throw new PubSubError('NOT_FOUND', `Snapshot ${name} not found`, name);
    }
  }

  async listTopicSnapshots(topicName: string): Promise<ListTopicSnapshotsResponse> {
    const topic = await this.topicRepo.getTopicByName(topicName);

    if (!topic) {
      throw new PubSubError('NOT_FOUND', `Topic ${topicName} not found`, topicName);
    }

    const snapshots = await this.snapshotRepo.listSnapshotsByTopic(topicName);

    return {
      snapshots: snapshots.map(s => s.name),
    };
  }

  private toResponse(record: {
    name: string;
    topic: string;
    expireTime: string | null;
    labels: string | null;
  }): SnapshotResponse {
    const response: SnapshotResponse = {
      name: record.name,
      topic: record.topic,
    };

    if (record.expireTime) {
      response.expireTime = record.expireTime;
    }

    if (record.labels) {
      try {
        response.labels = JSON.parse(record.labels) as Record<string, string>;
      } catch {
        // ignore invalid JSON
      }
    }

    return response;
  }
}
