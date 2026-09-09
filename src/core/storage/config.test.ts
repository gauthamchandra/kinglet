/**
 * Tests for the storage settings translation
 */

import { describe, expect, test } from 'bun:test';
import { toStorageConfig } from './config.ts';

describe('toStorageConfig', () => {
  test('gives sqlite storage the configured path', () => {
    expect(toStorageConfig({ type: 'sqlite', sqlitePath: './data/emulator.db' })).toEqual({
      type: 'sqlite',
      database: { path: './data/emulator.db' },
    });
  });

  test('gives hybrid storage the configured path and cache budget', () => {
    // Regression guard: hybrid is the default storage type, so dropping the
    // path here silently turned every default deployment in-memory. The cache
    // budget is what makes hybrid distinct from sqlite.
    expect(toStorageConfig({ type: 'hybrid', sqlitePath: '/var/lib/kinglet.db' })).toEqual({
      type: 'hybrid',
      database: { path: '/var/lib/kinglet.db' },
      cache: { maxSize: 10_000, maxMemoryMb: 100 },
    });
  });

  test('converts a custom cacheSize from bytes to megabytes for hybrid', () => {
    expect(
      toStorageConfig({
        type: 'hybrid',
        sqlitePath: './data/emulator.db',
        cacheSize: 50 * 1024 * 1024,
      })
    ).toEqual({
      type: 'hybrid',
      database: { path: './data/emulator.db' },
      cache: { maxSize: 10_000, maxMemoryMb: 50 },
    });
  });

  test('omits the cache when hybrid is given a zero cacheSize', () => {
    expect(
      toStorageConfig({ type: 'hybrid', sqlitePath: './data/emulator.db', cacheSize: 0 })
    ).toEqual({
      type: 'hybrid',
      database: { path: './data/emulator.db' },
    });
  });

  test('does not attach a cache to pure sqlite even when cacheSize is set', () => {
    expect(
      toStorageConfig({
        type: 'sqlite',
        sqlitePath: './data/emulator.db',
        cacheSize: 104857600,
      })
    ).toEqual({
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
