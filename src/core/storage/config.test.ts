/**
 * Tests for the storage settings translation
 */

import { describe, expect, test } from 'bun:test';
import { isAbsolute, resolve } from 'node:path';
import { resolveBlobPath, toStorageConfig } from './config.ts';

describe('toStorageConfig', () => {
  test('gives sqlite storage the configured path', () => {
    expect(toStorageConfig({ type: 'sqlite', sqlitePath: './data/emulator.db' })).toEqual({
      type: 'sqlite',
      database: { path: './data/emulator.db' },
    });
  });

  test('passes no path along for memory storage', () => {
    expect(toStorageConfig({ type: 'memory', sqlitePath: './data/emulator.db' })).toEqual({
      type: 'memory',
    });
  });

  test('falls back to an in-memory database when no path is configured', () => {
    expect(toStorageConfig({ type: 'sqlite' })).toEqual({
      type: 'sqlite',
      database: { path: ':memory:' },
    });
  });
});

describe('resolveBlobPath', () => {
  test('resolves a relative path from the working directory', () => {
    const resolved = resolveBlobPath('./data/blobs');

    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe(resolve(process.cwd(), 'data/blobs'));
  });

  test('leaves an absolute path unchanged', () => {
    expect(resolveBlobPath('/app/data/blobs')).toBe('/app/data/blobs');
  });

  test('rejects an empty path, dot, the working directory, its parent, and the filesystem root', () => {
    const rejected = ['', '.', '..', process.cwd(), '/', resolve(process.cwd(), '..')];

    for (const blobPath of rejected) {
      expect(() => resolveBlobPath(blobPath)).toThrow(/BLOB_PATH/);
    }
  });
});
