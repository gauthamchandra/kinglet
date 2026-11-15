/**
 * Notification Service - CRUD for Cloud Storage notification configs.
 *
 * Configs are stored even when no publisher is wired. Checking that the topic
 * exists, and publishing object events, are a later change.
 */

import type { BucketRepository } from './bucket-repository.ts';
import { GcsError } from './bucket-service.ts';
import type { NotificationRepository } from './notification-repository.ts';
import type { NotificationListResponse, NotificationResponse } from './types.ts';
import {
  BUILTIN_NOTIFICATION_ATTRIBUTES,
  InsertNotificationRequestSchema,
  notificationRecordToResponse,
} from './types.ts';

const CANONICAL_TOPIC = /^\/\/pubsub\.googleapis\.com\/projects\/(?:[^/]+)\/topics\/(?:[^/]+)$/;
const BARE_TOPIC = /^projects\/(?:[^/]+)\/topics\/(?:[^/]+)$/;

const BUILTIN_ATTRIBUTE_SET = new Set<string>(BUILTIN_NOTIFICATION_ATTRIBUTES);

// GCS stores the topic as //pubsub.googleapis.com/projects/{project}/topics/{topic}.
// A bare projects/{project}/topics/{topic} is accepted and rewritten. The
// Terraform provider only strips that prefix on read.
function normalizeNotificationTopic(topic: string): string | null {
  if (CANONICAL_TOPIC.test(topic)) {
    return topic;
  }

  if (!BARE_TOPIC.test(topic)) {
    return null;
  }

  return `//pubsub.googleapis.com/${topic}`;
}

function notificationEtag(): string {
  return Buffer.from(crypto.randomUUID()).toString('base64');
}

export class NotificationService {
  private notificationRepo: NotificationRepository;
  private bucketRepo: BucketRepository;

  constructor(notificationRepo: NotificationRepository, bucketRepo: BucketRepository) {
    this.notificationRepo = notificationRepo;
    this.bucketRepo = bucketRepo;
  }

  async insertNotification(bucket: string, body: unknown): Promise<NotificationResponse> {
    await this.requireBucket(bucket);

    const parsed = InsertNotificationRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new GcsError(
        'INVALID_ARGUMENT',
        `Invalid notification request: ${parsed.error.message}`
      );
    }

    const topic = normalizeNotificationTopic(parsed.data.topic);

    if (!topic) {
      throw new GcsError('INVALID_ARGUMENT', `Invalid topic name: ${parsed.data.topic}`);
    }

    const customAttributes = parsed.data.custom_attributes;

    const colliding = customAttributes
      ? Object.keys(customAttributes)
          .filter(key => BUILTIN_ATTRIBUTE_SET.has(key))
          .sort()
      : [];

    if (colliding.length > 0) {
      throw new GcsError('INVALID_ARGUMENT', `Invalid custom attributes: ${colliding.join(', ')}`);
    }

    const eventTypes = parsed.data.event_types;

    const prefix = parsed.data.object_name_prefix;

    const created = await this.notificationRepo.create({
      bucket,
      topic,
      payloadFormat: parsed.data.payload_format,
      eventTypes: eventTypes && eventTypes.length > 0 ? JSON.stringify(eventTypes) : null,
      objectNamePrefix: prefix ? prefix : null,
      customAttributes:
        customAttributes && Object.keys(customAttributes).length > 0
          ? JSON.stringify(customAttributes)
          : null,
      etag: notificationEtag(),
    });

    return notificationRecordToResponse(created);
  }

  async getNotification(bucket: string, id: string): Promise<NotificationResponse> {
    await this.requireBucket(bucket);

    const record = await this.notificationRepo.get(bucket, id);

    if (!record) {
      throw new GcsError('NOT_FOUND', `Notification ${id} not found`);
    }

    return notificationRecordToResponse(record);
  }

  async listNotifications(bucket: string): Promise<NotificationListResponse> {
    await this.requireBucket(bucket);

    const records = await this.notificationRepo.listByBucket(bucket);

    return {
      kind: 'storage#notifications',
      items: records.map(notificationRecordToResponse),
    };
  }

  async deleteNotification(bucket: string, id: string): Promise<void> {
    await this.requireBucket(bucket);

    const deleted = await this.notificationRepo.delete(bucket, id);

    if (!deleted) {
      throw new GcsError('NOT_FOUND', `Notification ${id} not found`);
    }
  }

  private async requireBucket(bucket: string): Promise<void> {
    const existing = await this.bucketRepo.getBucketByName(bucket);

    if (!existing) {
      throw new GcsError('NOT_FOUND', `Bucket ${bucket} not found`);
    }
  }
}
