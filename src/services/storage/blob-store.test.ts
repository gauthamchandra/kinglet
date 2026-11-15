import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, rmSync } from 'node:fs';
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
      const basePath = store.getBasePath();
      store.cleanup();
      rmSync(basePath, { recursive: true, force: true });
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

  test('delete drops the path so cleanup leaves a file written there later', async () => {
    const store = createStore();
    const data = new TextEncoder().encode('data');
    const { blobPath } = await store.store('bucket', 'obj', '1', data);

    expect(await store.delete(blobPath)).toBe(true);
    await Bun.write(blobPath, 'replacement');

    store.cleanup();

    expect(existsSync(blobPath)).toBe(true);
  });

  test('failed delete keeps the path so cleanup can still remove it', async () => {
    const store = createStore();
    const data = new TextEncoder().encode('data');
    const { blobPath } = await store.store('bucket', 'obj', '1', data);
    const realRmSync = fs.rmSync;
    const rm = spyOn(fs, 'rmSync').mockImplementation(((
      path: Parameters<typeof fs.rmSync>[0],
      options?: Parameters<typeof fs.rmSync>[1]
    ) => {
      if (path === blobPath && options?.force !== true) {
        throw new Error('EACCES');
      }

      return realRmSync(path, options);
    }) as typeof fs.rmSync);

    try {
      await expect(store.delete(blobPath)).rejects.toThrow('EACCES');
      expect(existsSync(blobPath)).toBe(true);
    } finally {
      rm.mockRestore();
    }

    store.cleanup();
    expect(existsSync(blobPath)).toBe(false);
  });

  test('computeHashes produces correct md5 and crc32c for known input', () => {
    const store = createStore();
    const data = new TextEncoder().encode('Hello GCS');

    const { md5Hash, crc32c } = store.computeHashes(data);

    expect(md5Hash).toBe('qc+AIzFTDNo+rg05FooMzw==');
    expect(crc32c).toBe('9IpBvg==');
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

  test('two stores on one root with the same generation do not share a file', async () => {
    const basePath = join(tmpdir(), `blob-test-${crypto.randomUUID()}`);
    const first = new BlobStore(basePath);
    const second = new BlobStore(basePath);

    stores.push(first, second);

    const data = new TextEncoder().encode('same-ms');
    const generation = '1700000000000001';
    const a = await first.store('bucket', 'obj', generation, data);
    const b = await second.store('bucket', 'obj', generation, data);

    expect(a.blobPath).not.toBe(b.blobPath);
    expect(await first.retrieve(a.blobPath)).toEqual(data);
    expect(await second.retrieve(b.blobPath)).toEqual(data);

    first.cleanup();

    expect(existsSync(a.blobPath)).toBe(false);
    expect(existsSync(b.blobPath)).toBe(true);
  });

  test('cleanup removes only files this store wrote', async () => {
    const store = createStore();
    const basePath = store.getBasePath();
    const preexisting = join(basePath, 'already-there.txt');

    await Bun.write(preexisting, 'keep');

    const { blobPath } = await store.store('bucket', 'obj', '1', new TextEncoder().encode('data'));

    store.cleanup();

    expect(existsSync(blobPath)).toBe(false);
    expect(existsSync(preexisting)).toBe(true);
    expect(existsSync(basePath)).toBe(true);
  });

  test('cleanup continues after one unlink fails', async () => {
    const store = createStore();
    const data = new TextEncoder().encode('data');
    const first = await store.store('bucket', 'a', '1', data);
    const second = await store.store('bucket', 'b', '1', data);
    const realRmSync = fs.rmSync;
    const rm = spyOn(fs, 'rmSync').mockImplementation(((
      path: Parameters<typeof fs.rmSync>[0],
      options?: Parameters<typeof fs.rmSync>[1]
    ) => {
      if (path === first.blobPath) {
        throw new Error('EACCES');
      }

      return realRmSync(path, options);
    }) as typeof fs.rmSync);

    try {
      expect(() => store.cleanup()).not.toThrow();
      expect(existsSync(first.blobPath)).toBe(true);
      expect(existsSync(second.blobPath)).toBe(false);
    } finally {
      rm.mockRestore();
    }

    store.cleanup();
    expect(existsSync(first.blobPath)).toBe(false);
  });

  test('does not track writes when tracking is off', async () => {
    const basePath = join(tmpdir(), `blob-test-${crypto.randomUUID()}`);
    const store = new BlobStore(basePath, { trackWrittenPaths: false });
    stores.push(store);

    const { blobPath } = await store.store('bucket', 'obj', '1', new TextEncoder().encode('data'));

    store.cleanup();

    expect(existsSync(blobPath)).toBe(true);
  });
});
