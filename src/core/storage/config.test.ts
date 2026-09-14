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
