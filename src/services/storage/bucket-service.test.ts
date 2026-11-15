import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import { BucketRepository } from './bucket-repository.ts';
import { BucketService, GcsError } from './bucket-service.ts';
import { IamPolicyRepository } from './iam-repository.ts';
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

    const iamRepo = new IamPolicyRepository(storage);
    await iamRepo.initialize();

    service = new BucketService(bucketRepo, objectRepo, iamRepo, new ResourceMutex());
  });

  // ── createBucket ──

  test('createBucket with defaults', async () => {
    const result = await service.createBucket('my-project', { name: 'my-bucket' });

    expect(result.kind).toBe('storage#bucket');
    expect(result.name).toBe('my-bucket');
    expect(result.location).toBe('US');
    expect(result.storageClass).toBe('STANDARD');
    expect(result.metageneration).toBe('1');
    expect(result.projectNumber).toBe('2052754419519117448');
    expect(result.timeCreated).toBeTypeOf('string');
  });

  test('listBuckets filters the caller project id', async () => {
    await service.createBucket('my-project', { name: 'my-bucket' });

    const byId = await service.listBuckets('my-project');
    expect(byId.items?.map(item => item.name)).toEqual(['my-bucket']);
    expect(byId.items?.[0]?.projectNumber).toBe('2052754419519117448');

    const byNumber = await service.listBuckets('2052754419519117448');
    expect(byNumber.items).toHaveLength(0);
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

  test('getBucket succeeds when ifMetagenerationMatch equals the current metageneration', async () => {
    await service.createBucket('proj-1', { name: 'get-match' });

    const result = await service.getBucket('get-match', { ifMetagenerationMatch: '1' });

    expect(result.name).toBe('get-match');
    expect(result.metageneration).toBe('1');
  });

  test('getBucket throws CONDITION_NOT_MET when ifMetagenerationMatch mismatches', async () => {
    await service.createBucket('proj-1', { name: 'get-mismatch' });

    const promise = service.getBucket('get-mismatch', { ifMetagenerationMatch: '2' });

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'CONDITION_NOT_MET');
  });

  test('getBucket throws NOT_MODIFIED when ifMetagenerationNotMatch equals the current metageneration', async () => {
    await service.createBucket('proj-1', { name: 'get-not-match' });

    const promise = service.getBucket('get-not-match', { ifMetagenerationNotMatch: '1' });

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_MODIFIED');
  });

  test('getBucket returns the bucket when ifMetagenerationNotMatch differs', async () => {
    await service.createBucket('proj-1', { name: 'get-not-match-ok' });

    const result = await service.getBucket('get-not-match-ok', { ifMetagenerationNotMatch: '4' });

    expect(result.name).toBe('get-not-match-ok');
    expect(result.metageneration).toBe('1');
  });

  test('getBucket throws NOT_FOUND when a valid precondition names a missing bucket', async () => {
    const promise = service.getBucket('missing', { ifMetagenerationMatch: '1' });

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('getBucket throws INVALID_ARGUMENT before NOT_FOUND when the precondition is not an integer', async () => {
    const promise = service.getBucket('missing', { ifMetagenerationMatch: 'nope' });

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
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

  test('concurrent patchBucket with the same ifMetagenerationMatch lets one succeed', async () => {
    await service.createBucket('proj-1', { name: 'race-patch' });

    const settled = await Promise.allSettled([
      service.patchBucket('race-patch', { labels: { who: 'a' } }, { ifMetagenerationMatch: '1' }),
      service.patchBucket('race-patch', { labels: { who: 'b' } }, { ifMetagenerationMatch: '1' }),
    ]);

    const failed = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );

    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toBeInstanceOf(GcsError);
    expect(failed[0]?.reason).toHaveProperty('code', 'CONDITION_NOT_MET');

    const bucket = await service.getBucket('race-patch');

    expect(bucket.metageneration).toBe('2');
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

  test('patchBucket succeeds when ifMetagenerationMatch equals the current metageneration', async () => {
    await service.createBucket('proj-1', { name: 'patch-match' });

    const result = await service.patchBucket(
      'patch-match',
      { labels: { env: 'prod' } },
      { ifMetagenerationMatch: '1' }
    );

    expect(result.labels).toEqual({ env: 'prod' });
    expect(result.metageneration).toBe('2');
  });

  test('patchBucket throws CONDITION_NOT_MET when ifMetagenerationMatch mismatches', async () => {
    await service.createBucket('proj-1', { name: 'patch-mismatch', labels: { env: 'dev' } });

    const promise = service.patchBucket(
      'patch-mismatch',
      { labels: { env: 'prod' } },
      { ifMetagenerationMatch: '8' }
    );

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'CONDITION_NOT_MET');

    const unchanged = await service.getBucket('patch-mismatch');
    expect(unchanged.labels).toEqual({ env: 'dev' });
    expect(unchanged.metageneration).toBe('1');
  });

  test('patchBucket throws CONDITION_NOT_MET when ifMetagenerationNotMatch equals the current metageneration', async () => {
    await service.createBucket('proj-1', { name: 'patch-not-match' });

    const promise = service.patchBucket(
      'patch-not-match',
      { labels: { env: 'prod' } },
      { ifMetagenerationNotMatch: '1' }
    );

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'CONDITION_NOT_MET');
  });

  // ── updateBucket (PUT - full replacement) ──

  test('updateBucket resets omitted fields to defaults', async () => {
    await service.createBucket('proj-1', {
      name: 'replace-me',
      storageClass: 'COLDLINE',
      labels: { env: 'prod' },
      versioning: { enabled: true },
    });

    // PUT with only storageClass — labels, versioning, cors, lifecycle should reset to null/default
    const result = await service.updateBucket('replace-me', {
      storageClass: 'NEARLINE',
    });

    expect(result.storageClass).toBe('NEARLINE');
    expect(result.labels).toBeUndefined();
    expect(result.versioning).toBeUndefined();
    expect(result.cors).toBeUndefined();
    expect(result.lifecycle).toBeUndefined();
  });

  test('updateBucket with empty body resets all to defaults', async () => {
    await service.createBucket('proj-1', {
      name: 'reset-all',
      storageClass: 'ARCHIVE',
      labels: { team: 'infra' },
    });

    const result = await service.updateBucket('reset-all', {});

    expect(result.storageClass).toBe('STANDARD');
    expect(result.labels).toBeUndefined();
  });

  test('concurrent updateBucket with the same ifMetagenerationMatch lets one succeed', async () => {
    await service.createBucket('proj-1', { name: 'race-update', storageClass: 'STANDARD' });

    const settled = await Promise.allSettled([
      service.updateBucket(
        'race-update',
        { storageClass: 'NEARLINE' },
        { ifMetagenerationMatch: '1' }
      ),
      service.updateBucket(
        'race-update',
        { storageClass: 'COLDLINE' },
        { ifMetagenerationMatch: '1' }
      ),
    ]);

    const failed = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );

    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toBeInstanceOf(GcsError);
    expect(failed[0]?.reason).toHaveProperty('code', 'CONDITION_NOT_MET');

    const bucket = await service.getBucket('race-update');

    expect(bucket.metageneration).toBe('2');
  });

  test('updateBucket increments metageneration', async () => {
    await service.createBucket('proj-1', { name: 'put-meta' });
    const result = await service.updateBucket('put-meta', {});
    expect(result.metageneration).toBe('2');
  });

  test('updateBucket throws NOT_FOUND', async () => {
    const promise = service.updateBucket('nope', {});
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('updateBucket succeeds when ifMetagenerationMatch equals the current metageneration', async () => {
    await service.createBucket('proj-1', { name: 'match-ok', storageClass: 'STANDARD' });

    const result = await service.updateBucket(
      'match-ok',
      { storageClass: 'NEARLINE' },
      { ifMetagenerationMatch: '1' }
    );

    expect(result.storageClass).toBe('NEARLINE');
    expect(result.metageneration).toBe('2');
  });

  test('updateBucket throws CONDITION_NOT_MET when ifMetagenerationMatch mismatches', async () => {
    await service.createBucket('proj-1', { name: 'match-bad', storageClass: 'COLDLINE' });

    const promise = service.updateBucket(
      'match-bad',
      { storageClass: 'NEARLINE' },
      { ifMetagenerationMatch: '9' }
    );

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'CONDITION_NOT_MET');

    const unchanged = await service.getBucket('match-bad');
    expect(unchanged.storageClass).toBe('COLDLINE');
    expect(unchanged.metageneration).toBe('1');
  });

  test('updateBucket throws CONDITION_NOT_MET when ifMetagenerationNotMatch equals the current metageneration', async () => {
    await service.createBucket('proj-1', { name: 'not-match-bad', storageClass: 'ARCHIVE' });

    const promise = service.updateBucket(
      'not-match-bad',
      { storageClass: 'NEARLINE' },
      { ifMetagenerationNotMatch: '1' }
    );

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'CONDITION_NOT_MET');

    const unchanged = await service.getBucket('not-match-bad');
    expect(unchanged.storageClass).toBe('ARCHIVE');
    expect(unchanged.metageneration).toBe('1');
  });

  test('updateBucket requires both metageneration preconditions when both are set', async () => {
    await service.createBucket('proj-1', { name: 'both-ok' });

    const ok = await service.updateBucket(
      'both-ok',
      { storageClass: 'NEARLINE' },
      { ifMetagenerationMatch: '1', ifMetagenerationNotMatch: '9' }
    );

    expect(ok.storageClass).toBe('NEARLINE');
    expect(ok.metageneration).toBe('2');

    await service.createBucket('proj-1', { name: 'both-bad' });

    const promise = service.updateBucket(
      'both-bad',
      { storageClass: 'NEARLINE' },
      { ifMetagenerationMatch: '1', ifMetagenerationNotMatch: '1' }
    );

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'CONDITION_NOT_MET');

    const unchanged = await service.getBucket('both-bad');
    expect(unchanged.storageClass).toBe('STANDARD');
  });

  test('updateBucket succeeds when ifMetagenerationNotMatch differs from the current metageneration', async () => {
    await service.createBucket('proj-1', { name: 'not-match-ok' });

    const result = await service.updateBucket(
      'not-match-ok',
      { storageClass: 'NEARLINE' },
      { ifMetagenerationNotMatch: '4' }
    );

    expect(result.storageClass).toBe('NEARLINE');
    expect(result.metageneration).toBe('2');
  });

  test('updateBucket throws INVALID_ARGUMENT for a non-integer ifMetagenerationMatch', async () => {
    await service.createBucket('proj-1', { name: 'bad-precondition' });

    const promise = service.updateBucket(
      'bad-precondition',
      { storageClass: 'NEARLINE' },
      { ifMetagenerationMatch: 'nope' }
    );

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');

    const unchanged = await service.getBucket('bad-precondition');
    expect(unchanged.storageClass).toBe('STANDARD');
  });

  test('updateBucket throws INVALID_ARGUMENT when ifMetagenerationMatch is not a safe integer', async () => {
    await service.createBucket('proj-1', { name: 'huge-precondition' });

    const promise = service.updateBucket(
      'huge-precondition',
      {},
      { ifMetagenerationMatch: '9007199254740993' }
    );

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('patchBucket preserves omitted fields', async () => {
    await service.createBucket('proj-1', {
      name: 'patch-preserve',
      storageClass: 'COLDLINE',
      labels: { env: 'prod' },
    });

    // PATCH with only storageClass — labels should be preserved
    const result = await service.patchBucket('patch-preserve', {
      storageClass: 'NEARLINE',
    });

    expect(result.storageClass).toBe('NEARLINE');
    expect(result.labels).toEqual({ env: 'prod' });
  });

  // ── deleteBucket ──

  test('deleteBucket succeeds for empty bucket', async () => {
    await service.createBucket('proj-1', { name: 'del-me' });
    await expect(service.deleteBucket('del-me')).resolves.toBeUndefined();

    const promise = service.getBucket('del-me');
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('deleteBucket throws BUCKET_NOT_EMPTY when bucket has objects', async () => {
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
    await expect(promise).rejects.toHaveProperty('code', 'BUCKET_NOT_EMPTY');
  });

  test('deleteBucket throws NOT_FOUND', async () => {
    const promise = service.deleteBucket('nope');
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('concurrent deleteBucket with the same ifMetagenerationMatch lets one succeed', async () => {
    await service.createBucket('proj-1', { name: 'race-delete' });

    const settled = await Promise.allSettled([
      service.deleteBucket('race-delete', { ifMetagenerationMatch: '1' }),
      service.deleteBucket('race-delete', { ifMetagenerationMatch: '1' }),
    ]);

    const failed = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );

    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toBeInstanceOf(GcsError);
    expect(failed[0]?.reason).toHaveProperty('code', 'NOT_FOUND');

    const promise = service.getBucket('race-delete');

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('deleteBucket succeeds when ifMetagenerationMatch equals the current metageneration', async () => {
    await service.createBucket('proj-1', { name: 'del-match' });

    await expect(
      service.deleteBucket('del-match', { ifMetagenerationMatch: '1' })
    ).resolves.toBeUndefined();

    const promise = service.getBucket('del-match');
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('deleteBucket throws CONDITION_NOT_MET when ifMetagenerationMatch mismatches', async () => {
    await service.createBucket('proj-1', { name: 'del-mismatch' });

    const promise = service.deleteBucket('del-mismatch', { ifMetagenerationMatch: '3' });

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'CONDITION_NOT_MET');

    const stillThere = await service.getBucket('del-mismatch');
    expect(stillThere.name).toBe('del-mismatch');
  });

  test('deleteBucket throws CONDITION_NOT_MET when ifMetagenerationNotMatch equals the current metageneration', async () => {
    await service.createBucket('proj-1', { name: 'del-not-match' });

    const promise = service.deleteBucket('del-not-match', { ifMetagenerationNotMatch: '1' });

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'CONDITION_NOT_MET');

    const stillThere = await service.getBucket('del-not-match');
    expect(stillThere.name).toBe('del-not-match');
  });

  test('deleteBucket reports CONDITION_NOT_MET before BUCKET_NOT_EMPTY when the metageneration mismatches', async () => {
    await service.createBucket('proj-1', { name: 'del-both' });

    await objectRepo.createObject(
      requestToObjectRecord('del-both', 'file.txt', {
        size: 5,
        md5Hash: 'h',
        crc32c: 'c',
        blobPath: '/tmp/b',
      })
    );

    const promise = service.deleteBucket('del-both', { ifMetagenerationMatch: '9' });

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'CONDITION_NOT_MET');
  });
});
