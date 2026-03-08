import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageManager } from '@/core/storage/manager.ts';
import { BlobStore } from './blob-store.ts';
import { BucketRepository } from './bucket-repository.ts';
import { GcsError } from './bucket-service.ts';
import { ObjectRepository } from './object-repository.ts';
import { ObjectService } from './object-service.ts';
import { requestToBucketRecord } from './types.ts';

describe('ObjectService', () => {
  let storage: StorageManager;
  let blobStore: BlobStore;
  let bucketRepo: BucketRepository;
  let objectRepo: ObjectRepository;
  let service: ObjectService;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    blobStore = new BlobStore(join(tmpdir(), `obj-svc-test-${crypto.randomUUID()}`));

    bucketRepo = new BucketRepository(storage);
    await bucketRepo.initialize();

    objectRepo = new ObjectRepository(storage);
    await objectRepo.initialize();

    service = new ObjectService(objectRepo, bucketRepo, blobStore);

    // Create a default test bucket
    await bucketRepo.createBucket(
      requestToBucketRecord('test-bucket', { name: 'test-bucket' }, 'proj-1')
    );
  });

  afterEach(() => {
    blobStore.cleanup();
  });

  // ── insertObject ──

  test('insertObject uploads data and returns ObjectResponse', async () => {
    const data = new TextEncoder().encode('Hello GCS');
    const result = await service.insertObject('test-bucket', 'test.txt', data, {
      contentType: 'text/plain',
    });

    expect(result.kind).toBe('storage#object');
    expect(result.name).toBe('test.txt');
    expect(result.bucket).toBe('test-bucket');
    expect(result.size).toBe('9');
    expect(result.contentType).toBe('text/plain');
    expect(result.md5Hash).toBeTypeOf('string');
    expect(result.crc32c).toBeTypeOf('string');
    expect(result.generation).toBeTypeOf('string');
    expect(result.metageneration).toBe('1');
  });

  test('insertObject stores custom metadata', async () => {
    const data = new TextEncoder().encode('data');
    const result = await service.insertObject('test-bucket', 'meta.txt', data, {
      metadata: { key: 'val' },
    });
    expect(result.metadata).toEqual({ key: 'val' });
  });

  test('insertObject overwrites existing object', async () => {
    const data1 = new TextEncoder().encode('original');
    await service.insertObject('test-bucket', 'overwrite.txt', data1);

    const data2 = new TextEncoder().encode('replaced');
    const result = await service.insertObject('test-bucket', 'overwrite.txt', data2);

    expect(result.size).toBe('8');

    const media = await service.getObjectMedia('test-bucket', 'overwrite.txt');
    expect(new TextDecoder().decode(media)).toBe('replaced');
  });

  test('insertObject throws NOT_FOUND for nonexistent bucket', async () => {
    const data = new TextEncoder().encode('data');
    const promise = service.insertObject('nope-bucket', 'f.txt', data);
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── getObject ──

  test('getObject returns metadata', async () => {
    const data = new TextEncoder().encode('data');
    await service.insertObject('test-bucket', 'get-me.txt', data);

    const result = await service.getObject('test-bucket', 'get-me.txt');
    expect(result.name).toBe('get-me.txt');
    expect(result.kind).toBe('storage#object');
  });

  test('getObject throws NOT_FOUND', async () => {
    const promise = service.getObject('test-bucket', 'nope');
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── getObjectMedia ──

  test('getObjectMedia returns Uint8Array', async () => {
    const data = new TextEncoder().encode('binary data');
    await service.insertObject('test-bucket', 'media.txt', data);

    const media = await service.getObjectMedia('test-bucket', 'media.txt');
    expect(media).toEqual(data);
  });

  test('getObjectMedia throws NOT_FOUND', async () => {
    const promise = service.getObjectMedia('test-bucket', 'nope');
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── listObjects ──

  test('listObjects returns all in bucket', async () => {
    await service.insertObject('test-bucket', 'a.txt', new TextEncoder().encode('a'));
    await service.insertObject('test-bucket', 'b.txt', new TextEncoder().encode('b'));

    const result = await service.listObjects('test-bucket');
    expect(result.kind).toBe('storage#objects');
    expect(result.items).toHaveLength(2);
  });

  test('listObjects with prefix filter', async () => {
    await service.insertObject('test-bucket', 'docs/a.txt', new TextEncoder().encode('a'));
    await service.insertObject('test-bucket', 'images/b.png', new TextEncoder().encode('b'));

    const result = await service.listObjects('test-bucket', { prefix: 'docs/' });
    expect(result.items).toHaveLength(1);
    expect(result.items?.[0]?.name).toBe('docs/a.txt');
  });

  test('listObjects with delimiter returns prefixes', async () => {
    await service.insertObject('test-bucket', 'folder/a.txt', new TextEncoder().encode('a'));
    await service.insertObject('test-bucket', 'root.txt', new TextEncoder().encode('r'));

    const result = await service.listObjects('test-bucket', { delimiter: '/' });
    expect(result.prefixes).toContain('folder/');
    expect(result.items).toHaveLength(1);
  });

  test('listObjects with pagination', async () => {
    await service.insertObject('test-bucket', 'a.txt', new TextEncoder().encode('a'));
    await service.insertObject('test-bucket', 'b.txt', new TextEncoder().encode('b'));
    await service.insertObject('test-bucket', 'c.txt', new TextEncoder().encode('c'));

    const page1 = await service.listObjects('test-bucket', { maxResults: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextPageToken).toBeTypeOf('string');
  });

  test('listObjects throws NOT_FOUND for nonexistent bucket', async () => {
    const promise = service.listObjects('nope-bucket');
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── patchObject ──

  test('patchObject updates metadata', async () => {
    await service.insertObject('test-bucket', 'patch.txt', new TextEncoder().encode('data'));

    const result = await service.patchObject('test-bucket', 'patch.txt', {
      metadata: { key: 'val' },
    });
    expect(result.metadata).toEqual({ key: 'val' });
  });

  test('patchObject increments metageneration', async () => {
    await service.insertObject('test-bucket', 'meta.txt', new TextEncoder().encode('data'));

    const result = await service.patchObject('test-bucket', 'meta.txt', { metadata: {} });
    expect(result.metageneration).toBe('2');
  });

  test('patchObject throws NOT_FOUND', async () => {
    const promise = service.patchObject('test-bucket', 'nope', { metadata: {} });
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── deleteObject ──

  test('deleteObject deletes blob and record', async () => {
    await service.insertObject('test-bucket', 'del.txt', new TextEncoder().encode('data'));

    await service.deleteObject('test-bucket', 'del.txt');

    const promise = service.getObject('test-bucket', 'del.txt');
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('deleteObject throws NOT_FOUND', async () => {
    const promise = service.deleteObject('test-bucket', 'nope');
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── copyObject ──

  test('copyObject copies within same bucket', async () => {
    const data = new TextEncoder().encode('copy me');
    await service.insertObject('test-bucket', 'src.txt', data);

    const result = await service.copyObject('test-bucket', 'src.txt', 'test-bucket', 'dst.txt');
    expect(result.name).toBe('dst.txt');
    expect(result.bucket).toBe('test-bucket');

    const media = await service.getObjectMedia('test-bucket', 'dst.txt');
    expect(new TextDecoder().decode(media)).toBe('copy me');
  });

  test('copyObject copies cross-bucket', async () => {
    await bucketRepo.createBucket(
      requestToBucketRecord('bucket-b', { name: 'bucket-b' }, 'proj-1')
    );

    const data = new TextEncoder().encode('cross');
    await service.insertObject('test-bucket', 'src.txt', data);

    const result = await service.copyObject('test-bucket', 'src.txt', 'bucket-b', 'dst.txt');
    expect(result.bucket).toBe('bucket-b');
  });

  test('copyObject creates new generation', async () => {
    const data = new TextEncoder().encode('gen');
    const original = await service.insertObject('test-bucket', 'src.txt', data);

    const copy = await service.copyObject('test-bucket', 'src.txt', 'test-bucket', 'copy.txt');
    expect(copy.generation).not.toBe(original.generation);
  });

  test('copyObject throws NOT_FOUND if source missing', async () => {
    const promise = service.copyObject('test-bucket', 'nope', 'test-bucket', 'dst');
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('copyObject throws NOT_FOUND if dest bucket missing', async () => {
    await service.insertObject('test-bucket', 'src.txt', new TextEncoder().encode('d'));

    const promise = service.copyObject('test-bucket', 'src.txt', 'nope-bucket', 'dst');
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── rewriteObject ──

  test('rewriteObject returns done=true with resource', async () => {
    const data = new TextEncoder().encode('rewrite me');
    await service.insertObject('test-bucket', 'rw-src.txt', data);

    const result = await service.rewriteObject(
      'test-bucket',
      'rw-src.txt',
      'test-bucket',
      'rw-dst.txt'
    );
    expect(result.done).toBe(true);
    expect(result.kind).toBe('storage#rewriteResponse');
    expect(result.resource.name).toBe('rw-dst.txt');
    expect(result.totalBytesRewritten).toBe('10');
    expect(result.objectSize).toBe('10');
  });

  test('rewriteObject throws NOT_FOUND', async () => {
    const promise = service.rewriteObject('test-bucket', 'nope', 'test-bucket', 'dst');
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── composeObjects ──

  test('composeObjects concatenates 2 objects', async () => {
    await service.insertObject('test-bucket', 'p1.txt', new TextEncoder().encode('Hello '));
    await service.insertObject('test-bucket', 'p2.txt', new TextEncoder().encode('World'));

    const result = await service.composeObjects('test-bucket', 'composed.txt', {
      sourceObjects: [{ name: 'p1.txt' }, { name: 'p2.txt' }],
    });

    expect(result.name).toBe('composed.txt');

    const media = await service.getObjectMedia('test-bucket', 'composed.txt');
    expect(new TextDecoder().decode(media)).toBe('Hello World');
  });

  test('composeObjects handles up to 32 objects', async () => {
    for (let i = 0; i < 32; i++) {
      await service.insertObject('test-bucket', `part-${i}.txt`, new TextEncoder().encode(`${i}`));
    }

    const sourceObjects = Array.from({ length: 32 }, (_, i) => ({ name: `part-${i}.txt` }));
    const result = await service.composeObjects('test-bucket', 'big.txt', { sourceObjects });

    expect(result.name).toBe('big.txt');
  });

  test('composeObjects throws INVALID_ARGUMENT for empty sources', async () => {
    const promise = service.composeObjects('test-bucket', 'dst', { sourceObjects: [] });
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('composeObjects throws INVALID_ARGUMENT for 33+ sources', async () => {
    const sourceObjects = Array.from({ length: 33 }, (_, i) => ({ name: `obj-${i}` }));
    const promise = service.composeObjects('test-bucket', 'dst', { sourceObjects });
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('composeObjects throws NOT_FOUND if source missing', async () => {
    await service.insertObject('test-bucket', 'exist.txt', new TextEncoder().encode('x'));

    const promise = service.composeObjects('test-bucket', 'dst', {
      sourceObjects: [{ name: 'exist.txt' }, { name: 'nope.txt' }],
    });
    await expect(promise).rejects.toBeInstanceOf(GcsError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });
});
