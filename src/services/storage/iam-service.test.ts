import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageManager } from '@/core/storage/manager.ts';
import { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import { BlobStore } from './blob-store.ts';
import { BucketRepository } from './bucket-repository.ts';
import { BucketService, GcsError } from './bucket-service.ts';
import { IamPolicyRepository } from './iam-repository.ts';
import { IamService } from './iam-service.ts';
import { ObjectRepository } from './object-repository.ts';
import { ObjectService } from './object-service.ts';
import { bucketIamResourceId } from './types.ts';

describe('IamService', () => {
  let service: IamService;
  let buckets: BucketService;
  let writes: ResourceMutex;

  beforeEach(async () => {
    const storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    const bucketRepo = new BucketRepository(storage);
    await bucketRepo.initialize();

    const objectRepo = new ObjectRepository(storage);
    await objectRepo.initialize();

    const iamRepo = new IamPolicyRepository(storage);
    await iamRepo.initialize();

    writes = new ResourceMutex();
    buckets = new BucketService(bucketRepo, objectRepo, iamRepo, writes);
    service = new IamService(bucketRepo, iamRepo, writes, objectRepo);
  });

  test('empty get returns version 1, resourceId, kind, and a stable non-empty etag', async () => {
    await buckets.createBucket('proj', { name: 'iam-empty' });

    const first = await service.getIamPolicy('iam-empty');
    const second = await service.getIamPolicy('iam-empty');

    expect(first.kind).toBe('storage#policy');
    expect(first.resourceId).toBe('projects/_/buckets/iam-empty');
    expect(first.version).toBe(1);
    expect(first.bindings).toEqual([]);
    expect(first.etag).toBeTypeOf('string');
    expect(first.etag.length).toBeGreaterThan(0);
    expect(second.etag).toBe(first.etag);
  });

  test('set rotates the etag and a stored policy returns the version it was given', async () => {
    await buckets.createBucket('proj', { name: 'iam-set' });

    const initial = await service.getIamPolicy('iam-set');
    const first = await service.setIamPolicy('iam-set', {
      bindings: [{ role: 'roles/storage.objectViewer', members: ['user:a@example.com'] }],
      etag: initial.etag,
    });

    expect(first.etag).not.toBe(initial.etag);
    expect(first.etag.length).toBeGreaterThan(0);
    expect(first.version).toBe(1);
    expect(first.kind).toBe('storage#policy');
    expect(first.resourceId).toBe('projects/_/buckets/iam-set');

    const second = await service.setIamPolicy('iam-set', {
      version: 3,
      etag: first.etag,
      bindings: [
        {
          role: 'roles/storage.objectViewer',
          members: ['user:a@example.com'],
          condition: {
            title: 'before-2027',
            expression: 'request.time < timestamp("2027-01-01T00:00:00Z")',
          },
        },
      ],
    });

    expect(second.etag).not.toBe(first.etag);
    expect(second.version).toBe(3);

    const stored = await service.getIamPolicy('iam-set');

    expect(stored.version).toBe(3);
    expect(stored.etag).toBe(second.etag);
    expect(stored.bindings).toEqual(second.bindings);
  });

  test('resending the previous etag is rejected and leaves the stored policy', async () => {
    await buckets.createBucket('proj', { name: 'iam-stale' });

    const initial = await service.getIamPolicy('iam-stale');
    const first = await service.setIamPolicy('iam-stale', {
      etag: initial.etag,
      bindings: [{ role: 'roles/storage.objectViewer', members: ['user:a@example.com'] }],
    });
    const second = await service.setIamPolicy('iam-stale', {
      etag: first.etag,
      bindings: [{ role: 'roles/storage.admin', members: ['user:b@example.com'] }],
    });

    const stale = service.setIamPolicy('iam-stale', {
      etag: first.etag,
      bindings: [],
    });

    await expect(stale).rejects.toBeInstanceOf(GcsError);
    await expect(stale).rejects.toHaveProperty('code', 'ABORTED');

    const stored = await service.getIamPolicy('iam-stale');

    expect(stored.etag).toBe(second.etag);
    expect(stored.bindings).toEqual(second.bindings);
  });

  test('a missing etag overwrites, including an empty binding list', async () => {
    await buckets.createBucket('proj', { name: 'iam-overwrite' });

    const initial = await service.getIamPolicy('iam-overwrite');
    const first = await service.setIamPolicy('iam-overwrite', {
      etag: initial.etag,
      version: 3,
      bindings: [{ role: 'roles/storage.admin', members: ['user:a@example.com'] }],
    });

    const overwritten = await service.setIamPolicy('iam-overwrite', {
      bindings: [{ role: 'roles/storage.objectAdmin', members: ['allUsers'] }],
    });

    expect(overwritten.etag).not.toBe(first.etag);
    expect(overwritten.bindings).toEqual([
      { role: 'roles/storage.objectAdmin', members: ['allUsers'] },
    ]);

    const cleared = await service.setIamPolicy('iam-overwrite', { bindings: [] });

    expect(cleared.version).toBe(1);
    expect(cleared.bindings).toEqual([]);
    expect(cleared.etag.length).toBeGreaterThan(0);
    expect(cleared.etag).not.toBe(overwritten.etag);

    const stored = await service.getIamPolicy('iam-overwrite');

    expect(stored.version).toBe(1);
    expect(stored.bindings).toEqual([]);
    expect(stored.etag).toBe(cleared.etag);
  });

  test('a blank etag is an unconditional write', async () => {
    await buckets.createBucket('proj', { name: 'iam-blank' });

    const initial = await service.getIamPolicy('iam-blank');
    await service.setIamPolicy('iam-blank', {
      etag: initial.etag,
      bindings: [{ role: 'roles/storage.admin', members: ['user:a@example.com'] }],
    });

    const cleared = await service.setIamPolicy('iam-blank', { bindings: [], etag: '' });

    expect(cleared.bindings).toEqual([]);
    expect(cleared.etag).not.toBe(initial.etag);
    expect(cleared.etag.length).toBeGreaterThan(0);
  });

  test('an empty binding list with a stale etag is not an unconditional write', async () => {
    await buckets.createBucket('proj', { name: 'iam-empty-stale' });

    const initial = await service.getIamPolicy('iam-empty-stale');
    const first = await service.setIamPolicy('iam-empty-stale', {
      etag: initial.etag,
      bindings: [{ role: 'roles/storage.admin', members: ['user:a@example.com'] }],
    });

    const stale = service.setIamPolicy('iam-empty-stale', {
      etag: initial.etag,
      bindings: [],
    });

    await expect(stale).rejects.toHaveProperty('code', 'ABORTED');

    const stored = await service.getIamPolicy('iam-empty-stale');

    expect(stored.etag).toBe(first.etag);
    expect(stored.bindings).toEqual(first.bindings);
  });

  test('testIamPermissions echoes the requested permissions and does not read the policy', async () => {
    await buckets.createBucket('proj', { name: 'iam-echo' });

    await service.setIamPolicy('iam-echo', {
      bindings: [{ role: 'roles/storage.objectViewer', members: ['user:a@example.com'] }],
    });

    const echoed = await service.testIamPermissions('iam-echo', [
      'storage.buckets.get',
      'storage.objects.delete',
      'not.a.real.permission',
    ]);

    expect(echoed.kind).toBe('storage#testIamPermissionsResponse');
    expect(echoed.permissions).toEqual([
      'storage.buckets.get',
      'storage.objects.delete',
      'not.a.real.permission',
    ]);
  });

  test('missing bucket is NOT_FOUND for get, set, and test', async () => {
    const getPromise = service.getIamPolicy('missing-bucket');
    await expect(getPromise).rejects.toHaveProperty('code', 'NOT_FOUND');

    const setPromise = service.setIamPolicy('missing-bucket', { bindings: [] });
    await expect(setPromise).rejects.toHaveProperty('code', 'NOT_FOUND');

    const testPromise = service.testIamPermissions('missing-bucket', ['storage.buckets.get']);
    await expect(testPromise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('invalid policy body is INVALID_ARGUMENT', async () => {
    await buckets.createBucket('proj', { name: 'iam-bad' });

    const promise = service.setIamPolicy('iam-bad', { bindings: [{ role: '' }] });

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('concurrent sets that carry the same etag do not both succeed', async () => {
    await buckets.createBucket('proj', { name: 'iam-race' });

    const initial = await service.getIamPolicy('iam-race');
    const firstWave = await Promise.allSettled([
      service.setIamPolicy('iam-race', {
        etag: initial.etag,
        bindings: [{ role: 'roles/storage.objectViewer', members: ['user:a@example.com'] }],
      }),
      service.setIamPolicy('iam-race', {
        etag: initial.etag,
        bindings: [{ role: 'roles/storage.admin', members: ['user:b@example.com'] }],
      }),
    ]);

    const firstSucceeded = firstWave.filter(result => result.status === 'fulfilled');
    const firstFailed = firstWave.filter(result => result.status === 'rejected');

    expect(firstSucceeded).toHaveLength(1);
    expect(firstFailed).toHaveLength(1);

    const firstFailure = firstFailed[0] as PromiseRejectedResult;

    expect(firstFailure.reason).toHaveProperty('code', 'ABORTED');

    const stored = await service.getIamPolicy('iam-race');
    const secondWave = await Promise.allSettled([
      service.setIamPolicy('iam-race', {
        etag: stored.etag,
        bindings: [{ role: 'roles/storage.objectAdmin', members: ['allUsers'] }],
      }),
      service.setIamPolicy('iam-race', {
        etag: stored.etag,
        bindings: [{ role: 'roles/storage.objectCreator', members: ['allAuthenticatedUsers'] }],
      }),
    ]);

    const secondSucceeded = secondWave.filter(result => result.status === 'fulfilled');
    const secondFailed = secondWave.filter(result => result.status === 'rejected');

    expect(secondSucceeded).toHaveLength(1);
    expect(secondFailed).toHaveLength(1);

    const secondFailure = secondFailed[0] as PromiseRejectedResult;

    expect(secondFailure.reason).toHaveProperty('code', 'ABORTED');
  });

  test('a set queued behind a delete does not restore the deleted policy', async () => {
    await buckets.createBucket('proj', { name: 'iam-queue' });
    await service.setIamPolicy('iam-queue', {
      bindings: [{ role: 'roles/storage.admin', members: ['user:a@example.com'] }],
    });

    let release = () => {};

    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    const holder = writes.runExclusively(bucketIamResourceId('iam-queue'), () => released);

    await Bun.sleep(5);

    const deletePromise = buckets.deleteBucket('iam-queue');
    const setPromise = service.setIamPolicy('iam-queue', {
      bindings: [{ role: 'roles/storage.admin', members: ['user:a@example.com'] }],
    });

    release();

    const [deleted, set] = await Promise.allSettled([deletePromise, setPromise, holder]);

    expect(deleted.status).toBe('fulfilled');
    expect(set.status).toBe('rejected');

    const setRejection = set as PromiseRejectedResult;

    expect(setRejection.reason).toBeInstanceOf(GcsError);
    expect(setRejection.reason).toHaveProperty('code', 'NOT_FOUND');

    await buckets.createBucket('proj', { name: 'iam-queue' });

    const policy = await service.getIamPolicy('iam-queue');

    expect(policy.version).toBe(1);
    expect(policy.bindings).toEqual([]);
  });

  test('deleting a bucket drops its IAM policy', async () => {
    await buckets.createBucket('proj', { name: 'iam-recreate' });
    await service.setIamPolicy('iam-recreate', {
      bindings: [{ role: 'roles/storage.admin', members: ['user:a@example.com'] }],
    });

    await buckets.deleteBucket('iam-recreate');
    await buckets.createBucket('proj', { name: 'iam-recreate' });

    const policy = await service.getIamPolicy('iam-recreate');

    expect(policy.version).toBe(1);
    expect(policy.bindings).toEqual([]);
    expect(policy.resourceId).toBe('projects/_/buckets/iam-recreate');
  });

  test('input resourceId is ignored', async () => {
    await buckets.createBucket('proj', { name: 'iam-resource' });

    const stored = await service.setIamPolicy('iam-resource', {
      resourceId: 'buckets/iam-resource',
      kind: 'storage#policy',
      bindings: [{ role: 'roles/storage.admin', members: ['user:a@example.com'] }],
    });

    expect(stored.resourceId).toBe('projects/_/buckets/iam-resource');
  });
});

describe('Object IAM', () => {
  let service: IamService;
  let buckets: BucketService;
  let objects: ObjectService;
  let writes: ResourceMutex;
  let blobStore: BlobStore;

  beforeEach(async () => {
    const storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    const bucketRepo = new BucketRepository(storage);
    await bucketRepo.initialize();

    const objectRepo = new ObjectRepository(storage);
    await objectRepo.initialize();

    const iamRepo = new IamPolicyRepository(storage);
    await iamRepo.initialize();

    blobStore = new BlobStore(join(tmpdir(), `obj-iam-${crypto.randomUUID()}`));
    writes = new ResourceMutex();
    buckets = new BucketService(bucketRepo, objectRepo, iamRepo, writes);
    objects = new ObjectService(objectRepo, bucketRepo, blobStore, iamRepo, writes);
    service = new IamService(bucketRepo, iamRepo, writes, objectRepo);
  });

  afterEach(() => {
    blobStore.cleanup();
  });

  async function createObject(bucket: string, name: string): Promise<void> {
    await buckets.createBucket('proj', { name: bucket });
    await objects.insertObject(bucket, name, new TextEncoder().encode('bytes'));
  }

  test('empty get returns version 1, resourceId, kind, and a stable non-empty etag', async () => {
    await createObject('obj-iam', 'empty.txt');

    const first = await service.getObjectIamPolicy('obj-iam', 'empty.txt');
    const second = await service.getObjectIamPolicy('obj-iam', 'empty.txt');

    expect(first.kind).toBe('storage#policy');
    expect(first.resourceId).toBe('projects/_/buckets/obj-iam/objects/empty.txt');
    expect(first.version).toBe(1);
    expect(first.bindings).toEqual([]);
    expect(first.etag).toBeTypeOf('string');
    expect(first.etag.length).toBeGreaterThan(0);
    expect(second.etag).toBe(first.etag);
  });

  test('a nested object name is part of the resource id', async () => {
    await createObject('obj-iam', 'folder/nested.txt');

    const policy = await service.getObjectIamPolicy('obj-iam', 'folder/nested.txt');

    expect(policy.resourceId).toBe('projects/_/buckets/obj-iam/objects/folder/nested.txt');
  });

  test('a unicode object name can be read and written', async () => {
    await createObject('obj-iam', '报告.txt');

    const initial = await service.getObjectIamPolicy('obj-iam', '报告.txt');

    expect(initial.kind).toBe('storage#policy');
    expect(initial.resourceId).toBe('projects/_/buckets/obj-iam/objects/报告.txt');
    expect(initial.version).toBe(1);
    expect(initial.etag.length).toBeGreaterThan(0);

    const stored = await service.setObjectIamPolicy('obj-iam', '报告.txt', {
      etag: initial.etag,
      bindings: [{ role: 'roles/storage.objectViewer', members: ['user:a@example.com'] }],
    });

    expect(stored.etag).not.toBe(initial.etag);
    expect(stored.bindings).toEqual([
      { role: 'roles/storage.objectViewer', members: ['user:a@example.com'] },
    ]);
  });

  test('set rotates the etag and a stored policy returns the version it was given', async () => {
    await createObject('obj-iam', 'set.txt');

    const initial = await service.getObjectIamPolicy('obj-iam', 'set.txt');
    const first = await service.setObjectIamPolicy('obj-iam', 'set.txt', {
      bindings: [{ role: 'roles/storage.objectViewer', members: ['user:a@example.com'] }],
      etag: initial.etag,
    });

    expect(first.etag).not.toBe(initial.etag);
    expect(first.etag.length).toBeGreaterThan(0);
    expect(first.version).toBe(1);
    expect(first.kind).toBe('storage#policy');
    expect(first.resourceId).toBe('projects/_/buckets/obj-iam/objects/set.txt');

    const second = await service.setObjectIamPolicy('obj-iam', 'set.txt', {
      version: 3,
      etag: first.etag,
      bindings: [
        {
          role: 'roles/storage.objectViewer',
          members: ['user:a@example.com'],
          condition: {
            title: 'before-2027',
            expression: 'request.time < timestamp("2027-01-01T00:00:00Z")',
          },
        },
      ],
    });

    expect(second.etag).not.toBe(first.etag);
    expect(second.version).toBe(3);

    const stored = await service.getObjectIamPolicy('obj-iam', 'set.txt');

    expect(stored.version).toBe(3);
    expect(stored.etag).toBe(second.etag);
    expect(stored.bindings).toEqual(second.bindings);
  });

  test('resending the previous etag is rejected and leaves the stored policy', async () => {
    await createObject('obj-iam', 'stale.txt');

    const initial = await service.getObjectIamPolicy('obj-iam', 'stale.txt');
    const first = await service.setObjectIamPolicy('obj-iam', 'stale.txt', {
      etag: initial.etag,
      bindings: [{ role: 'roles/storage.objectViewer', members: ['user:a@example.com'] }],
    });
    const second = await service.setObjectIamPolicy('obj-iam', 'stale.txt', {
      etag: first.etag,
      bindings: [{ role: 'roles/storage.admin', members: ['user:b@example.com'] }],
    });

    const stale = service.setObjectIamPolicy('obj-iam', 'stale.txt', {
      etag: first.etag,
      bindings: [],
    });

    await expect(stale).rejects.toBeInstanceOf(GcsError);
    await expect(stale).rejects.toHaveProperty('code', 'ABORTED');

    const stored = await service.getObjectIamPolicy('obj-iam', 'stale.txt');

    expect(stored.etag).toBe(second.etag);
    expect(stored.bindings).toEqual(second.bindings);
  });

  test('a missing etag overwrites, including an empty binding list', async () => {
    await createObject('obj-iam', 'overwrite.txt');

    const initial = await service.getObjectIamPolicy('obj-iam', 'overwrite.txt');
    const first = await service.setObjectIamPolicy('obj-iam', 'overwrite.txt', {
      etag: initial.etag,
      version: 3,
      bindings: [{ role: 'roles/storage.admin', members: ['user:a@example.com'] }],
    });

    const overwritten = await service.setObjectIamPolicy('obj-iam', 'overwrite.txt', {
      bindings: [{ role: 'roles/storage.objectAdmin', members: ['allUsers'] }],
    });

    expect(overwritten.etag).not.toBe(first.etag);
    expect(overwritten.bindings).toEqual([
      { role: 'roles/storage.objectAdmin', members: ['allUsers'] },
    ]);

    const cleared = await service.setObjectIamPolicy('obj-iam', 'overwrite.txt', { bindings: [] });

    expect(cleared.version).toBe(1);
    expect(cleared.bindings).toEqual([]);
    expect(cleared.etag.length).toBeGreaterThan(0);
    expect(cleared.etag).not.toBe(overwritten.etag);

    const stored = await service.getObjectIamPolicy('obj-iam', 'overwrite.txt');

    expect(stored.version).toBe(1);
    expect(stored.bindings).toEqual([]);
    expect(stored.etag).toBe(cleared.etag);
  });

  test('a blank etag is an unconditional write', async () => {
    await createObject('obj-iam', 'blank.txt');

    const initial = await service.getObjectIamPolicy('obj-iam', 'blank.txt');
    await service.setObjectIamPolicy('obj-iam', 'blank.txt', {
      etag: initial.etag,
      bindings: [{ role: 'roles/storage.admin', members: ['user:a@example.com'] }],
    });

    const cleared = await service.setObjectIamPolicy('obj-iam', 'blank.txt', {
      bindings: [],
      etag: '',
    });

    expect(cleared.bindings).toEqual([]);
    expect(cleared.etag).not.toBe(initial.etag);
    expect(cleared.etag.length).toBeGreaterThan(0);
  });

  test('an empty binding list with a stale etag is not an unconditional write', async () => {
    await createObject('obj-iam', 'empty-stale.txt');

    const initial = await service.getObjectIamPolicy('obj-iam', 'empty-stale.txt');
    const first = await service.setObjectIamPolicy('obj-iam', 'empty-stale.txt', {
      etag: initial.etag,
      bindings: [{ role: 'roles/storage.admin', members: ['user:a@example.com'] }],
    });

    const stale = service.setObjectIamPolicy('obj-iam', 'empty-stale.txt', {
      etag: initial.etag,
      bindings: [],
    });

    await expect(stale).rejects.toHaveProperty('code', 'ABORTED');

    const stored = await service.getObjectIamPolicy('obj-iam', 'empty-stale.txt');

    expect(stored.etag).toBe(first.etag);
    expect(stored.bindings).toEqual(first.bindings);
  });

  test('testIamPermissions echoes the requested permissions and does not read the policy', async () => {
    await createObject('obj-iam', 'echo.txt');

    await service.setObjectIamPolicy('obj-iam', 'echo.txt', {
      bindings: [{ role: 'roles/storage.objectViewer', members: ['user:a@example.com'] }],
    });

    const echoed = await service.testObjectIamPermissions('obj-iam', 'echo.txt', [
      'storage.objects.get',
      'storage.objects.delete',
      'not.a.real.permission',
    ]);

    expect(echoed.kind).toBe('storage#testIamPermissionsResponse');
    expect(echoed.permissions).toEqual([
      'storage.objects.get',
      'storage.objects.delete',
      'not.a.real.permission',
    ]);
  });

  test('missing object is NOT_FOUND for get, set, and test', async () => {
    await buckets.createBucket('proj', { name: 'obj-iam' });

    const getPromise = service.getObjectIamPolicy('obj-iam', 'missing.txt');
    await expect(getPromise).rejects.toHaveProperty('code', 'NOT_FOUND');

    const setPromise = service.setObjectIamPolicy('obj-iam', 'missing.txt', { bindings: [] });
    await expect(setPromise).rejects.toHaveProperty('code', 'NOT_FOUND');

    const testPromise = service.testObjectIamPermissions('obj-iam', 'missing.txt', [
      'storage.objects.get',
    ]);
    await expect(testPromise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('invalid policy body is INVALID_ARGUMENT', async () => {
    await createObject('obj-iam', 'bad.txt');

    const promise = service.setObjectIamPolicy('obj-iam', 'bad.txt', { bindings: [{ role: '' }] });

    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('input resourceId is ignored', async () => {
    await createObject('obj-iam', 'resource.txt');

    const stored = await service.setObjectIamPolicy('obj-iam', 'resource.txt', {
      resourceId: 'objects/resource.txt',
      kind: 'storage#policy',
      bindings: [{ role: 'roles/storage.admin', members: ['user:a@example.com'] }],
    });

    expect(stored.resourceId).toBe('projects/_/buckets/obj-iam/objects/resource.txt');
  });

  test('an object policy does not replace the bucket policy in the same store', async () => {
    await createObject('obj-iam', 'shared.txt');

    const bucketPolicy = await service.setIamPolicy('obj-iam', {
      bindings: [{ role: 'roles/storage.admin', members: ['user:bucket@example.com'] }],
    });
    const objectPolicy = await service.setObjectIamPolicy('obj-iam', 'shared.txt', {
      version: 3,
      bindings: [{ role: 'roles/storage.objectViewer', members: ['user:object@example.com'] }],
    });

    const bucketStored = await service.getIamPolicy('obj-iam');
    const objectStored = await service.getObjectIamPolicy('obj-iam', 'shared.txt');

    expect(bucketStored.etag).toBe(bucketPolicy.etag);
    expect(bucketStored.bindings).toEqual(bucketPolicy.bindings);
    expect(bucketStored.resourceId).toBe('projects/_/buckets/obj-iam');
    expect(objectStored.etag).toBe(objectPolicy.etag);
    expect(objectStored.version).toBe(3);
    expect(objectStored.bindings).toEqual(objectPolicy.bindings);
  });

  test('deleting an object drops its IAM policy', async () => {
    await createObject('obj-iam', 'recreate.txt');
    await service.setObjectIamPolicy('obj-iam', 'recreate.txt', {
      bindings: [{ role: 'roles/storage.admin', members: ['user:a@example.com'] }],
    });

    await objects.deleteObject('obj-iam', 'recreate.txt');
    await objects.insertObject('obj-iam', 'recreate.txt', new TextEncoder().encode('again'));

    const policy = await service.getObjectIamPolicy('obj-iam', 'recreate.txt');

    expect(policy.version).toBe(1);
    expect(policy.bindings).toEqual([]);
    expect(policy.resourceId).toBe('projects/_/buckets/obj-iam/objects/recreate.txt');
  });

  test('replacing an object drops its IAM policy', async () => {
    await createObject('obj-iam', 'replace.txt');
    await service.setObjectIamPolicy('obj-iam', 'replace.txt', {
      version: 3,
      bindings: [{ role: 'roles/storage.admin', members: ['user:a@example.com'] }],
    });

    await objects.insertObject('obj-iam', 'replace.txt', new TextEncoder().encode('new-bytes'));

    const policy = await service.getObjectIamPolicy('obj-iam', 'replace.txt');

    expect(policy.version).toBe(1);
    expect(policy.bindings).toEqual([]);
  });

  test('a set queued behind a delete does not restore the deleted policy', async () => {
    await createObject('obj-iam', 'queue.txt');
    await service.setObjectIamPolicy('obj-iam', 'queue.txt', {
      bindings: [{ role: 'roles/storage.admin', members: ['user:a@example.com'] }],
    });

    let release = () => {};

    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    const holder = writes.runExclusively(
      'projects/_/buckets/obj-iam/objects/queue.txt',
      () => released
    );

    await Bun.sleep(5);

    const deletePromise = objects.deleteObject('obj-iam', 'queue.txt');
    const setPromise = service.setObjectIamPolicy('obj-iam', 'queue.txt', {
      bindings: [{ role: 'roles/storage.admin', members: ['user:a@example.com'] }],
    });

    release();

    const [deleted, set] = await Promise.allSettled([deletePromise, setPromise, holder]);

    expect(deleted.status).toBe('fulfilled');
    expect(set.status).toBe('rejected');

    const setRejection = set as PromiseRejectedResult;

    expect(setRejection.reason).toBeInstanceOf(GcsError);
    expect(setRejection.reason).toHaveProperty('code', 'NOT_FOUND');

    await objects.insertObject('obj-iam', 'queue.txt', new TextEncoder().encode('again'));

    const policy = await service.getObjectIamPolicy('obj-iam', 'queue.txt');

    expect(policy.version).toBe(1);
    expect(policy.bindings).toEqual([]);
  });
});
