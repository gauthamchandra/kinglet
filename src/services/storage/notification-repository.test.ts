import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { NotificationRepository } from './notification-repository.ts';
import type { NotificationRecord } from './types.ts';

function notificationData(
  bucket: string,
  topic: string
): Omit<NotificationRecord, keyof BaseRecord | 'ordinal'> {
  return {
    bucket,
    topic,
    payloadFormat: 'JSON_API_V1',
    eventTypes: JSON.stringify(['OBJECT_FINALIZE']),
    objectNamePrefix: 'photos/',
    customAttributes: JSON.stringify({ origin: 'kinglet' }),
    etag: 'etag-1',
  };
}

describe('NotificationRepository', () => {
  let repo: NotificationRepository;

  beforeEach(async () => {
    const storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new NotificationRepository(storage);
    await repo.initialize();
  });

  test('initialize creates the table without error', async () => {
    await expect(repo.initialize()).resolves.toBeUndefined();
  });

  test('create and get return the stored row', async () => {
    const created = await repo.create(notificationData('bucket-a', 'topic-a'));

    expect(created.id).toBeTypeOf('string');
    expect(created.bucket).toBe('bucket-a');
    expect(created.topic).toBe('topic-a');

    const found = await repo.get('bucket-a', created.id);

    expect(found?.id).toBe(created.id);
    expect(found?.customAttributes).toBe(JSON.stringify({ origin: 'kinglet' }));
  });

  test('get returns null for an unknown id', async () => {
    const found = await repo.get('bucket-a', 'missing');
    expect(found).toBeNull();
  });

  test('get returns null when the id belongs to another bucket', async () => {
    const created = await repo.create(notificationData('bucket-a', 'topic-a'));
    const found = await repo.get('bucket-b', created.id);
    expect(found).toBeNull();
  });

  test('listByBucket returns rows in creation order', async () => {
    const first = await repo.create(notificationData('bucket-a', 'first'));
    const second = await repo.create(notificationData('bucket-a', 'second'));

    const listed = await repo.listByBucket('bucket-a');

    expect(listed.map(row => row.id)).toEqual([first.id, second.id]);
  });

  test('listByBucket returns only that bucket', async () => {
    await repo.create(notificationData('bucket-a', 'topic-a'));
    await repo.create(notificationData('bucket-a', 'topic-b'));
    await repo.create(notificationData('bucket-b', 'topic-c'));

    const listed = await repo.listByBucket('bucket-a');

    expect(listed).toHaveLength(2);
    expect(listed.map(row => row.topic).sort()).toEqual(['topic-a', 'topic-b']);
  });

  test('delete removes the row and a second delete returns false', async () => {
    const created = await repo.create(notificationData('bucket-a', 'topic-a'));

    expect(await repo.delete('bucket-a', created.id)).toBe(true);
    expect(await repo.get('bucket-a', created.id)).toBeNull();
    expect(await repo.delete('bucket-a', created.id)).toBe(false);
  });

  test('delete returns false for an id on another bucket', async () => {
    const created = await repo.create(notificationData('bucket-a', 'topic-a'));

    expect(await repo.delete('bucket-b', created.id)).toBe(false);

    const stillThere = await repo.get('bucket-a', created.id);
    expect(stillThere?.id).toBe(created.id);
  });
});
