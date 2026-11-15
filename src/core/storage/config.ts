/**
 * Translation between kinglet's user-facing storage settings and the
 * {@link StorageConfig} the storage providers actually consume.
 *
 * <p>The two vocabularies differ: a user configures `STORAGE_TYPE` and
 * `SQLITE_PATH`, while a provider is handed `{ type, database: { path } }`.
 * Nothing bridged them, so the configured path was silently dropped and every
 * durable storage type opened an anonymous in-memory database that vanished on
 * restart. This module is that bridge, in one place, so the mapping is
 * testable rather than buried in the entrypoint.
 *
 * Object bytes are separate from that provider config. `resolveBlobPath`
 * turns `BLOB_PATH` into one directory for both `memory` and `sqlite`.
 */

import { isAbsolute, parse, resolve, sep } from 'node:path';
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

/**
 * Relative paths are resolved from `process.cwd()`. Absolute paths are returned
 * unchanged so a later process can open the file without guessing the working
 * directory again.
 *
 * Empty, `.`, the working directory, a parent of it, and the filesystem root
 * are rejected. Those are not a blob directory.
 */
export function resolveBlobPath(blobPath: string): string {
  if (blobPath === '' || blobPath === '.') {
    throw new Error('BLOB_PATH must not be empty or "."');
  }

  const resolved = isAbsolute(blobPath) ? blobPath : resolve(process.cwd(), blobPath);
  const normalized = resolve(resolved);

  if (isUnsafeBlobRoot(normalized)) {
    throw new Error(
      `BLOB_PATH ${normalized} is the working directory, its parent, or the filesystem root`
    );
  }

  return resolved;
}

function isUnsafeBlobRoot(normalized: string): boolean {
  const cwd = resolve(process.cwd());
  const root = parse(normalized).root;

  if (normalized === root || normalized === cwd) {
    return true;
  }

  const prefix = normalized.endsWith(sep) ? normalized : normalized + sep;

  return cwd.startsWith(prefix);
}
