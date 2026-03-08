import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { BucketRepository } from './bucket-repository.ts';
import { requestToBucketRecord } from './types.ts';

describe('BucketRepository', () => {
  let storage: StorageManager;
  let repo: BucketRepository;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new BucketRepository(storage);
    await repo.initialize();
  });

  test('initialize creates table without error', async () => {
    const repo2 = new BucketRepository(storage);
    await expect(repo2.initialize()).resolves.toBeUndefined();
  });

  test('createBucket creates and returns a BucketRecord', async () => {
    const data = requestToBucketRecord('test-bucket', { name: 'test-bucket' }, 'proj-1');
    const result = await repo.createBucket(data);

    expect(result.name).toBe('test-bucket');
    expect(result.id).toBeTypeOf('string');
    expect(result.location).toBe('US');
    expect(result.storageClass).toBe('STANDARD');
  });

  test('createBucket rejects duplicate name', async () => {
    const data = requestToBucketRecord('dup-bucket', { name: 'dup-bucket' }, 'proj-1');
    await repo.createBucket(data);

    const data2 = requestToBucketRecord('dup-bucket', { name: 'dup-bucket' }, 'proj-1');
    await expect(repo.createBucket(data2)).rejects.toThrow('already exists');
  });

  test('getBucketByName returns bucket', async () => {
    const data = requestToBucketRecord('find-me', { name: 'find-me' }, 'proj-1');
    await repo.createBucket(data);

    const found = await repo.getBucketByName('find-me');
    expect(found?.name).toBe('find-me');
  });

  test('getBucketByName returns null for nonexistent', async () => {
    const found = await repo.getBucketByName('nonexistent');
    expect(found).toBeNull();
  });

  test('listBuckets returns all for project', async () => {
    await repo.createBucket(requestToBucketRecord('b1', { name: 'b1' }, 'proj-1'));
    await repo.createBucket(requestToBucketRecord('b2', { name: 'b2' }, 'proj-1'));
    await repo.createBucket(requestToBucketRecord('b3', { name: 'b3' }, 'proj-2'));

    const result = await repo.listBuckets('proj-1');
    expect(result.buckets).toHaveLength(2);
  });

  test('listBuckets supports pagination', async () => {
    await repo.createBucket(requestToBucketRecord('a1', { name: 'a1' }, 'proj-1'));
    await repo.createBucket(requestToBucketRecord('a2', { name: 'a2' }, 'proj-1'));
    await repo.createBucket(requestToBucketRecord('a3', { name: 'a3' }, 'proj-1'));

    const page1 = await repo.listBuckets('proj-1', 2);
    expect(page1.buckets).toHaveLength(2);
    expect(page1.nextPageToken).toBeTypeOf('string');

    const page2 = await repo.listBuckets('proj-1', 2, page1.nextPageToken);
    expect(page2.buckets).toHaveLength(1);
    expect(page2.nextPageToken).toBeUndefined();
  });

  test('listBuckets returns empty for unknown project', async () => {
    const result = await repo.listBuckets('unknown');
    expect(result.buckets).toHaveLength(0);
  });

  test('updateBucket updates fields', async () => {
    await repo.createBucket(requestToBucketRecord('upd', { name: 'upd' }, 'proj-1'));

    const updated = await repo.updateBucket('upd', { storageClass: 'NEARLINE' });
    expect(updated?.storageClass).toBe('NEARLINE');
  });

  test('updateBucket returns null for nonexistent', async () => {
    const result = await repo.updateBucket('nope', { storageClass: 'NEARLINE' });
    expect(result).toBeNull();
  });

  test('deleteBucket returns true', async () => {
    await repo.createBucket(requestToBucketRecord('del', { name: 'del' }, 'proj-1'));

    const result = await repo.deleteBucket('del');
    expect(result).toBe(true);

    const found = await repo.getBucketByName('del');
    expect(found).toBeNull();
  });

  test('deleteBucket returns false for nonexistent', async () => {
    const result = await repo.deleteBucket('nope');
    expect(result).toBe(false);
  });
});
