import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { BucketRepository } from './bucket-repository.ts';
import { GcsError } from './bucket-service.ts';
import { NotificationRepository } from './notification-repository.ts';
import { NotificationService } from './notification-service.ts';
import { requestToBucketRecord } from './types.ts';

const BARE_TOPIC = 'projects/my-project/topics/object-events';
const CANONICAL_TOPIC = '//pubsub.googleapis.com/projects/my-project/topics/object-events';

const BUILTIN_ATTRIBUTE_NAMES = [
  'eventType',
  'bucketId',
  'objectId',
  'objectGeneration',
  'eventTime',
  'payloadFormat',
  'notificationConfig',
  'overwroteGeneration',
  'overwrittenByGeneration',
] as const;

describe('NotificationService', () => {
  let bucketRepo: BucketRepository;
  let service: NotificationService;

  beforeEach(async () => {
    const storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    bucketRepo = new BucketRepository(storage);
    await bucketRepo.initialize();

    const notificationRepo = new NotificationRepository(storage);
    await notificationRepo.initialize();

    await bucketRepo.createBucket(
      requestToBucketRecord('notify-bucket', { name: 'notify-bucket' }, 'proj')
    );

    service = new NotificationService(notificationRepo, bucketRepo);
  });

  test('insert rewrites a bare topic to the pubsub prefix form', async () => {
    const created = await service.insertNotification('notify-bucket', {
      topic: BARE_TOPIC,
      payload_format: 'JSON_API_V1',
    });

    expect(created.topic).toBe(CANONICAL_TOPIC);
    expect(created.kind).toBe('storage#notification');
    expect(created.payload_format).toBe('JSON_API_V1');
    expect(created.id).toBeTypeOf('string');
    expect(created.etag).toBeTypeOf('string');
    expect(created.selfLink).toBe(
      `https://www.googleapis.com/storage/v1/b/notify-bucket/notificationConfigs/${created.id}`
    );
  });

  test('insert rejects a camelCase body', async () => {
    const promise = service.insertNotification('notify-bucket', {
      topic: CANONICAL_TOPIC,
      payloadFormat: 'JSON_API_V1',
      eventTypes: ['OBJECT_FINALIZE'],
      objectNamePrefix: 'logs/',
      customAttributes: { origin: 'node' },
    });

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('insert keeps an already canonical topic', async () => {
    const created = await service.insertNotification('notify-bucket', {
      topic: CANONICAL_TOPIC,
      payload_format: 'NONE',
    });

    expect(created.topic).toBe(CANONICAL_TOPIC);
    expect(created.payload_format).toBe('NONE');
  });

  test('insert stores a second config for the same topic', async () => {
    const first = await service.insertNotification('notify-bucket', {
      topic: BARE_TOPIC,
      payload_format: 'JSON_API_V1',
    });
    const second = await service.insertNotification('notify-bucket', {
      topic: BARE_TOPIC,
      payload_format: 'JSON_API_V1',
    });

    expect(second.id).not.toBe(first.id);
    expect(second.topic).toBe(CANONICAL_TOPIC);
  });

  test('insert rejects a topic that is not a projects path', async () => {
    const promise = service.insertNotification('notify-bucket', {
      topic: 'object-events',
      payload_format: 'JSON_API_V1',
    });

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('insert rejects a missing payload_format', async () => {
    const promise = service.insertNotification('notify-bucket', {
      topic: BARE_TOPIC,
    });

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('insert rejects an unknown payload_format', async () => {
    const promise = service.insertNotification('notify-bucket', {
      topic: BARE_TOPIC,
      payload_format: 'XML',
    });

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('insert rejects an unknown event type', async () => {
    const promise = service.insertNotification('notify-bucket', {
      topic: BARE_TOPIC,
      payload_format: 'JSON_API_V1',
      event_types: ['OBJECT_FINALIZE', 'NOT_AN_EVENT'],
    });

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('insert stores event_types, object_name_prefix, and custom_attributes', async () => {
    const created = await service.insertNotification('notify-bucket', {
      topic: BARE_TOPIC,
      payload_format: 'JSON_API_V1',
      event_types: ['OBJECT_FINALIZE', 'OBJECT_DELETE'],
      object_name_prefix: 'photos/',
      custom_attributes: { origin: 'kinglet' },
    });

    expect(created.event_types).toEqual(['OBJECT_FINALIZE', 'OBJECT_DELETE']);
    expect(created.object_name_prefix).toBe('photos/');
    expect(created.custom_attributes).toEqual({ origin: 'kinglet' });
  });

  test('insert rejects custom attribute keys that collide with built-in names', async () => {
    for (const key of BUILTIN_ATTRIBUTE_NAMES) {
      const promise = service.insertNotification('notify-bucket', {
        topic: BARE_TOPIC,
        payload_format: 'JSON_API_V1',
        custom_attributes: { [key]: 'x' },
      });

      await expect(promise).rejects.toBeInstanceOf(GcsError);
      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
    }

    const listed = await service.listNotifications('notify-bucket');
    expect(listed.items).toEqual([]);
  });

  test('insert stores a custom attribute whose name differs only by case', async () => {
    const created = await service.insertNotification('notify-bucket', {
      topic: BARE_TOPIC,
      payload_format: 'JSON_API_V1',
      custom_attributes: { eventtype: 'kept' },
    });

    expect(created.custom_attributes).toEqual({ eventtype: 'kept' });
  });

  test('insert throws NOT_FOUND when the bucket does not exist', async () => {
    const promise = service.insertNotification('missing-bucket', {
      topic: BARE_TOPIC,
      payload_format: 'JSON_API_V1',
    });

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('get, list, and delete round-trip a stored config', async () => {
    const created = await service.insertNotification('notify-bucket', {
      topic: BARE_TOPIC,
      payload_format: 'JSON_API_V1',
      custom_attributes: { origin: 'kinglet' },
    });

    const fetched = await service.getNotification('notify-bucket', created.id);

    expect(fetched).toEqual(created);

    const listed = await service.listNotifications('notify-bucket');

    expect(listed.kind).toBe('storage#notifications');
    expect(listed.items).toEqual([created]);

    await service.deleteNotification('notify-bucket', created.id);

    const afterDelete = service.getNotification('notify-bucket', created.id);
    await expect(afterDelete).rejects.toBeInstanceOf(GcsError);
    await expect(afterDelete).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('get throws NOT_FOUND for an unknown id', async () => {
    const promise = service.getNotification('notify-bucket', 'missing-id');

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('delete throws NOT_FOUND for an unknown id', async () => {
    const promise = service.deleteNotification('notify-bucket', 'missing-id');

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('list is scoped to the bucket', async () => {
    await bucketRepo.createBucket(
      requestToBucketRecord('other-bucket', { name: 'other-bucket' }, 'proj')
    );

    await service.insertNotification('notify-bucket', {
      topic: BARE_TOPIC,
      payload_format: 'JSON_API_V1',
    });
    await service.insertNotification('other-bucket', {
      topic: 'projects/my-project/topics/other',
      payload_format: 'NONE',
    });

    const listed = await service.listNotifications('notify-bucket');

    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.topic).toBe(CANONICAL_TOPIC);
  });

  test('get does not return a config from another bucket', async () => {
    await bucketRepo.createBucket(
      requestToBucketRecord('other-bucket', { name: 'other-bucket' }, 'proj')
    );

    const created = await service.insertNotification('other-bucket', {
      topic: BARE_TOPIC,
      payload_format: 'JSON_API_V1',
    });

    const promise = service.getNotification('notify-bucket', created.id);

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });
});
