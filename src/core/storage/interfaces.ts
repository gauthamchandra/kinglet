/**
 * Storage Layer Interfaces
 *
 * This module defines the main interfaces for the storage abstraction layer.
 */

import type {
  BaseRecord,
  CacheOperations,
  QueryOptions,
  QueryResult,
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
 * Repository Pattern Interface
 *
 * A generic repository interface for domain-specific data access.
 * This provides a higher-level abstraction over the storage layer.
 */
export interface IRepository<T extends BaseRecord> {
  /**
   * Create a new entity
   */
  create(data: Omit<T, keyof BaseRecord>): Promise<T>;

  /**
   * Find an entity by ID
   */
  findById(id: string): Promise<T | null>;

  /**
   * Find entities matching criteria
   */
  find(options?: QueryOptions): Promise<QueryResult<T>>;

  /**
   * Find first entity matching criteria
   */
  findFirst(options?: QueryOptions): Promise<T | null>;

  /**
   * Update an entity by ID
   */
  updateById(id: string, data: Partial<Omit<T, keyof BaseRecord>>): Promise<T | null>;

  /**
   * Delete an entity by ID
   */
  deleteById(id: string): Promise<boolean>;

  /**
   * Check if an entity exists
   */
  exists(id: string): Promise<boolean>;

  /**
   * Count entities matching criteria
   */
  count(options?: QueryOptions): Promise<number>;
}

/**
 * Migration Interface
 *
 * Interface for database schema migrations
 */
export interface IMigration {
  /**
   * Migration version/identifier
   */
  readonly version: string;

  /**
   * Migration description
   */
  readonly description: string;

  /**
   * Apply the migration
   */
  up(provider: StorageProvider): Promise<void>;

  /**
   * Rollback the migration
   */
  down(provider: StorageProvider): Promise<void>;
}

/**
 * Migration Manager Interface
 */
export interface IMigrationManager {
  /**
   * Register a migration
   */
  register(migration: IMigration): void;

  /**
   * Run pending migrations
   */
  migrate(): Promise<void>;

  /**
   * Rollback to a specific version
   */
  rollback(version: string): Promise<void>;

  /**
   * Get migration status
   */
  getStatus(): Promise<MigrationStatus[]>;
}

/**
 * Migration status information
 */
export interface MigrationStatus {
  readonly version: string;
  readonly description: string;
  readonly appliedAt?: Date;
  readonly status: 'pending' | 'applied' | 'failed';
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

/**
 * Query builder interface for constructing complex queries
 */
export interface IQueryBuilder<T extends BaseRecord> {
  /**
   * Add WHERE condition
   */
  where(field: keyof T, operator: string, value: unknown): IQueryBuilder<T>;

  /**
   * Add AND condition
   */
  and(field: keyof T, operator: string, value: unknown): IQueryBuilder<T>;

  /**
   * Add OR condition
   */
  or(field: keyof T, operator: string, value: unknown): IQueryBuilder<T>;

  /**
   * Add ORDER BY clause
   */
  orderBy(field: keyof T, direction?: 'asc' | 'desc'): IQueryBuilder<T>;

  /**
   * Add LIMIT clause
   */
  limit(count: number): IQueryBuilder<T>;

  /**
   * Add OFFSET clause
   */
  offset(count: number): IQueryBuilder<T>;

  /**
   * Select specific fields
   */
  select(...fields: (keyof T)[]): IQueryBuilder<T>;

  /**
   * Execute the query and return results
   */
  execute(): Promise<QueryResult<T>>;

  /**
   * Execute the query and return first result
   */
  first(): Promise<T | null>;

  /**
   * Execute the query and return count
   */
  count(): Promise<number>;
}

/**
 * Connection pool interface for managing database connections
 */
export interface IConnectionPool {
  /**
   * Get a connection from the pool
   */
  acquire(): Promise<unknown>;

  /**
   * Return a connection to the pool
   */
  release(connection: unknown): Promise<void>;

  /**
   * Close all connections in the pool
   */
  close(): Promise<void>;

  /**
   * Get pool statistics
   */
  getStats(): {
    readonly total: number;
    readonly active: number;
    readonly idle: number;
    readonly waiting: number;
  };
}
