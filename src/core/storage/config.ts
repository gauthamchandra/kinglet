/**
 * Translation between kinglet's user-facing storage settings and the
 * {@link StorageConfig} the storage providers actually consume.
 *
 * <p>The two vocabularies differ: a user configures `STORAGE_TYPE`,
 * `SQLITE_PATH`, and `CACHE_SIZE`, while a provider is handed
 * `{ type, database: { path }, cache: { maxMemoryMb } }`. Nothing bridged
 * them, so the configured path was silently dropped and every storage type —
 * including `sqlite` and `hybrid` — opened an anonymous in-memory database
 * that vanished on restart. This module is that bridge, in one place, so the
 * mapping is testable rather than buried in the entrypoint.
 */

import type { StorageConfig, StorageType } from './types.js';

/**
 * The storage settings as a kinglet user configures them (see
 * `src/config/schema.ts`). Declared structurally rather than imported from the
 * config module so the storage layer stays free of a dependency on it.
 */
export interface EmulatorStorageSettings {
  readonly type: StorageType;
  readonly sqlitePath?: string | undefined;
  /** LRU cache budget in bytes (only consumed by `hybrid`). */
  readonly cacheSize?: number | undefined;
}

/** Bun's SQLite name for an anonymous, non-durable database. */
const IN_MEMORY_DATABASE = ':memory:';

/** Matches the Zod default for `storage.cacheSize` (100 MB). */
const DEFAULT_CACHE_SIZE_BYTES = 104857600;

/** Entry-count ceiling; the byte budget from `cacheSize` is the real limit. */
const DEFAULT_CACHE_MAX_ENTRIES = 10_000;

export function toStorageConfig(settings: EmulatorStorageSettings): StorageConfig {
  // `memory` is backed by a provider that never touches the filesystem, so a
  // configured path is meaningless there rather than merely unused — passing
  // it on would suggest a durability this type deliberately does not offer.
  if (settings.type === 'memory') {
    return { type: 'memory' };
  }

  const config: StorageConfig = {
    type: settings.type,
    database: { path: settings.sqlitePath ?? IN_MEMORY_DATABASE },
  };

  // `hybrid` is SQLite plus an LRU cache. `cacheSize` is bytes on the
  // emulator surface and megabytes on the provider surface — convert here so
  // callers never have to know both units. The division is left exact, since
  // rounding to whole megabytes would hand the cache a different budget than
  // the one configured. A zero budget means "no cache", which makes hybrid
  // behave like sqlite.
  if (settings.type === 'hybrid') {
    const cacheSizeBytes = settings.cacheSize ?? DEFAULT_CACHE_SIZE_BYTES;

    if (cacheSizeBytes > 0) {
      return {
        ...config,
        cache: {
          maxSize: DEFAULT_CACHE_MAX_ENTRIES,
          maxMemoryMb: cacheSizeBytes / (1024 * 1024),
        },
      };
    }
  }

  return config;
}
