/**
 * Storage Layer Type Definitions
 *
 * This module defines the core types and interfaces for the storage abstraction layer.
 * It provides a unified interface for different storage backends (SQLite, in-memory, etc.)
 */

/**
 * Represents a database record with common fields
 */
export interface BaseRecord {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Query operators for filtering data
 */
export type QueryOperator =
  | 'eq' // equals
  | 'ne' // not equals
  | 'gt' // greater than
  | 'gte' // greater than or equal
  | 'lt' // less than
  | 'lte' // less than or equal
  | 'in' // in array
  | 'nin' // not in array
  | 'like' // string pattern matching
  | 'ilike'; // case-insensitive string pattern matching

/**
 * Individual query condition
 */
export interface QueryCondition {
  readonly field: string;
  readonly operator: QueryOperator;
  readonly value: unknown;
}

/**
 * Logical operators for combining conditions
 */
export type LogicalOperator = 'and' | 'or';

/**
 * Complex query with multiple conditions
 */
export interface QueryFilter {
  readonly conditions: QueryCondition[];
  readonly operator?: LogicalOperator;
}

/**
 * Sorting specification
 */
export interface SortOrder {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

/**
 * Pagination options
 */
export interface PaginationOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly cursor?: string;
}

/**
 * Complete query specification
 */
export interface QueryOptions {
  readonly filter?: QueryFilter;
  readonly sort?: SortOrder[];
  readonly pagination?: PaginationOptions;
  readonly fields?: string[]; // Field selection
}

/**
 * Query result with metadata
 */
export interface QueryResult<T> {
  readonly data: T[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

/**
 * Transaction isolation levels
 */
export type IsolationLevel =
  | 'read_uncommitted'
  | 'read_committed'
  | 'repeatable_read'
  | 'serializable';

/**
 * Transaction options
 */
export interface TransactionOptions {
  readonly timeout?: number; // milliseconds
  readonly isolationLevel?: IsolationLevel;
  readonly readOnly?: boolean;
}

/**
 * Transaction interface for database operations
 */
export interface Transaction {
  /**
   * Execute operations within the transaction
   */
  execute<T>(fn: (tx: StorageOperations) => Promise<T>): Promise<T>;

  /**
   * Commit the transaction
   */
  commit(): Promise<void>;

  /**
   * Rollback the transaction
   */
  rollback(): Promise<void>;

  /**
   * Check if transaction is active
   */
  isActive(): boolean;
}

/**
 * Storage operations interface - CRUD operations
 */
export interface StorageOperations {
  /**
   * Create a new record
   */
  create<T extends BaseRecord>(table: string, data: Omit<T, keyof BaseRecord>): Promise<T>;

  /**
   * Create multiple records in bulk
   */
  createMany<T extends BaseRecord>(
    table: string,
    data: Array<Omit<T, keyof BaseRecord>>
  ): Promise<T[]>;

  /**
   * Find a single record by ID
   */
  findById<T extends BaseRecord>(table: string, id: string): Promise<T | null>;

  /**
   * Find records matching query
   */
  find<T extends BaseRecord>(table: string, options?: QueryOptions): Promise<QueryResult<T>>;

  /**
   * Find first record matching query
   */
  findFirst<T extends BaseRecord>(table: string, options?: QueryOptions): Promise<T | null>;

  /**
   * Update a record by ID
   */
  updateById<T extends BaseRecord>(
    table: string,
    id: string,
    data: Partial<Omit<T, keyof BaseRecord>>
  ): Promise<T | null>;

  /**
   * Update multiple records matching query
   */
  updateMany<T extends BaseRecord>(
    table: string,
    filter: QueryFilter,
    data: Partial<Omit<T, keyof BaseRecord>>
  ): Promise<number>;

  /**
   * Delete a record by ID
   */
  deleteById(table: string, id: string): Promise<boolean>;

  /**
   * Delete multiple records matching query
   */
  deleteMany(table: string, filter: QueryFilter): Promise<number>;

  /**
   * Check if a record exists
   */
  exists(table: string, id: string): Promise<boolean>;

  /**
   * Count records matching query
   */
  count(table: string, filter?: QueryFilter): Promise<number>;
}

/**
 * Cache-specific operations
 */
export interface CacheOperations {
  /**
   * Get a value from cache
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Set a value in cache with optional TTL
   */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;

  /**
   * Delete a value from cache
   */
  delete(key: string): Promise<boolean>;

  /**
   * Check if a key exists in cache
   */
  has(key: string): Promise<boolean>;

  /**
   * Clear all cache entries
   */
  clear(): Promise<void>;

  /**
   * Get cache statistics
   */
  getStats(): Promise<CacheStats>;

  /**
   * Get keys matching a prefix (more efficient than getKeys() + filter)
   */
  getKeysByPrefix(prefix: string): Promise<string[]>;

  /**
   * Delete all keys matching a prefix
   */
  deleteByPrefix(prefix: string): Promise<number>;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly entries: number;
  readonly memoryUsage: number; // bytes
  readonly hitRate: number; // percentage
}

/**
 * Storage provider configuration
 */
/** The storage backends kinglet can run on. */
export type StorageType = 'sqlite' | 'memory' | 'hybrid';

export interface StorageConfig {
  readonly type: StorageType;
  readonly database?: {
    readonly path?: string;
    readonly memory?: boolean;
    readonly connectionPoolSize?: number;
  };
  readonly cache?: {
    readonly maxSize?: number; // maximum number of entries
    readonly ttlSeconds?: number; // default TTL
    readonly maxMemoryMb?: number; // maximum memory usage
  };
}

/**
 * Main storage provider interface
 */
export interface StorageProvider extends StorageOperations {
  /**
   * Initialize the storage provider
   */
  initialize(config: StorageConfig): Promise<void>;

  /**
   * Start a new transaction
   */
  beginTransaction(options?: TransactionOptions): Promise<Transaction>;

  /**
   * Get cache operations (if supported)
   */
  getCache(): CacheOperations | null;

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
   * Check connection health
   */
  healthCheck(): Promise<boolean>;

  /**
   * Close all connections
   */
  close(): Promise<void>;
}

/**
 * Table column definition
 */
export interface ColumnDefinition {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean' | 'date' | 'json';
  readonly nullable?: boolean;
  readonly primaryKey?: boolean;
  readonly unique?: boolean;
  readonly defaultValue?: unknown;
  readonly maxLength?: number;
}

/**
 * Table index definition
 */
export interface IndexDefinition {
  readonly name: string;
  readonly columns: string[];
  readonly unique?: boolean;
}

/**
 * Complete table schema
 */
export interface TableSchema {
  readonly name: string;
  readonly columns: ColumnDefinition[];
  readonly indexes?: IndexDefinition[];
  readonly timestamps?: boolean; // auto-add createdAt/updatedAt
}

/**
 * Storage error types
 */
export class StorageError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public override readonly cause?: Error
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

export class ValidationError extends StorageError {
  constructor(message: string, cause?: Error) {
    super(message, 'VALIDATION_ERROR', cause);
    this.name = 'ValidationError';
  }
}

export class ConnectionError extends StorageError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONNECTION_ERROR', cause);
    this.name = 'ConnectionError';
  }
}

export class TransactionError extends StorageError {
  constructor(message: string, cause?: Error) {
    super(message, 'TRANSACTION_ERROR', cause);
    this.name = 'TransactionError';
  }
}

export class NotFoundError extends StorageError {
  constructor(message: string, cause?: Error) {
    super(message, 'NOT_FOUND', cause);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends StorageError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONFLICT', cause);
    this.name = 'ConflictError';
  }
}
