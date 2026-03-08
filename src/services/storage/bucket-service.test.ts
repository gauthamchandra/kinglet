import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { BucketRepository } from './bucket-repository.ts';
import { BucketService, GcsError } from './bucket-service.ts';
import { ObjectRepository } from './object-repository.ts';
import { requestToObjectRecord } from './types.ts';

describe('BucketService', () => {
  let storage: StorageManager;
  let bucketRepo: BucketRepository;
  let objectRepo: ObjectRepository;
  let service: BucketService;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    bucketRepo = new BucketRepository(storage);
    await bucketRepo.initialize();

    objectRepo = new ObjectRepository(storage);
    await objectRepo.initialize();

    service = new BucketService(bucketRepo, objectRepo);
  });

  // ── createBucket ──

  test('createBucket with defaults', async () => {
    const result = await service.createBucket('proj-1', { name: 'my-bucket' });

    expect(result.kind).toBe('storage#bucket');
    expect(result.name).toBe('my-bucket');
    expect(result.location).toBe('US');
    expect(result.storageClass).toBe('STANDARD');
    expect(result.metageneration).toBe('1');
    expect(result.projectNumber).toBe('proj-1');
    expect(result.timeCreated).toBeTypeOf('string');
  });

  test('createBucket with custom values', async () => {
    const result = await service.createBucket('proj-1', {
      name: 'my-bucket',
      location: 'eu',
      storageClass: 'NEARLINE',
    });

    expect(result.location).toBe('EU');
    expect(result.storageClass).toBe('NEARLINE');
  });

  test('createBucket throws ALREADY_EXISTS', async () => {
    await service.createBucket('proj-1', { name: 'dup-bucket' });

    const promise = service.createBucket('proj-1', { name: 'dup-bucket' });
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
  });

  test('createBucket throws INVALID_ARGUMENT on bad body', async () => {
    const promise = service.createBucket('proj-1', {});
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('createBucket throws INVALID_ARGUMENT on bad bucket name', async () => {
    const promise = service.createBucket('proj-1', { name: 'BAD NAME!' });
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  // ── getBucket ──

  test('getBucket returns bucket', async () => {
    await service.createBucket('proj-1', { name: 'get-me' });
    const result = await service.getBucket('get-me');
    expect(result.name).toBe('get-me');
  });

  test('getBucket throws NOT_FOUND', async () => {
    const promise = service.getBucket('nope');
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── listBuckets ──

  test('listBuckets returns list', async () => {
    await service.createBucket('proj-1', { name: 'b1' });
    await service.createBucket('proj-1', { name: 'b2' });

    const result = await service.listBuckets('proj-1');
    expect(result.kind).toBe('storage#buckets');
    expect(result.items).toHaveLength(2);
  });

  test('listBuckets pagination', async () => {
    await service.createBucket('proj-1', { name: 'a1' });
    await service.createBucket('proj-1', { name: 'a2' });
    await service.createBucket('proj-1', { name: 'a3' });

    const page1 = await service.listBuckets('proj-1', 2);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextPageToken).toBeTypeOf('string');

    const page2 = await service.listBuckets('proj-1', 2, page1.nextPageToken);
    expect(page2.items).toHaveLength(1);
  });

  test('listBuckets returns empty for unknown project', async () => {
    const result = await service.listBuckets('unknown');
    expect(result.items).toHaveLength(0);
  });

  // ── patchBucket ──

  test('patchBucket updates labels and storageClass', async () => {
    await service.createBucket('proj-1', { name: 'patch-me' });

    const result = await service.patchBucket('patch-me', {
      labels: { env: 'prod' },
      storageClass: 'COLDLINE',
    });

    expect(result.labels).toEqual({ env: 'prod' });
    expect(result.storageClass).toBe('COLDLINE');
  });

  test('patchBucket increments metageneration', async () => {
    await service.createBucket('proj-1', { name: 'meta-inc' });
    const result = await service.patchBucket('meta-inc', { labels: { x: '1' } });
    expect(result.metageneration).toBe('2');
  });

  test('patchBucket updates timestamp', async () => {
    const created = await service.createBucket('proj-1', { name: 'ts-upd' });
    const originalUpdated = created.updated;

    // Slight delay to ensure different timestamp
    await new Promise(resolve => setTimeout(resolve, 10));

    const result = await service.patchBucket('ts-upd', { labels: { a: 'b' } });
    expect(result.updated).not.toBe(originalUpdated);
  });

  test('patchBucket throws NOT_FOUND', async () => {
    const promise = service.patchBucket('nope', { labels: {} });
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── deleteBucket ──

  test('deleteBucket succeeds for empty bucket', async () => {
    await service.createBucket('proj-1', { name: 'del-me' });
    await expect(service.deleteBucket('del-me')).resolves.toBeUndefined();

    const promise = service.getBucket('del-me');
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('deleteBucket throws FAILED_PRECONDITION when bucket has objects', async () => {
    await service.createBucket('proj-1', { name: 'nonempty' });

    await objectRepo.createObject(
      requestToObjectRecord('nonempty', 'file.txt', {
        size: 5,
        md5Hash: 'h',
        crc32c: 'c',
        blobPath: '/tmp/b',
      })
    );

    const promise = service.deleteBucket('nonempty');
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
  });

  test('deleteBucket throws NOT_FOUND', async () => {
    const promise = service.deleteBucket('nope');
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });
});
