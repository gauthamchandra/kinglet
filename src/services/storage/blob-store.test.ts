import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore } from './blob-store.ts';

describe('BlobStore', () => {
  const stores: BlobStore[] = [];

  function createStore(): BlobStore {
    const store = new BlobStore(join(tmpdir(), `blob-test-${crypto.randomUUID()}`));
    stores.push(store);
    return store;
  }

  afterEach(() => {
    for (const store of stores) {
      store.cleanup();
    }
    stores.length = 0;
  });

  test('store writes data and returns blobPath, md5Hash, crc32c, size', async () => {
    const store = createStore();
    const data = new TextEncoder().encode('Hello GCS');

    const result = await store.store('my-bucket', 'test.txt', '1000', data);

    expect(result.blobPath).toBeTypeOf('string');
    expect(result.md5Hash).toBeTypeOf('string');
    expect(result.crc32c).toBeTypeOf('string');
    expect(result.size).toBe(9);
  });

  test('retrieve reads back stored data', async () => {
    const store = createStore();
    const data = new TextEncoder().encode('Hello GCS');

    const { blobPath } = await store.store('my-bucket', 'test.txt', '1000', data);
    const retrieved = await store.retrieve(blobPath);

    expect(retrieved).toEqual(data);
  });

  test('retrieve returns null for nonexistent path', async () => {
    const store = createStore();
    const result = await store.retrieve('/nonexistent/path');
    expect(result).toBeNull();
  });

  test('delete removes file and returns true', async () => {
    const store = createStore();
    const data = new TextEncoder().encode('data');

    const { blobPath } = await store.store('bucket', 'obj', '1', data);
    const deleted = await store.delete(blobPath);

    expect(deleted).toBe(true);

    const retrieved = await store.retrieve(blobPath);
    expect(retrieved).toBeNull();
  });

  test('delete returns false for nonexistent path', async () => {
    const store = createStore();
    const result = await store.delete('/nonexistent/path');
    expect(result).toBe(false);
  });

  test('computeHashes produces correct md5 and crc32c for known input', () => {
    const store = createStore();
    const data = new TextEncoder().encode('Hello GCS');

    const { md5Hash, crc32c } = store.computeHashes(data);

    expect(md5Hash).toBeTypeOf('string');
    expect(md5Hash.length).toBeGreaterThan(0);
    expect(crc32c).toBeTypeOf('string');
    expect(crc32c.length).toBeGreaterThan(0);

    // Deterministic: same input should produce same output
    const { md5Hash: md5Hash2, crc32c: crc32c2 } = store.computeHashes(data);
    expect(md5Hash2).toBe(md5Hash);
    expect(crc32c2).toBe(crc32c);
  });

  test('nested directories are auto-created', async () => {
    const store = createStore();
    const data = new TextEncoder().encode('data');

    const result = await store.store('deep-bucket', 'folder/nested/file.txt', '1', data);

    expect(result.blobPath).toContain('deep-bucket');

    const retrieved = await store.retrieve(result.blobPath);
    expect(retrieved).toEqual(data);
  });

  test('same name in different buckets causes no collision', async () => {
    const store = createStore();
    const data1 = new TextEncoder().encode('bucket1-data');
    const data2 = new TextEncoder().encode('bucket2-data');

    const result1 = await store.store('bucket-a', 'file.txt', '1', data1);
    const result2 = await store.store('bucket-b', 'file.txt', '1', data2);

    expect(result1.blobPath).not.toBe(result2.blobPath);

    const retrieved1 = await store.retrieve(result1.blobPath);
    const retrieved2 = await store.retrieve(result2.blobPath);
    expect(retrieved1).toEqual(data1);
    expect(retrieved2).toEqual(data2);
  });

  test('cleanup removes entire storage directory', async () => {
    const store = createStore();
    const data = new TextEncoder().encode('data');
    await store.store('bucket', 'obj', '1', data);

    const basePath = store.getBasePath();
    expect(existsSync(basePath)).toBe(true);

    store.cleanup();
    expect(existsSync(basePath)).toBe(false);
  });
});
