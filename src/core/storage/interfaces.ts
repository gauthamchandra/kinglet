/**
 * Storage Layer Interfaces
 *
 * This module defines the main interfaces for the storage abstraction layer.
 */

import type {
  CacheOperations,
  StorageConfig,
  StorageOperations,
  StorageProvider,
  TableSchema,
  TransactionOptions,
} from './types.js';

/**
 * Storage Manager Interface
 *
 * The main interface for the storage layer that provides a unified API
 * for all storage operations including transactions and caching.
 */
export interface IStorageManager extends StorageOperations {
  /**
   * Initialize the storage manager with configuration
   */
  initialize(config: StorageConfig): Promise<void>;

  /**
   * Get the underlying storage provider
   */
  getProvider(): StorageProvider;

  /**
   * Get cache operations if available
   */
  getCache(): CacheOperations | null;

  /**
   * Execute operations within a transaction
   */
  withTransaction<T>(
    fn: (tx: StorageOperations) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T>;

  /**
   * Create or update table schema
   */
  createTable(name: string, schema: TableSchema): Promise<void>;

  /**
   * Drop a table
   */
  dropTable(name: string): Promise<void>;

  /**
   * List all tables
   */
  listTables(): Promise<string[]>;

  /**
   * Check storage health
   */
  healthCheck(): Promise<boolean>;

  /**
   * Get storage statistics
   */
  getStats(): Promise<StorageStats>;

  /**
   * Close all connections and cleanup resources
   */
  close(): Promise<void>;
}

/**
 * Storage statistics
 */
export interface StorageStats {
  readonly provider: string;
  readonly tablesCount: number;
  readonly totalRecords: number;
  readonly cacheStats?: {
    readonly hits: number;
    readonly misses: number;
    readonly entries: number;
    readonly hitRate: number;
  };
  readonly performance: {
    readonly avgQueryTime: number; // milliseconds
    readonly totalQueries: number;
    readonly activeTransactions: number;
  };
}

/**
 * Event-based storage interface for notifications
 */
export interface IStorageEventEmitter {
  /**
   * Subscribe to storage events
   */
  on(event: StorageEvent, listener: StorageEventListener): void;

  /**
   * Unsubscribe from storage events
   */
  off(event: StorageEvent, listener: StorageEventListener): void;

  /**
   * Emit a storage event
   */
  emit(event: StorageEvent, data: StorageEventData): void;
}

/**
 * Storage event types
 */
export type StorageEvent =
  | 'record:created'
  | 'record:updated'
  | 'record:deleted'
  | 'table:created'
  | 'table:dropped'
  | 'transaction:started'
  | 'transaction:committed'
  | 'transaction:rollback'
  | 'cache:hit'
  | 'cache:miss'
  | 'error';

/**
 * Storage event data
 */
export interface StorageEventData {
  readonly table?: string;
  readonly recordId?: string;
  readonly operation?: string;
  readonly timestamp: Date;
  readonly metadata?: Record<string, unknown>;
  readonly error?: Error;
}

/**
 * Storage event listener function
 */
export type StorageEventListener = (data: StorageEventData) => void | Promise<void>;
