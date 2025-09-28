/**
 * Storage Manager Implementation
 *
 * This module implements the main storage manager that provides a unified interface
 * for storage operations and supports hybrid storage (SQLite + Cache) strategies.
 */

import {
  BaseRecord,
  CacheOperations,
  IStorageManager,
  QueryFilter,
  QueryOptions,
  QueryResult,
  StorageConfig,
  StorageProvider,
  StorageStats,
  TableSchema,
  TransactionOptions,
  ValidationError,
} from './types.js';
import {
  IStorageEventEmitter,
  StorageEvent,
  StorageEventData,
  StorageEventListener,
} from './interfaces.js';
import { SQLiteStorageProvider } from './providers/sqlite.js';
import { MemoryStorageProvider } from './providers/memory.js';

/**
 * Storage Manager - Main implementation
 */
export class StorageManager implements IStorageManager, IStorageEventEmitter {
  private provider: StorageProvider | null = null;
  private config: StorageConfig | null = null;
  private eventListeners = new Map<StorageEvent, Set<StorageEventListener>>();
  private operationStats = {
    totalQueries: 0,
    totalQueryTime: 0,
    activeTransactions: 0,
  };

  async initialize(config: StorageConfig): Promise<void> {
    this.config = config;

    // Create storage provider based on configuration
    switch (config.type) {
      case 'sqlite':
        this.provider = new SQLiteStorageProvider();
        break;
      case 'memory':
        this.provider = new MemoryStorageProvider();
        break;
      case 'hybrid':
        // For hybrid, use SQLite with caching enabled
        this.provider = new SQLiteStorageProvider();
        break;
      default:
        throw new ValidationError(`Unsupported storage type: ${config.type}`);
    }

    await this.provider.initialize(config);

    // Emit initialization event
    this.emit('table:created', {
      operation: 'initialize',
      timestamp: new Date(),
      metadata: { type: config.type },
    });
  }

  getProvider(): StorageProvider {
    if (!this.provider) {
      throw new ValidationError('Storage manager not initialized');
    }

    return this.provider;
  }

  getCache(): CacheOperations | null {
    return this.provider?.getCache() ?? null;
  }

  async withTransaction<T>(
    fn: (tx: StorageManager) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    if (!this.provider) {
      throw new ValidationError('Storage manager not initialized');
    }

    this.operationStats.activeTransactions++;
    this.emit('transaction:started', {
      operation: 'begin_transaction',
      timestamp: new Date(),
      metadata: { options },
    });

    const transaction = await this.provider.beginTransaction(options);

    try {
      const result = await transaction.execute(async () => {
        // Create a transaction-aware storage manager wrapper
        const txManager = new TransactionalStorageManager(this.provider!, this);

        return await fn(txManager);
      });

      await transaction.commit();

      this.emit('transaction:committed', {
        operation: 'commit_transaction',
        timestamp: new Date(),
      });

      return result;
    } catch (error) {
      await transaction.rollback();

      this.emit('transaction:rollback', {
        operation: 'rollback_transaction',
        timestamp: new Date(),
        error: error as Error,
      });

      throw error;
    } finally {
      this.operationStats.activeTransactions--;
    }
  }

  async create<T extends BaseRecord>(table: string, data: Omit<T, keyof BaseRecord>): Promise<T> {
    if (!this.provider) {
      throw new ValidationError('Storage manager not initialized');
    }

    const startTime = Date.now();

    try {
      const result = await this.provider.create<T>(table, data);

      this.emit('record:created', {
        table,
        recordId: result.id,
        operation: 'create',
        timestamp: new Date(),
        metadata: { data },
      });

      return result;
    } finally {
      this.updateQueryStats(Date.now() - startTime);
    }
  }

  async createMany<T extends BaseRecord>(
    table: string,
    data: Array<Omit<T, keyof BaseRecord>>
  ): Promise<T[]> {
    if (!this.provider) {
      throw new ValidationError('Storage manager not initialized');
    }

    const startTime = Date.now();

    try {
      const results = await this.provider.createMany<T>(table, data);

      this.emit('record:created', {
        table,
        operation: 'create_many',
        timestamp: new Date(),
        metadata: { count: results.length },
      });

      return results;
    } finally {
      this.updateQueryStats(Date.now() - startTime);
    }
  }

  async findById<T extends BaseRecord>(table: string, id: string): Promise<T | null> {
    if (!this.provider) {
      throw new ValidationError('Storage manager not initialized');
    }

    const startTime = Date.now();

    try {
      // Check cache first if available
      const cache = this.getCache();

      if (cache) {
        const cached = await cache.get<T>(`${table}:${id}`);

        if (cached) {
          this.emit('cache:hit', {
            table,
            recordId: id,
            operation: 'find_by_id',
            timestamp: new Date(),
          });

          return cached;
        }

        this.emit('cache:miss', {
          table,
          recordId: id,
          operation: 'find_by_id',
          timestamp: new Date(),
        });
      }

      const result = await this.provider.findById<T>(table, id);

      // Cache the result if found
      if (result && cache) {
        await cache.set(`${table}:${id}`, result);
      }

      return result;
    } finally {
      this.updateQueryStats(Date.now() - startTime);
    }
  }

  async find<T extends BaseRecord>(table: string, options?: QueryOptions): Promise<QueryResult<T>> {
    if (!this.provider) {
      throw new ValidationError('Storage manager not initialized');
    }

    const startTime = Date.now();

    try {
      return await this.provider.find<T>(table, options);
    } finally {
      this.updateQueryStats(Date.now() - startTime);
    }
  }

  async findFirst<T extends BaseRecord>(table: string, options?: QueryOptions): Promise<T | null> {
    if (!this.provider) {
      throw new ValidationError('Storage manager not initialized');
    }

    const startTime = Date.now();

    try {
      return await this.provider.findFirst<T>(table, options);
    } finally {
      this.updateQueryStats(Date.now() - startTime);
    }
  }

  async updateById<T extends BaseRecord>(
    table: string,
    id: string,
    data: Partial<Omit<T, keyof BaseRecord>>
  ): Promise<T | null> {
    if (!this.provider) {
      throw new ValidationError('Storage manager not initialized');
    }

    const startTime = Date.now();

    try {
      const result = await this.provider.updateById<T>(table, id, data);

      if (result) {
        // Invalidate cache
        const cache = this.getCache();

        if (cache) {
          await cache.delete(`${table}:${id}`);
        }

        this.emit('record:updated', {
          table,
          recordId: id,
          operation: 'update',
          timestamp: new Date(),
          metadata: { data },
        });
      }

      return result;
    } finally {
      this.updateQueryStats(Date.now() - startTime);
    }
  }

  async updateMany<T extends BaseRecord>(
    table: string,
    filter: QueryFilter,
    data: Partial<Omit<T, keyof BaseRecord>>
  ): Promise<number> {
    if (!this.provider) {
      throw new ValidationError('Storage manager not initialized');
    }

    const startTime = Date.now();

    try {
      const count = await this.provider.updateMany<T>(table, filter, data);

      if (count > 0) {
        // Targeted cache invalidation: find affected records and invalidate only those
        const cache = this.getCache();

        if (cache) {
          try {
            // First, find which records match the filter to get their IDs
            const affectedRecords = await this.provider.find<T>(table, { filter });

            // Invalidate cache entries only for the affected records
            for (const record of affectedRecords.data) {
              await cache.delete(`${table}:${record.id}`);
            }
          } catch {
            // If targeted invalidation fails, fall back to clearing all table entries
            await cache.deleteByPrefix(`${table}:`);
          }
        }

        this.emit('record:updated', {
          table,
          operation: 'update_many',
          timestamp: new Date(),
          metadata: { count, filter, data },
        });
      }

      return count;
    } finally {
      this.updateQueryStats(Date.now() - startTime);
    }
  }

  async deleteById(table: string, id: string): Promise<boolean> {
    if (!this.provider) {
      throw new ValidationError('Storage manager not initialized');
    }

    const startTime = Date.now();

    try {
      const deleted = await this.provider.deleteById(table, id);

      if (deleted) {
        // Remove from cache
        const cache = this.getCache();

        if (cache) {
          await cache.delete(`${table}:${id}`);
        }

        this.emit('record:deleted', {
          table,
          recordId: id,
          operation: 'delete',
          timestamp: new Date(),
        });
      }

      return deleted;
    } finally {
      this.updateQueryStats(Date.now() - startTime);
    }
  }

  async deleteMany(table: string, filter: QueryFilter): Promise<number> {
    if (!this.provider) {
      throw new ValidationError('Storage manager not initialized');
    }

    const startTime = Date.now();

    try {
      // For deletes, we need to find affected records BEFORE deleting them
      let affectedRecordIds: string[] = [];
      const cache = this.getCache();

      if (cache) {
        try {
          // Find records that match the filter before deletion
          const affectedRecords = await this.provider.find<BaseRecord>(table, { filter });

          affectedRecordIds = affectedRecords.data.map(record => record.id);
        } catch {
          // If pre-query fails, we'll fall back to clearing all table entries later
        }
      }

      const count = await this.provider.deleteMany(table, filter);

      if (count > 0) {
        if (cache) {
          if (affectedRecordIds.length > 0) {
            // Invalidate cache entries only for the affected records
            for (const id of affectedRecordIds) {
              await cache.delete(`${table}:${id}`);
            }
          } else {
            // If we couldn't determine affected records, fall back to clearing all table entries
            await cache.deleteByPrefix(`${table}:`);
          }
        }

        this.emit('record:deleted', {
          table,
          operation: 'delete_many',
          timestamp: new Date(),
          metadata: { count, filter },
        });
      }

      return count;
    } finally {
      this.updateQueryStats(Date.now() - startTime);
    }
  }

  async exists(table: string, id: string): Promise<boolean> {
    if (!this.provider) {
      throw new ValidationError('Storage manager not initialized');
    }

    const startTime = Date.now();

    try {
      return await this.provider.exists(table, id);
    } finally {
      this.updateQueryStats(Date.now() - startTime);
    }
  }

  async count(table: string, filter?: QueryFilter): Promise<number> {
    if (!this.provider) {
      throw new ValidationError('Storage manager not initialized');
    }

    const startTime = Date.now();

    try {
      return await this.provider.count(table, filter);
    } finally {
      this.updateQueryStats(Date.now() - startTime);
    }
  }

  async createTable(name: string, schema: TableSchema): Promise<void> {
    if (!this.provider) {
      throw new ValidationError('Storage manager not initialized');
    }

    await this.provider.createTable(name, schema);

    this.emit('table:created', {
      table: name,
      operation: 'create_table',
      timestamp: new Date(),
      metadata: { schema },
    });
  }

  async dropTable(name: string): Promise<void> {
    if (!this.provider) {
      throw new ValidationError('Storage manager not initialized');
    }

    await this.provider.dropTable(name);

    // Clear all cache entries for this table using efficient prefix deletion
    const cache = this.getCache();

    if (cache) {
      await cache.deleteByPrefix(`${name}:`);
    }

    this.emit('table:dropped', {
      table: name,
      operation: 'drop_table',
      timestamp: new Date(),
    });
  }

  async listTables(): Promise<string[]> {
    if (!this.provider) {
      throw new ValidationError('Storage manager not initialized');
    }

    return await this.provider.listTables();
  }

  async healthCheck(): Promise<boolean> {
    if (!this.provider) {
      return false;
    }

    return await this.provider.healthCheck();
  }

  async getStats(): Promise<StorageStats> {
    if (!this.provider) {
      throw new ValidationError('Storage manager not initialized');
    }

    const tables = await this.listTables();
    let totalRecords = 0;

    // Count total records across all tables
    for (const table of tables) {
      try {
        totalRecords += await this.count(table);
      } catch {
        // Ignore errors for individual table counts
      }
    }

    const cache = this.getCache();
    const cacheStats = cache ? await cache.getStats() : undefined;

    const avgQueryTime =
      this.operationStats.totalQueries > 0
        ? this.operationStats.totalQueryTime / this.operationStats.totalQueries
        : 0;

    return {
      provider: this.config?.type ?? 'unknown',
      tablesCount: tables.length,
      totalRecords,
      cacheStats: cacheStats
        ? {
            hits: cacheStats.hits,
            misses: cacheStats.misses,
            entries: cacheStats.entries,
            hitRate: cacheStats.hitRate,
          }
        : undefined,
      performance: {
        avgQueryTime: Math.round(avgQueryTime * 100) / 100,
        totalQueries: this.operationStats.totalQueries,
        activeTransactions: this.operationStats.activeTransactions,
      },
    };
  }

  async close(): Promise<void> {
    if (this.provider) {
      await this.provider.close();
      this.provider = null;
    }

    // Clear event listeners
    this.eventListeners.clear();
  }

  // Event emitter implementation
  on(event: StorageEvent, listener: StorageEventListener): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(listener);
  }

  off(event: StorageEvent, listener: StorageEventListener): void {
    const listeners = this.eventListeners.get(event);

    if (listeners) {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.eventListeners.delete(event);
      }
    }
  }

  emit(event: StorageEvent, data: StorageEventData): void {
    const listeners = this.eventListeners.get(event);

    if (listeners) {
      for (const listener of listeners) {
        try {
          const result = listener(data);

          // Handle async listeners
          if (result && typeof result === 'object' && 'then' in result) {
            result.catch((error: Error) => {
              this.emit('error', {
                operation: 'event_listener',
                timestamp: new Date(),
                error,
                metadata: { event, originalData: data },
              });
            });
          }
        } catch (error) {
          this.emit('error', {
            operation: 'event_listener',
            timestamp: new Date(),
            error: error as Error,
            metadata: { event, originalData: data },
          });
        }
      }
    }
  }

  private updateQueryStats(executionTime: number): void {
    this.operationStats.totalQueries++;
    this.operationStats.totalQueryTime += executionTime;
  }
}

/**
 * Transactional Storage Manager Wrapper
 *
 * This wrapper ensures that all operations within a transaction
 * are performed on the same transaction context.
 */
class TransactionalStorageManager implements IStorageManager {
  constructor(
    private provider: StorageProvider,
    private parentManager: StorageManager
  ) {}

  async initialize(_config: StorageConfig): Promise<void> {
    throw new ValidationError('Cannot initialize storage within a transaction');
  }

  getProvider(): StorageProvider {
    return this.provider;
  }

  getCache(): CacheOperations | null {
    return this.provider.getCache();
  }

  async withTransaction<T>(
    fn: (tx: IStorageManager) => Promise<T>,
    _options?: TransactionOptions
  ): Promise<T> {
    // Nested transactions are not supported - use the current transaction
    return await fn(this);
  }

  // Delegate all operations to the provider
  async create<T extends BaseRecord>(table: string, data: Omit<T, keyof BaseRecord>): Promise<T> {
    return await this.provider.create<T>(table, data);
  }

  async createMany<T extends BaseRecord>(
    table: string,
    data: Array<Omit<T, keyof BaseRecord>>
  ): Promise<T[]> {
    return await this.provider.createMany<T>(table, data);
  }

  async findById<T extends BaseRecord>(table: string, id: string): Promise<T | null> {
    return await this.provider.findById<T>(table, id);
  }

  async find<T extends BaseRecord>(table: string, options?: QueryOptions): Promise<QueryResult<T>> {
    return await this.provider.find<T>(table, options);
  }

  async findFirst<T extends BaseRecord>(table: string, options?: QueryOptions): Promise<T | null> {
    return await this.provider.findFirst<T>(table, options);
  }

  async updateById<T extends BaseRecord>(
    table: string,
    id: string,
    data: Partial<Omit<T, keyof BaseRecord>>
  ): Promise<T | null> {
    return await this.provider.updateById<T>(table, id, data);
  }

  async updateMany<T extends BaseRecord>(
    table: string,
    filter: QueryFilter,
    data: Partial<Omit<T, keyof BaseRecord>>
  ): Promise<number> {
    return await this.provider.updateMany<T>(table, filter, data);
  }

  async deleteById(table: string, id: string): Promise<boolean> {
    return await this.provider.deleteById(table, id);
  }

  async deleteMany(table: string, filter: QueryFilter): Promise<number> {
    return await this.provider.deleteMany(table, filter);
  }

  async exists(table: string, id: string): Promise<boolean> {
    return await this.provider.exists(table, id);
  }

  async count(table: string, filter?: QueryFilter): Promise<number> {
    return await this.provider.count(table, filter);
  }

  async createTable(name: string, schema: TableSchema): Promise<void> {
    return await this.provider.createTable(name, schema);
  }

  async dropTable(name: string): Promise<void> {
    return await this.provider.dropTable(name);
  }

  async listTables(): Promise<string[]> {
    return await this.provider.listTables();
  }

  async healthCheck(): Promise<boolean> {
    return await this.provider.healthCheck();
  }

  async getStats(): Promise<StorageStats> {
    return await this.parentManager.getStats();
  }

  async close(): Promise<void> {
    // Don't close within a transaction
    throw new ValidationError('Cannot close storage within a transaction');
  }
}
