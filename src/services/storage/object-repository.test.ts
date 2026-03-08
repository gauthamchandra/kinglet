import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { ObjectRepository } from './object-repository.ts';
import { requestToObjectRecord } from './types.ts';

function makeObjectData(overrides: Partial<ReturnType<typeof requestToObjectRecord>> = {}) {
  return {
    ...requestToObjectRecord('test-bucket', 'test.txt', {
      size: 11,
      md5Hash: 'abc==',
      crc32c: 'def==',
      blobPath: '/tmp/blob/hash',
      contentType: 'text/plain',
    }),
    ...overrides,
  };
}

describe('ObjectRepository', () => {
  let storage: StorageManager;
  let repo: ObjectRepository;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new ObjectRepository(storage);
    await repo.initialize();
  });

  test('createObject creates and returns ObjectRecord', async () => {
    const data = makeObjectData();
    const result = await repo.createObject(data);

    expect(result.name).toBe('test.txt');
    expect(result.bucket).toBe('test-bucket');
    expect(result.id).toBeTypeOf('string');
  });

  test('same name in different buckets is OK', async () => {
    const data1 = makeObjectData({ bucket: 'bucket-a' });
    const data2 = makeObjectData({ bucket: 'bucket-b' });

    const r1 = await repo.createObject(data1);
    const r2 = await repo.createObject(data2);

    expect(r1.bucket).toBe('bucket-a');
    expect(r2.bucket).toBe('bucket-b');
  });

  test('getObject returns by bucket+name', async () => {
    await repo.createObject(makeObjectData());

    const found = await repo.getObject('test-bucket', 'test.txt');
    expect(found?.name).toBe('test.txt');
  });

  test('getObject returns null for nonexistent', async () => {
    const found = await repo.getObject('test-bucket', 'nope');
    expect(found).toBeNull();
  });

  test('getObject filters by generation', async () => {
    const data = makeObjectData({ generation: '12345' });
    await repo.createObject(data);

    const found = await repo.getObject('test-bucket', 'test.txt', '12345');
    expect(found?.generation).toBe('12345');

    const notFound = await repo.getObject('test-bucket', 'test.txt', '99999');
    expect(notFound).toBeNull();
  });

  test('listObjects returns all in bucket', async () => {
    await repo.createObject(makeObjectData({ name: 'a.txt', generation: '1' }));
    await repo.createObject(makeObjectData({ name: 'b.txt', generation: '2' }));

    const result = await repo.listObjects('test-bucket');
    expect(result.objects).toHaveLength(2);
  });

  test('listObjects filters by prefix', async () => {
    await repo.createObject(makeObjectData({ name: 'docs/a.txt', generation: '1' }));
    await repo.createObject(makeObjectData({ name: 'docs/b.txt', generation: '2' }));
    await repo.createObject(makeObjectData({ name: 'images/c.png', generation: '3' }));

    const result = await repo.listObjects('test-bucket', { prefix: 'docs/' });
    expect(result.objects).toHaveLength(2);
  });

  test('listObjects with delimiter returns prefixes', async () => {
    await repo.createObject(makeObjectData({ name: 'folder/a.txt', generation: '1' }));
    await repo.createObject(makeObjectData({ name: 'folder/b.txt', generation: '2' }));
    await repo.createObject(makeObjectData({ name: 'root.txt', generation: '3' }));

    const result = await repo.listObjects('test-bucket', { delimiter: '/' });
    expect(result.prefixes).toContain('folder/');
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0]?.name).toBe('root.txt');
  });

  test('listObjects supports pagination', async () => {
    await repo.createObject(makeObjectData({ name: 'a.txt', generation: '1' }));
    await repo.createObject(makeObjectData({ name: 'b.txt', generation: '2' }));
    await repo.createObject(makeObjectData({ name: 'c.txt', generation: '3' }));

    const page1 = await repo.listObjects('test-bucket', { maxResults: 2 });
    expect(page1.objects).toHaveLength(2);
    expect(page1.nextPageToken).toBeTypeOf('string');

    const page2Opts: { maxResults: number; pageToken?: string } = { maxResults: 2 };

    if (page1.nextPageToken) page2Opts.pageToken = page1.nextPageToken;

    const page2 = await repo.listObjects('test-bucket', page2Opts);
    expect(page2.objects).toHaveLength(1);
    expect(page2.nextPageToken).toBeUndefined();
  });

  test('updateObject updates metadata', async () => {
    await repo.createObject(makeObjectData());

    const updated = await repo.updateObject('test-bucket', 'test.txt', {
      metadata: '{"key":"val"}',
    });
    expect(updated?.metadata).toBe('{"key":"val"}');
  });

  test('updateObject returns null for nonexistent', async () => {
    const result = await repo.updateObject('test-bucket', 'nope', { metadata: '{}' });
    expect(result).toBeNull();
  });

  test('deleteObject returns true', async () => {
    await repo.createObject(makeObjectData());

    const deleted = await repo.deleteObject('test-bucket', 'test.txt');
    expect(deleted).toBe(true);

    const found = await repo.getObject('test-bucket', 'test.txt');
    expect(found).toBeNull();
  });

  test('deleteObject returns false for nonexistent', async () => {
    const result = await repo.deleteObject('test-bucket', 'nope');
    expect(result).toBe(false);
  });

  test('deleteObjectsByBucket deletes all and returns count', async () => {
    await repo.createObject(makeObjectData({ name: 'a.txt', generation: '1' }));
    await repo.createObject(makeObjectData({ name: 'b.txt', generation: '2' }));

    const count = await repo.deleteObjectsByBucket('test-bucket');
    expect(count).toBe(2);

    const result = await repo.listObjects('test-bucket');
    expect(result.objects).toHaveLength(0);
  });

  test('countObjectsInBucket returns count', async () => {
    await repo.createObject(makeObjectData({ name: 'a.txt', generation: '1' }));
    await repo.createObject(makeObjectData({ name: 'b.txt', generation: '2' }));

    const count = await repo.countObjectsInBucket('test-bucket');
    expect(count).toBe(2);
  });

  test('countObjectsInBucket returns 0 for empty bucket', async () => {
    const count = await repo.countObjectsInBucket('empty-bucket');
    expect(count).toBe(0);
  });
});
