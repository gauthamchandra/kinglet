/**
 * In-Memory Storage Provider
 *
 * This module provides an in-memory storage implementation that stores all data in RAM.
 * It's optimized for speed and includes an integrated LRU cache for frequently accessed data.
 */

import { randomUUID } from 'node:crypto';
import {
  BaseRecord,
  CacheOperations,
  NotFoundError,
  QueryCondition,
  QueryFilter,
  QueryOptions,
  QueryResult,
  StorageConfig,
  StorageProvider,
  TableSchema,
  Transaction,
  TransactionError,
  TransactionOptions,
  ValidationError,
} from '../types.js';
import { LRUCache, LRUCacheConfig } from '../cache/lru-cache.js';

/**
 * In-memory table structure
 */
interface MemoryTable {
  schema: TableSchema;
  records: Map<string, BaseRecord>;
}

/**
 * In-memory transaction implementation
 */
class MemoryTransaction implements Transaction {
  private isActiveFlag = true;
  private operations: Array<() => void> = [];
  private rollbackOperations: Array<() => void> = [];

  constructor(
    private provider: MemoryStorageProvider,
    private options: TransactionOptions = {}
  ) {}

  async execute<T>(fn: (tx: MemoryStorageProvider) => Promise<T>): Promise<T> {
    if (!this.isActiveFlag) {
      throw new TransactionError('Transaction is no longer active');
    }

    try {
      const result = await fn(this.provider);

      return result;
    } catch (error) {
      await this.rollback();
      throw error;
    }
  }

  async commit(): Promise<void> {
    if (!this.isActiveFlag) {
      throw new TransactionError('Transaction is no longer active');
    }

    try {
      // In-memory transactions are automatically committed since we're working directly with data
      this.isActiveFlag = false;
      this.rollbackOperations.length = 0; // Clear rollback operations
    } catch (error) {
      throw new TransactionError('Failed to commit transaction', error as Error);
    }
  }

  async rollback(): Promise<void> {
    if (!this.isActiveFlag) {
      return; // Already rolled back
    }

    try {
      // Execute rollback operations in reverse order
      for (let i = this.rollbackOperations.length - 1; i >= 0; i--) {
        this.rollbackOperations[i]();
      }

      this.isActiveFlag = false;
      this.rollbackOperations.length = 0;
    } catch (error) {
      throw new TransactionError('Failed to rollback transaction', error as Error);
    }
  }

  isActive(): boolean {
    return this.isActiveFlag;
  }

  addRollbackOperation(operation: () => void): void {
    this.rollbackOperations.push(operation);
  }
}

/**
 * In-Memory Storage Provider
 */
export class MemoryStorageProvider implements StorageProvider {
  private tables = new Map<string, MemoryTable>();
  private cache: LRUCache | null = null;
  private config: StorageConfig | null = null;

  async initialize(config: StorageConfig): Promise<void> {
    this.config = config;

    // Initialize cache if configured
    if (config.cache) {
      const cacheConfig: LRUCacheConfig = {
        maxSize: config.cache.maxSize ?? 1000,
        defaultTTL: config.cache.ttlSeconds,
        maxMemoryMb: config.cache.maxMemoryMb ?? 50,
        cleanupInterval: 60, // Cleanup every minute
      };

      this.cache = new LRUCache(cacheConfig);
    }
  }

  async beginTransaction(options: TransactionOptions = {}): Promise<Transaction> {
    return new MemoryTransaction(this, options);
  }

  getCache(): CacheOperations | null {
    return this.cache;
  }

  async create<T extends BaseRecord>(table: string, data: Omit<T, keyof BaseRecord>): Promise<T> {
    const memoryTable = this.getTable(table);

    const id = randomUUID();
    const now = new Date();

    const record: T = {
      id,
      createdAt: now,
      updatedAt: now,
      ...data,
    } as T;

    memoryTable.records.set(id, record);

    // Cache the record
    if (this.cache) {
      await this.cache.set(`${table}:${id}`, record);
    }

    return record;
  }

  async createMany<T extends BaseRecord>(
    table: string,
    data: Array<Omit<T, keyof BaseRecord>>
  ): Promise<T[]> {
    const memoryTable = this.getTable(table);
    const records: T[] = [];
    const now = new Date();

    for (const item of data) {
      const id = randomUUID();
      const record: T = {
        id,
        createdAt: now,
        updatedAt: now,
        ...item,
      } as T;

      memoryTable.records.set(id, record);
      records.push(record);

      // Cache the record
      if (this.cache) {
        await this.cache.set(`${table}:${id}`, record);
      }
    }

    return records;
  }

  async findById<T extends BaseRecord>(table: string, id: string): Promise<T | null> {
    // Check cache first
    if (this.cache) {
      const cached = await this.cache.get<T>(`${table}:${id}`);

      if (cached) {
        return cached;
      }
    }

    const memoryTable = this.getTable(table);
    const record = memoryTable.records.get(id) as T | undefined;

    if (record) {
      // Cache the record
      if (this.cache) {
        await this.cache.set(`${table}:${id}`, record);
      }

      return record;
    }

    return null;
  }

  async find<T extends BaseRecord>(
    table: string,
    options: QueryOptions = {}
  ): Promise<QueryResult<T>> {
    const memoryTable = this.getTable(table);
    let records = Array.from(memoryTable.records.values()) as T[];

    // Apply filter
    if (options.filter) {
      records = records.filter(record => this.matchesFilter(record, options.filter!));
    }

    // Apply sorting
    if (options.sort && options.sort.length > 0) {
      records.sort((a, b) => {
        for (const sort of options.sort!) {
          const aValue = (a as Record<string, unknown>)[sort.field];
          const bValue = (b as Record<string, unknown>)[sort.field];

          let comparison = 0;

          if (aValue < bValue) comparison = -1;
          else if (aValue > bValue) comparison = 1;

          if (comparison !== 0) {
            return sort.direction === 'desc' ? -comparison : comparison;
          }
        }

        return 0;
      });
    }

    const total = records.length;

    // Apply pagination
    let paginatedRecords = records;
    let hasMore = false;

    if (options.pagination) {
      const { limit, offset = 0 } = options.pagination;

      if (limit) {
        paginatedRecords = records.slice(offset, offset + limit);
        hasMore = offset + limit < total;
      }
    }

    return {
      data: paginatedRecords,
      total,
      hasMore,
      nextCursor:
        hasMore && options.pagination?.limit
          ? String((options.pagination.offset ?? 0) + options.pagination.limit)
          : undefined,
    };
  }

  async findFirst<T extends BaseRecord>(
    table: string,
    options: QueryOptions = {}
  ): Promise<T | null> {
    const modifiedOptions = {
      ...options,
      pagination: { ...options.pagination, limit: 1 },
    };

    const result = await this.find<T>(table, modifiedOptions);

    return result.data[0] ?? null;
  }

  async updateById<T extends BaseRecord>(
    table: string,
    id: string,
    data: Partial<Omit<T, keyof BaseRecord>>
  ): Promise<T | null> {
    const memoryTable = this.getTable(table);
    const existingRecord = memoryTable.records.get(id) as T | undefined;

    if (!existingRecord) {
      return null;
    }

    const updatedRecord: T = {
      ...existingRecord,
      ...data,
      updatedAt: new Date(),
    };

    memoryTable.records.set(id, updatedRecord);

    // Update cache
    if (this.cache) {
      await this.cache.set(`${table}:${id}`, updatedRecord);
    }

    return updatedRecord;
  }

  async updateMany<T extends BaseRecord>(
    table: string,
    filter: QueryFilter,
    data: Partial<Omit<T, keyof BaseRecord>>
  ): Promise<number> {
    const memoryTable = this.getTable(table);
    let updatedCount = 0;

    for (const [id, record] of memoryTable.records.entries()) {
      if (this.matchesFilter(record, filter)) {
        const updatedRecord = {
          ...record,
          ...data,
          updatedAt: new Date(),
        };

        memoryTable.records.set(id, updatedRecord);
        updatedCount++;

        // Update cache
        if (this.cache) {
          await this.cache.set(`${table}:${id}`, updatedRecord);
        }
      }
    }

    return updatedCount;
  }

  async deleteById(table: string, id: string): Promise<boolean> {
    const memoryTable = this.getTable(table);
    const deleted = memoryTable.records.delete(id);

    if (deleted && this.cache) {
      await this.cache.delete(`${table}:${id}`);
    }

    return deleted;
  }

  async deleteMany(table: string, filter: QueryFilter): Promise<number> {
    const memoryTable = this.getTable(table);
    let deletedCount = 0;

    const toDelete: string[] = [];

    for (const [id, record] of memoryTable.records.entries()) {
      if (this.matchesFilter(record, filter)) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      memoryTable.records.delete(id);
      deletedCount++;

      if (this.cache) {
        await this.cache.delete(`${table}:${id}`);
      }
    }

    return deletedCount;
  }

  async exists(table: string, id: string): Promise<boolean> {
    // Check cache first
    if (this.cache) {
      const cached = await this.cache.has(`${table}:${id}`);

      if (cached) {
        return true;
      }
    }

    const memoryTable = this.getTable(table);

    return memoryTable.records.has(id);
  }

  async count(table: string, filter?: QueryFilter): Promise<number> {
    const memoryTable = this.getTable(table);

    if (!filter) {
      return memoryTable.records.size;
    }

    let count = 0;

    for (const record of memoryTable.records.values()) {
      if (this.matchesFilter(record, filter)) {
        count++;
      }
    }

    return count;
  }

  async createTable(name: string, schema: TableSchema): Promise<void> {
    const memoryTable: MemoryTable = {
      schema,
      records: new Map(),
    };

    this.tables.set(name, memoryTable);
  }

  async dropTable(name: string): Promise<void> {
    const deleted = this.tables.delete(name);

    // Clear cache entries for this table using efficient prefix deletion
    if (deleted && this.cache) {
      await this.cache.deleteByPrefix(`${name}:`);
    }
  }

  async listTables(): Promise<string[]> {
    return Array.from(this.tables.keys());
  }

  async healthCheck(): Promise<boolean> {
    return true; // In-memory storage is always healthy if initialized
  }

  async close(): Promise<void> {
    this.tables.clear();

    if (this.cache) {
      this.cache.destroy();
      this.cache = null;
    }
  }

  private getTable(name: string): MemoryTable {
    const table = this.tables.get(name);

    if (!table) {
      throw new NotFoundError(`Table '${name}' not found`);
    }

    return table;
  }

  private matchesFilter(record: BaseRecord, filter: QueryFilter): boolean {
    const { conditions, operator = 'and' } = filter;

    if (operator === 'and') {
      return conditions.every(condition => this.matchesCondition(record, condition));
    } else {
      return conditions.some(condition => this.matchesCondition(record, condition));
    }
  }

  private matchesCondition(record: BaseRecord, condition: QueryCondition): boolean {
    const { field, operator, value } = condition;
    const recordValue = (record as Record<string, unknown>)[field];

    switch (operator) {
      case 'eq':
        return recordValue === value;
      case 'ne':
        return recordValue !== value;
      case 'gt':
        return recordValue > value;
      case 'gte':
        return recordValue >= value;
      case 'lt':
        return recordValue < value;
      case 'lte':
        return recordValue <= value;
      case 'in':
        return Array.isArray(value) && value.includes(recordValue);
      case 'nin':
        return Array.isArray(value) && !value.includes(recordValue);
      case 'like':
        return (
          typeof recordValue === 'string' &&
          typeof value === 'string' &&
          recordValue.includes(value.replace(/%/g, ''))
        );
      case 'ilike':
        return (
          typeof recordValue === 'string' &&
          typeof value === 'string' &&
          recordValue.toLowerCase().includes(value.toLowerCase().replace(/%/g, ''))
        );
      default:
        throw new ValidationError(`Unsupported query operator: ${operator}`);
    }
  }
}
