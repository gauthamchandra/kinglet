/**
 * Translation between kinglet's user-facing storage settings and the
 * {@link StorageConfig} the storage providers actually consume.
 *
 * <p>The two vocabularies differ: a user configures `STORAGE_TYPE` and
 * `SQLITE_PATH`, while a provider is handed `{ type, database: { path } }`.
 * Nothing bridged them, so the configured path was silently dropped and every
 * storage type — including `sqlite` and `hybrid` — opened an anonymous
 * in-memory database that vanished on restart. This module is that bridge, in
 * one place, so the mapping is testable rather than buried in the entrypoint.
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
}

/** Bun's SQLite name for an anonymous, non-durable database. */
const IN_MEMORY_DATABASE = ':memory:';

export function toStorageConfig(settings: EmulatorStorageSettings): StorageConfig {
  // `memory` is backed by a provider that never touches the filesystem, so a
  // configured path is meaningless there rather than merely unused — passing
  // it on would suggest a durability this type deliberately does not offer.
  if (settings.type === 'memory') {
    return { type: 'memory' };
  }

  return {
    type: settings.type,
    database: { path: settings.sqlitePath ?? IN_MEMORY_DATABASE },
  };
}
