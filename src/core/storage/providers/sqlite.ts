/**
 * SQLite Storage Provider Implementation
 *
 * This module provides a SQLite-based storage implementation using Bun's native SQLite support.
 */

import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import {
  BaseRecord,
  CacheOperations,
  ColumnDefinition,
  ConnectionError,
  ConflictError,
  QueryCondition,
  QueryFilter,
  QueryOptions,
  QueryResult,
  StorageConfig,
  StorageError,
  StorageProvider,
  TableSchema,
  Transaction,
  TransactionError,
  TransactionOptions,
  ValidationError,
} from '../types.js';

/**
 * SQLite-specific transaction implementation
 */
class SQLiteTransaction implements Transaction {
  private isActiveFlag = false;
  private operations: Array<() => void> = [];

  constructor(
    private db: Database,
    private provider: SQLiteStorageProvider,
    private options: TransactionOptions = {}
  ) {}

  begin(): void {
    if (this.isActiveFlag) {
      throw new TransactionError('Transaction already begun');
    }
    this.db.run('BEGIN');
    this.isActiveFlag = true;
  }

  async execute<T>(fn: (tx: SQLiteStorageProvider) => Promise<T>): Promise<T> {
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
      this.db.run('COMMIT');
      this.isActiveFlag = false;
    } catch (error) {
      throw new TransactionError('Failed to commit transaction', error as Error);
    }
  }

  async rollback(): Promise<void> {
    if (!this.isActiveFlag) {
      return; // Already rolled back
    }

    try {
      this.db.run('ROLLBACK');
      this.isActiveFlag = false;
    } catch (error) {
      throw new TransactionError('Failed to rollback transaction', error as Error);
    }
  }

  isActive(): boolean {
    return this.isActiveFlag;
  }
}

/**
 * SQLite Storage Provider
 */
export class SQLiteStorageProvider implements StorageProvider {
  private db: Database | null = null;
  private config: StorageConfig | null = null;

  async initialize(config: StorageConfig): Promise<void> {
    this.config = config;

    try {
      // Initialize SQLite database
      const dbPath = config.database?.path ?? ':memory:';

      this.db = new Database(dbPath);

      // Enable WAL mode for better concurrent access
      this.db.run('PRAGMA journal_mode = WAL');
      this.db.run('PRAGMA synchronous = NORMAL');
      this.db.run('PRAGMA cache_size = 1000');
      this.db.run('PRAGMA foreign_keys = ON');

      // Create metadata table for tracking schema versions
      this.createMetadataTable();
    } catch (error) {
      throw new ConnectionError('Failed to initialize SQLite database', error as Error);
    }
  }

  async beginTransaction(options: TransactionOptions = {}): Promise<Transaction> {
    if (!this.db) {
      throw new ConnectionError('Database not initialized');
    }

    const transaction = new SQLiteTransaction(this.db, this, options);

    transaction.begin();

    return transaction;
  }

  getCache(): CacheOperations | null {
    // SQLite provider doesn't include cache by default
    return null;
  }

  async create<T extends BaseRecord>(table: string, data: Omit<T, keyof BaseRecord>): Promise<T> {
    if (!this.db) {
      throw new ConnectionError('Database not initialized');
    }

    const id = randomUUID();
    const now = new Date();

    const recordData = {
      id,
      createdAt: now,
      updatedAt: now,
      ...data,
    };

    try {
      const columns = Object.keys(recordData);
      const placeholders = columns.map(() => '?').join(', ');
      const values = Object.values(recordData).map(value => this.serializeValue(value));

      const query = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;

      this.db.run(query, ...values);

      return recordData as T;
    } catch (error) {
      if ((error as Error).message.includes('UNIQUE constraint')) {
        throw new ConflictError('Record already exists', error as Error);
      }
      throw new StorageError('Failed to create record', 'CREATE_FAILED', error as Error);
    }
  }

  async createMany<T extends BaseRecord>(
    table: string,
    data: Array<Omit<T, keyof BaseRecord>>
  ): Promise<T[]> {
    if (!this.db) {
      throw new ConnectionError('Database not initialized');
    }

    const now = new Date();
    const records: T[] = [];

    try {
      this.db.run('BEGIN');

      for (const item of data) {
        const id = randomUUID();
        const recordData = {
          id,
          createdAt: now,
          updatedAt: now,
          ...item,
        } as T;

        const columns = Object.keys(recordData);
        const placeholders = columns.map(() => '?').join(', ');
        const values = Object.values(recordData).map(value => this.serializeValue(value));

        const query = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;

        this.db.run(query, ...values);

        records.push(recordData);
      }

      this.db.run('COMMIT');

      return records;
    } catch (error) {
      this.db.run('ROLLBACK');
      throw new StorageError('Failed to create records', 'CREATE_MANY_FAILED', error as Error);
    }
  }

  async findById<T extends BaseRecord>(table: string, id: string): Promise<T | null> {
    if (!this.db) {
      throw new ConnectionError('Database not initialized');
    }

    try {
      const query = `SELECT * FROM ${table} WHERE id = ?`;
      const stmt = this.db.prepare(query);
      const result = stmt.get(id) as T | undefined;

      return result ? this.deserializeRecord(result) : null;
    } catch (error) {
      throw new StorageError('Failed to find record', 'FIND_FAILED', error as Error);
    }
  }

  async find<T extends BaseRecord>(
    table: string,
    options: QueryOptions = {}
  ): Promise<QueryResult<T>> {
    if (!this.db) {
      throw new ConnectionError('Database not initialized');
    }

    try {
      const { whereClause, orderClause, limitClause, params } = this.buildQuery(options);

      // Build the main query
      let query = `SELECT * FROM ${table}`;

      if (whereClause) {
        query += ` WHERE ${whereClause}`;
      }
      if (orderClause) {
        query += ` ORDER BY ${orderClause}`;
      }
      if (limitClause) {
        query += ` ${limitClause}`;
      }

      // Execute main query
      const stmt = this.db.prepare(query);
      const results = stmt.all(...params) as T[];
      const data = results.map(record => this.deserializeRecord(record));

      // Get total count for pagination
      let countQuery = `SELECT COUNT(*) as count FROM ${table}`;

      if (whereClause) {
        countQuery += ` WHERE ${whereClause}`;
      }

      const countStmt = this.db.prepare(countQuery);
      const countResult = countStmt.get(
        ...params.slice(0, params.length - (limitClause ? 2 : 0))
      ) as { count: number };
      const total = countResult.count;

      // Determine if there are more results
      const limit = options.pagination?.limit ?? data.length;
      const offset = options.pagination?.offset ?? 0;
      const hasMore = offset + data.length < total;

      return {
        data,
        total,
        hasMore,
        nextCursor: hasMore ? String(offset + limit) : undefined,
      };
    } catch (error) {
      throw new StorageError('Failed to find records', 'FIND_MANY_FAILED', error as Error);
    }
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
    if (!this.db) {
      throw new ConnectionError('Database not initialized');
    }

    try {
      const updateData = {
        ...data,
        updatedAt: new Date(),
      };

      const columns = Object.keys(updateData);
      const setClause = columns.map(col => `${col} = ?`).join(', ');
      const values = Object.values(updateData).map(value => this.serializeValue(value));

      const query = `UPDATE ${table} SET ${setClause} WHERE id = ?`;
      const stmt = this.db.prepare(query);
      const result = stmt.run(...values, id);

      if (result.changes === 0) {
        return null; // Record not found
      }

      return await this.findById<T>(table, id);
    } catch (error) {
      throw new StorageError('Failed to update record', 'UPDATE_FAILED', error as Error);
    }
  }

  async updateMany<T extends BaseRecord>(
    table: string,
    filter: QueryFilter,
    data: Partial<Omit<T, keyof BaseRecord>>
  ): Promise<number> {
    if (!this.db) {
      throw new ConnectionError('Database not initialized');
    }

    try {
      const updateData = {
        ...data,
        updatedAt: new Date(),
      };

      const { whereClause, params: whereParams } = this.buildWhereClause(filter);

      const columns = Object.keys(updateData);
      const setClause = columns.map(col => `${col} = ?`).join(', ');
      const setValues = Object.values(updateData).map(value => this.serializeValue(value));

      const query = `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`;
      const stmt = this.db.prepare(query);
      const result = stmt.run(...setValues, ...whereParams);

      return result.changes || 0;
    } catch (error) {
      throw new StorageError('Failed to update records', 'UPDATE_MANY_FAILED', error as Error);
    }
  }

  async deleteById(table: string, id: string): Promise<boolean> {
    if (!this.db) {
      throw new ConnectionError('Database not initialized');
    }

    try {
      const query = `DELETE FROM ${table} WHERE id = ?`;
      const stmt = this.db.prepare(query);
      const result = stmt.run(id);

      return (result.changes || 0) > 0;
    } catch (error) {
      throw new StorageError('Failed to delete record', 'DELETE_FAILED', error as Error);
    }
  }

  async deleteMany(table: string, filter: QueryFilter): Promise<number> {
    if (!this.db) {
      throw new ConnectionError('Database not initialized');
    }

    try {
      const { whereClause, params } = this.buildWhereClause(filter);

      const query = `DELETE FROM ${table} WHERE ${whereClause}`;
      const stmt = this.db.prepare(query);
      const result = stmt.run(...params);

      return result.changes || 0;
    } catch (error) {
      throw new StorageError('Failed to delete records', 'DELETE_MANY_FAILED', error as Error);
    }
  }

  async exists(table: string, id: string): Promise<boolean> {
    if (!this.db) {
      throw new ConnectionError('Database not initialized');
    }

    try {
      const query = `SELECT COUNT(*) as count FROM ${table} WHERE id = ?`;
      const stmt = this.db.prepare(query);
      const result = stmt.get(id) as { count: number };

      return result.count > 0;
    } catch (error) {
      throw new StorageError('Failed to check record existence', 'EXISTS_FAILED', error as Error);
    }
  }

  async count(table: string, filter?: QueryFilter): Promise<number> {
    if (!this.db) {
      throw new ConnectionError('Database not initialized');
    }

    try {
      let query = `SELECT COUNT(*) as count FROM ${table}`;
      let params: unknown[] = [];

      if (filter) {
        const { whereClause, params: whereParams } = this.buildWhereClause(filter);

        query += ` WHERE ${whereClause}`;
        params = whereParams;
      }

      const stmt = this.db.prepare(query);
      const result = stmt.get(...params) as { count: number };

      return result.count;
    } catch (error) {
      throw new StorageError('Failed to count records', 'COUNT_FAILED', error as Error);
    }
  }

  async createTable(name: string, schema: TableSchema): Promise<void> {
    if (!this.db) {
      throw new ConnectionError('Database not initialized');
    }

    try {
      const columnDefinitions = schema.columns.map(col => this.formatColumnDefinition(col));

      // Add timestamp columns if requested
      if (schema.timestamps) {
        columnDefinitions.push('createdAt DATETIME NOT NULL');
        columnDefinitions.push('updatedAt DATETIME NOT NULL');
      }

      const createTableQuery = `
        CREATE TABLE IF NOT EXISTS ${name} (
          ${columnDefinitions.join(',\n          ')}
        )
      `;

      this.db.run(createTableQuery);

      // Create indexes
      if (schema.indexes) {
        for (const index of schema.indexes) {
          const indexName = `idx_${name}_${index.name}`;
          const uniqueClause = index.unique ? 'UNIQUE' : '';
          const columns = index.columns.join(', ');

          const createIndexQuery = `
            CREATE ${uniqueClause} INDEX IF NOT EXISTS ${indexName}
            ON ${name} (${columns})
          `;

          this.db.run(createIndexQuery);
        }
      }
    } catch (error) {
      throw new StorageError('Failed to create table', 'CREATE_TABLE_FAILED', error as Error);
    }
  }

  async dropTable(name: string): Promise<void> {
    if (!this.db) {
      throw new ConnectionError('Database not initialized');
    }

    try {
      const query = `DROP TABLE IF EXISTS ${name}`;

      this.db.run(query);
    } catch (error) {
      throw new StorageError('Failed to drop table', 'DROP_TABLE_FAILED', error as Error);
    }
  }

  async listTables(): Promise<string[]> {
    if (!this.db) {
      throw new ConnectionError('Database not initialized');
    }

    try {
      const query = `
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `;

      const stmt = this.db.prepare(query);
      const results = stmt.all() as Array<{ name: string }>;

      return results.map(row => row.name);
    } catch (error) {
      throw new StorageError('Failed to list tables', 'LIST_TABLES_FAILED', error as Error);
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.db) {
      return false;
    }

    try {
      // Simple query to test database connection
      this.db.run('SELECT 1');

      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
        this.db = null;
      } catch (error) {
        throw new StorageError('Failed to close database', 'CLOSE_FAILED', error as Error);
      }
    }
  }

  private createMetadataTable(): void {
    if (!this.db) {
      return;
    }

    const query = `
      CREATE TABLE IF NOT EXISTS _storage_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `;

    this.db.run(query);
  }

  private buildQuery(options: QueryOptions) {
    const params: unknown[] = [];
    let whereClause = '';
    let orderClause = '';
    let limitClause = '';

    // Build WHERE clause
    if (options.filter) {
      const whereResult = this.buildWhereClause(options.filter);

      whereClause = whereResult.whereClause;
      params.push(...whereResult.params);
    }

    // Build ORDER BY clause
    if (options.sort && options.sort.length > 0) {
      const orderParts = options.sort.map(sort => `${sort.field} ${sort.direction.toUpperCase()}`);

      orderClause = orderParts.join(', ');
    }

    // Build LIMIT/OFFSET clause
    if (options.pagination) {
      if (options.pagination.limit) {
        limitClause = 'LIMIT ?';
        params.push(options.pagination.limit);

        if (options.pagination.offset) {
          limitClause += ' OFFSET ?';
          params.push(options.pagination.offset);
        }
      }
    }

    return { whereClause, orderClause, limitClause, params };
  }

  private buildWhereClause(filter: QueryFilter): { whereClause: string; params: unknown[] } {
    const params: unknown[] = [];
    const conditions: string[] = [];

    for (const condition of filter.conditions) {
      const { clause, param } = this.buildCondition(condition);

      conditions.push(clause);
      if (param !== undefined) {
        if (Array.isArray(param)) {
          params.push(...param);
        } else {
          params.push(param);
        }
      }
    }

    const operator = filter.operator || 'and';
    const whereClause = conditions.join(` ${operator.toUpperCase()} `);

    return { whereClause, params };
  }

  private buildCondition(condition: QueryCondition): { clause: string; param?: unknown } {
    const { field, operator, value } = condition;

    switch (operator) {
      case 'eq':
        return { clause: `${field} = ?`, param: this.serializeValue(value) };
      case 'ne':
        return { clause: `${field} != ?`, param: this.serializeValue(value) };
      case 'gt':
        return { clause: `${field} > ?`, param: this.serializeValue(value) };
      case 'gte':
        return { clause: `${field} >= ?`, param: this.serializeValue(value) };
      case 'lt':
        return { clause: `${field} < ?`, param: this.serializeValue(value) };
      case 'lte':
        return { clause: `${field} <= ?`, param: this.serializeValue(value) };
      case 'in':
        if (Array.isArray(value)) {
          const placeholders = value.map(() => '?').join(', ');
          const serializedValues = value.map(v => this.serializeValue(v));

          return { clause: `${field} IN (${placeholders})`, param: serializedValues };
        }
        throw new ValidationError('IN operator requires array value');
      case 'nin':
        if (Array.isArray(value)) {
          const placeholders = value.map(() => '?').join(', ');
          const serializedValues = value.map(v => this.serializeValue(v));

          return { clause: `${field} NOT IN (${placeholders})`, param: serializedValues };
        }
        throw new ValidationError('NOT IN operator requires array value');
      case 'like':
        return { clause: `${field} LIKE ?`, param: this.serializeValue(value) };
      case 'ilike':
        return { clause: `${field} LIKE ? COLLATE NOCASE`, param: this.serializeValue(value) };
      default:
        throw new ValidationError(`Unsupported query operator: ${operator}`);
    }
  }

  private formatColumnDefinition(column: ColumnDefinition): string {
    let definition = `${column.name} `;

    // Map types to SQLite types
    switch (column.type) {
      case 'string':
        definition += column.maxLength ? `VARCHAR(${column.maxLength})` : 'TEXT';
        break;
      case 'number':
        definition += 'REAL';
        break;
      case 'boolean':
        definition += 'INTEGER'; // SQLite doesn't have native boolean
        break;
      case 'date':
        definition += 'DATETIME';
        break;
      case 'json':
        definition += 'TEXT'; // Store JSON as text
        break;
      default:
        definition += 'TEXT';
    }

    if (column.primaryKey) {
      definition += ' PRIMARY KEY';
    }

    if (!column.nullable) {
      definition += ' NOT NULL';
    }

    if (column.unique && !column.primaryKey) {
      definition += ' UNIQUE';
    }

    if (column.defaultValue !== undefined) {
      definition += ` DEFAULT ${this.formatDefaultValue(column.defaultValue)}`;
    }

    return definition;
  }

  private formatDefaultValue(value: unknown): string {
    if (typeof value === 'string') {
      return `'${value}'`;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (value === null) {
      return 'NULL';
    }

    return `'${JSON.stringify(value)}'`;
  }

  private deserializeRecord<T extends BaseRecord>(record: T): T {
    // Convert date strings back to Date objects
    const result = { ...record };

    if (typeof result.createdAt === 'string') {
      result.createdAt = new Date(result.createdAt);
    }

    if (typeof result.updatedAt === 'string') {
      result.updatedAt = new Date(result.updatedAt);
    }

    // Convert SQLite integers back to booleans for specific known boolean fields.
    // This uses an explicit allowlist instead of fragile heuristics to avoid
    // accidentally converting legitimate numeric fields (priority, status, version, etc.)
    const knownBooleanFields = new Set(['active']);

    for (const [key, value] of Object.entries(result)) {
      if (
        typeof value === 'number' &&
        (value === 0 || value === 1) &&
        knownBooleanFields.has(key)
      ) {
        (result as unknown as Record<string, unknown>)[key] = Boolean(value);
      }
    }

    return result;
  }

  private serializeValue(value: unknown): string | number | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (typeof value === 'boolean') {
      return value ? 1 : 0; // SQLite boolean as integer
    }

    if (typeof value === 'object') {
      return JSON.stringify(value);
    }

    if (typeof value === 'string' || typeof value === 'number') {
      return value;
    }

    return String(value);
  }
}
