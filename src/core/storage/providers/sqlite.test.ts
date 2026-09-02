/**
 * SQLite Storage Provider Tests
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { BaseRecord, QueryFilter, QueryOperator, StorageConfig } from '../types';
import { SQLiteStorageProvider } from './sqlite';

interface TestRecord extends BaseRecord {
  name: string;
  email: string;
  age: number;
  active: boolean;
}

describe('SQLiteStorageProvider', () => {
  let provider: SQLiteStorageProvider;
  const config: StorageConfig = {
    type: 'sqlite',
    database: {
      memory: true, // Use in-memory database for tests
    },
  };

  beforeEach(async () => {
    provider = new SQLiteStorageProvider();
    await provider.initialize(config);

    // Create test table
    await provider.createTable('test_records', {
      name: 'test_records',
      columns: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'name', type: 'string', nullable: false },
        { name: 'email', type: 'string', unique: true },
        { name: 'age', type: 'number', nullable: true },
        { name: 'active', type: 'boolean', defaultValue: true },
      ],
      timestamps: true,
      indexes: [
        { name: 'email_idx', columns: ['email'], unique: true },
        { name: 'name_age_idx', columns: ['name', 'age'] },
      ],
    });
  });

  afterEach(async () => {
    await provider.close();
  });

  describe('initialization', () => {
    test('should initialize successfully with memory database', async () => {
      const newProvider = new SQLiteStorageProvider();

      await newProvider.initialize(config);

      const healthCheck = await newProvider.healthCheck();

      expect(healthCheck).toBe(true);

      await newProvider.close();
    });

    test('should list tables after creation', async () => {
      const tables = await provider.listTables();

      expect(tables).toContain('test_records');
    });
  });

  describe('CRUD operations', () => {
    test('should create a record successfully', async () => {
      const data = {
        name: 'John Doe',
        email: 'john@example.com',
        age: 30,
        active: true,
      };

      const created = await provider.create<TestRecord>('test_records', data);

      expect(created.id).toBeDefined();
      expect(created.name).toBe(data.name);
      expect(created.email).toBe(data.email);
      expect(created.age).toBe(data.age);
      expect(created.active).toBe(data.active);
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created.updatedAt).toBeInstanceOf(Date);
    });

    test('should create multiple records in bulk', async () => {
      const data = [
        { name: 'Alice', email: 'alice@example.com', age: 25, active: true },
        { name: 'Bob', email: 'bob@example.com', age: 35, active: false },
        { name: 'Charlie', email: 'charlie@example.com', age: 28, active: true },
      ];

      const created = await provider.createMany<TestRecord>('test_records', data);

      expect(created).toHaveLength(3);
      expect(created[0]?.name).toBe('Alice');
      expect(created[1]?.name).toBe('Bob');
      expect(created[2]?.name).toBe('Charlie');
    });

    test('should find record by ID', async () => {
      const data = {
        name: 'Jane Doe',
        email: 'jane@example.com',
        age: 28,
        active: true,
      };

      const created = await provider.create<TestRecord>('test_records', data);
      const found = await provider.findById<TestRecord>('test_records', created.id);

      expect(found).not.toBeNull();
      expect(found?.name).toBe(data.name);
      expect(found?.email).toBe(data.email);
    });

    test('should return null when record not found', async () => {
      const found = await provider.findById('test_records', 'non-existent-id');

      expect(found).toBeNull();
    });

    test('should update record by ID', async () => {
      const data = {
        name: 'Update Test',
        email: 'update@example.com',
        age: 40,
        active: true,
      };

      const created = await provider.create<TestRecord>('test_records', data);
      const updated = await provider.updateById<TestRecord>('test_records', created.id, {
        name: 'Updated Name',
        age: 45,
      });

      expect(updated).not.toBeNull();
      expect(updated?.name).toBe('Updated Name');
      expect(updated?.age).toBe(45);
      expect(updated?.email).toBe(data.email); // Should remain unchanged
      expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
    });

    test('should delete record by ID', async () => {
      const data = {
        name: 'Delete Test',
        email: 'delete@example.com',
        age: 30,
        active: true,
      };

      const created = await provider.create<TestRecord>('test_records', data);
      const deleted = await provider.deleteById('test_records', created.id);

      expect(deleted).toBe(true);

      const found = await provider.findById('test_records', created.id);

      expect(found).toBeNull();
    });

    test('should return false when deleting non-existent record', async () => {
      const deleted = await provider.deleteById('test_records', 'non-existent-id');

      expect(deleted).toBe(false);
    });
  });

  describe('query operations', () => {
    beforeEach(async () => {
      // Create test data
      const testData = [
        { name: 'Alice', email: 'alice@example.com', age: 25, active: true },
        { name: 'Bob', email: 'bob@example.com', age: 35, active: false },
        { name: 'Charlie', email: 'charlie@example.com', age: 28, active: true },
        { name: 'David', email: 'david@example.com', age: 32, active: true },
        { name: 'Eve', email: 'eve@example.com', age: 22, active: false },
      ];

      await provider.createMany<TestRecord>('test_records', testData);
    });

    test('should find all records without filter', async () => {
      const result = await provider.find<TestRecord>('test_records');

      expect(result.data).toHaveLength(5);
      expect(result.total).toBe(5);
      expect(result.hasMore).toBe(false);
    });

    test('should filter records by equality', async () => {
      const filter: QueryFilter = {
        conditions: [{ field: 'active', operator: 'eq', value: true }],
      };

      const result = await provider.find<TestRecord>('test_records', { filter });

      expect(result.data).toHaveLength(3);
      expect(result.data.every(record => record.active)).toBe(true);
    });

    test('should filter records by age range', async () => {
      const filter: QueryFilter = {
        conditions: [
          { field: 'age', operator: 'gte', value: 25 },
          { field: 'age', operator: 'lte', value: 30 },
        ],
        operator: 'and',
      };

      const result = await provider.find<TestRecord>('test_records', { filter });

      expect(result.data).toHaveLength(2); // Alice (25) and Charlie (28)
      expect(result.data.every(record => record.age >= 25 && record.age <= 30)).toBe(true);
    });

    test('should sort records', async () => {
      const result = await provider.find<TestRecord>('test_records', {
        sort: [{ field: 'age', direction: 'desc' }],
      });

      expect(result.data[0]?.age).toBe(35); // Bob
      expect(result.data[1]?.age).toBe(32); // David
      expect(result.data[2]?.age).toBe(28); // Charlie
    });

    test('should paginate results', async () => {
      const result = await provider.find<TestRecord>('test_records', {
        pagination: { limit: 2, offset: 1 },
        sort: [{ field: 'name', direction: 'asc' }],
      });

      expect(result.data).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.total).toBe(5);
    });

    test('should find first record matching criteria', async () => {
      const filter: QueryFilter = {
        conditions: [{ field: 'active', operator: 'eq', value: true }],
      };

      const record = await provider.findFirst<TestRecord>('test_records', {
        filter,
        sort: [{ field: 'age', direction: 'asc' }],
      });

      expect(record).not.toBeNull();
      expect(record?.active).toBe(true);
      expect(record?.age).toBe(25); // Alice is the youngest active user
    });

    test('should count records with filter', async () => {
      const filter: QueryFilter = {
        conditions: [{ field: 'active', operator: 'eq', value: true }],
      };

      const count = await provider.count('test_records', filter);

      expect(count).toBe(3);
    });

    test('should check if record exists', async () => {
      // Create a fresh provider to avoid interference from other tests
      const freshProvider = new SQLiteStorageProvider();

      await freshProvider.initialize(config);

      await freshProvider.createTable('exists_test', {
        name: 'exists_test',
        columns: [
          { name: 'id', type: 'string', primaryKey: true },
          { name: 'name', type: 'string', nullable: false },
          { name: 'email', type: 'string', unique: true },
          { name: 'age', type: 'number', nullable: true },
          { name: 'active', type: 'boolean', defaultValue: true },
        ],
        timestamps: true,
      });

      const testData = { name: 'Exists Test', email: 'exists@example.com', age: 30, active: true };
      const created = await freshProvider.create<TestRecord>('exists_test', testData);

      const exists = await freshProvider.exists('exists_test', created.id);

      expect(exists).toBe(true);

      const notExists = await freshProvider.exists(
        'exists_test',
        'definitely-non-existent-id-12345'
      );

      expect(notExists).toBe(false);

      await freshProvider.close();
    });
  });

  describe('bulk operations', () => {
    beforeEach(async () => {
      const testData = [
        { name: 'User1', email: 'user1@example.com', age: 25, active: true },
        { name: 'User2', email: 'user2@example.com', age: 35, active: false },
        { name: 'User3', email: 'user3@example.com', age: 28, active: true },
      ];

      await provider.createMany<TestRecord>('test_records', testData);
    });

    test('should update multiple records', async () => {
      const filter: QueryFilter = {
        conditions: [{ field: 'active', operator: 'eq', value: true }],
      };

      const updated = await provider.updateMany<TestRecord>('test_records', filter, {
        age: 30,
      });

      expect(updated).toBe(2); // Should update 2 active records

      const result = await provider.find<TestRecord>('test_records', { filter });

      expect(result.data.every(record => record.age === 30)).toBe(true);
    });

    test('should delete multiple records', async () => {
      const filter: QueryFilter = {
        conditions: [{ field: 'active', operator: 'eq', value: false }],
      };

      const deleted = await provider.deleteMany('test_records', filter);

      expect(deleted).toBe(1); // Should delete 1 inactive record

      const remaining = await provider.count('test_records');

      expect(remaining).toBe(2);
    });
  });

  describe('transactions', () => {
    test('should commit transaction successfully', async () => {
      const tx = await provider.beginTransaction();

      const result = await tx.execute(async txProvider => {
        const created1 = await txProvider.create<TestRecord>('test_records', {
          name: 'TX User 1',
          email: 'tx1@example.com',
          age: 25,
          active: true,
        });

        const created2 = await txProvider.create<TestRecord>('test_records', {
          name: 'TX User 2',
          email: 'tx2@example.com',
          age: 30,
          active: true,
        });

        return { created1, created2 };
      });

      await tx.commit();

      // Verify records were created
      const count = await provider.count('test_records');

      expect(count).toBe(2);

      expect(result.created1.name).toBe('TX User 1');
      expect(result.created2.name).toBe('TX User 2');
    });

    test('should rollback transaction on error', async () => {
      const tx = await provider.beginTransaction();

      try {
        await tx.execute(async txProvider => {
          await txProvider.create<TestRecord>('test_records', {
            name: 'TX User 1',
            email: 'tx1@example.com',
            age: 25,
            active: true,
          });

          // This should cause an error due to duplicate email
          await txProvider.create<TestRecord>('test_records', {
            name: 'TX User 2',
            email: 'tx1@example.com', // Duplicate email
            age: 30,
            active: true,
          });
        });
      } catch {
        // Expected to throw
      }

      // Verify no records were created due to rollback
      const count = await provider.count('test_records');

      expect(count).toBe(0);
    });
  });

  describe('error handling', () => {
    test('should handle duplicate key constraint', async () => {
      await provider.create<TestRecord>('test_records', {
        name: 'Original',
        email: 'duplicate@example.com',
        age: 25,
        active: true,
      });

      await expect(
        provider.create<TestRecord>('test_records', {
          name: 'Duplicate',
          email: 'duplicate@example.com', // Same email
          age: 30,
          active: true,
        })
      ).rejects.toThrow();
    });

    test('should handle invalid query operators', async () => {
      const filter: QueryFilter = {
        conditions: [{ field: 'name', operator: 'invalid' as QueryOperator, value: 'test' }],
      };

      await expect(provider.find('test_records', { filter })).rejects.toThrow();
    });
  });

  describe('data type preservation', () => {
    interface NumericTestRecord extends BaseRecord {
      name: string;
      priority: number; // 0=low, 1=high - should NOT be converted to boolean
      version: number; // Could be 0 or 1 - should remain numeric
      discount: number; // Contains "count" - should not trigger false positive
      canvas_width: number; // Contains "can" - should not trigger false positive
      status: number; // 0=inactive, 1=active - legitimate numeric field
    }

    beforeEach(async () => {
      await provider.createTable('numeric_records', {
        name: 'numeric_records',
        columns: [
          { name: 'id', type: 'string', primaryKey: true, nullable: false },
          { name: 'name', type: 'string', nullable: false },
          { name: 'priority', type: 'number', nullable: false },
          { name: 'version', type: 'number', nullable: false },
          { name: 'discount', type: 'number', nullable: false },
          { name: 'canvas_width', type: 'number', nullable: false },
          { name: 'status', type: 'number', nullable: false },
        ],
        timestamps: true,
      });
    });

    afterEach(async () => {
      await provider.dropTable('numeric_records');
    });

    test('should preserve numeric 0/1 values without converting to booleans', async () => {
      const data = {
        name: 'Test Record',
        priority: 0, // Should remain 0, not become false
        version: 1, // Should remain 1, not become true
        discount: 0, // Contains "count" but should remain 0
        canvas_width: 1, // Contains "can" but should remain 1
        status: 0, // Should remain 0, not become false
      };

      const created = await provider.create<NumericTestRecord>('numeric_records', data);
      const retrieved = await provider.findById<NumericTestRecord>('numeric_records', created.id);

      expect(retrieved).not.toBeNull();
      if (!retrieved) throw new Error('retrieved should not be null');
      expect(retrieved.priority).toBe(0);
      expect(retrieved.version).toBe(1);
      expect(retrieved.discount).toBe(0);
      expect(retrieved.canvas_width).toBe(1);
      expect(retrieved.status).toBe(0);

      // Ensure they are numbers, not booleans
      expect(typeof retrieved.priority).toBe('number');
      expect(typeof retrieved.version).toBe('number');
      expect(typeof retrieved.discount).toBe('number');
      expect(typeof retrieved.canvas_width).toBe('number');
      expect(typeof retrieved.status).toBe('number');
    });

    test('should handle updates of numeric 0/1 values correctly', async () => {
      const data = {
        name: 'Test Record',
        priority: 0,
        version: 0,
        discount: 1,
        canvas_width: 0,
        status: 1,
      };

      const created = await provider.create<NumericTestRecord>('numeric_records', data);
      const updated = await provider.updateById<NumericTestRecord>('numeric_records', created.id, {
        priority: 1, // Change from 0 to 1
        version: 1, // Change from 0 to 1
        discount: 0, // Change from 1 to 0
        canvas_width: 1, // Change from 0 to 1
        status: 0, // Change from 1 to 0
      });

      expect(updated).not.toBeNull();
      if (!updated) throw new Error('updated should not be null');
      expect(updated.priority).toBe(1);
      expect(updated.version).toBe(1);
      expect(updated.discount).toBe(0);
      expect(updated.canvas_width).toBe(1);
      expect(updated.status).toBe(0);

      // Ensure they are still numbers, not booleans
      expect(typeof updated.priority).toBe('number');
      expect(typeof updated.version).toBe('number');
      expect(typeof updated.discount).toBe('number');
      expect(typeof updated.canvas_width).toBe('number');
      expect(typeof updated.status).toBe('number');
    });
  });

  describe('schema sync', () => {
    test('should add missing columns and relax NOT NULL constraints', async () => {
      await provider.createTable('legacy_jobs', {
        name: 'legacy_jobs',
        columns: [
          { name: 'id', type: 'string', primaryKey: true },
          { name: 'name', type: 'string', unique: true },
          { name: 'httpTarget', type: 'json' },
          { name: 'retryConfig', type: 'json' },
        ],
        timestamps: true,
      });

      await provider.createTable('legacy_jobs', {
        name: 'legacy_jobs',
        columns: [
          { name: 'id', type: 'string', primaryKey: true },
          { name: 'name', type: 'string', unique: true },
          { name: 'httpTarget', type: 'json', nullable: true },
          { name: 'pubsubTarget', type: 'json', nullable: true },
          { name: 'retryConfig', type: 'json' },
        ],
        timestamps: true,
      });

      const db = (
        provider as unknown as { db: { prepare: (sql: string) => { all: () => unknown[] } } }
      ).db;
      const columns = db.prepare('PRAGMA table_info(legacy_jobs)').all() as Array<{
        name: string;
        notnull: number;
      }>;

      const httpTarget = columns.find(column => column.name === 'httpTarget');
      const pubsubTarget = columns.find(column => column.name === 'pubsubTarget');

      expect(httpTarget?.notnull).toBe(0);
      expect(pubsubTarget).toBeDefined();
    });

    test('should preserve id column when schema omits it during rebuild', async () => {
      interface LegacyJobRecord extends BaseRecord {
        name: string;
        httpTarget: { uri: string };
        retryConfig: { retryCount: number };
      }

      await provider.createTable('legacy_jobs_no_id_schema', {
        name: 'legacy_jobs_no_id_schema',
        columns: [
          { name: 'id', type: 'string', primaryKey: true },
          { name: 'name', type: 'string', unique: true },
          { name: 'httpTarget', type: 'json' },
          { name: 'retryConfig', type: 'json' },
        ],
        timestamps: true,
      });

      const created = await provider.create<LegacyJobRecord>('legacy_jobs_no_id_schema', {
        name: 'projects/p/locations/l/jobs/j1',
        httpTarget: { uri: 'https://example.com' },
        retryConfig: { retryCount: 3 },
      });

      await provider.createTable('legacy_jobs_no_id_schema', {
        name: 'legacy_jobs_no_id_schema',
        columns: [
          { name: 'name', type: 'string', unique: true },
          { name: 'httpTarget', type: 'json', nullable: true },
          { name: 'retryConfig', type: 'json' },
        ],
        timestamps: true,
      });

      const db = (
        provider as unknown as { db: { prepare: (sql: string) => { all: () => unknown[] } } }
      ).db;
      const columns = db.prepare('PRAGMA table_info(legacy_jobs_no_id_schema)').all() as Array<{
        name: string;
        pk: number;
      }>;

      expect(columns.some(column => column.name === 'id' && column.pk === 1)).toBe(true);

      const found = await provider.findById<LegacyJobRecord>(
        'legacy_jobs_no_id_schema',
        created.id
      );

      expect(found).not.toBeNull();
      expect(found?.name).toBe(created.name);
    });
  });
});
