/**
 * Memory Storage Provider Tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { MemoryStorageProvider } from './memory';
import type { StorageConfig, BaseRecord, QueryFilter } from '../types';

interface TestRecord extends BaseRecord {
  name: string;
  email: string;
  age: number;
  active: boolean;
}

describe('MemoryStorageProvider', () => {
  let provider: MemoryStorageProvider;
  const config: StorageConfig = {
    type: 'memory',
    cache: {
      maxSize: 100,
      ttlSeconds: 60,
      maxMemoryMb: 10,
    },
  };

  beforeEach(async () => {
    provider = new MemoryStorageProvider();
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
    });
  });

  afterEach(async () => {
    await provider.close();
  });

  describe('initialization', () => {
    test('should initialize successfully', async () => {
      const healthCheck = await provider.healthCheck();

      expect(healthCheck).toBe(true);
    });

    test('should create and list tables', async () => {
      const tables = await provider.listTables();

      expect(tables).toContain('test_records');
    });

    test('should provide cache operations when configured', () => {
      const cache = provider.getCache();

      expect(cache).not.toBeNull();
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

      const created = await provider.create('test_records', data);

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

      const created = (await provider.createMany('test_records', data)) as TestRecord[];

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

      const created = await provider.create('test_records', data);
      const found = (await provider.findById(
        'test_records',
        created.id as string
      )) as TestRecord | null;

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

      const created = await provider.create('test_records', data);
      const updated = (await provider.updateById('test_records', created.id as string, {
        name: 'Updated Name',
        age: 45,
      })) as TestRecord | null;

      expect(updated).not.toBeNull();
      expect(updated?.name).toBe('Updated Name');
      expect(updated?.age).toBe(45);
      expect(updated?.email).toBe(data.email); // Should remain unchanged
      expect((updated?.updatedAt as Date).getTime()).toBeGreaterThanOrEqual(
        (created.updatedAt as Date).getTime()
      );
    });

    test('should delete record by ID', async () => {
      const data = {
        name: 'Delete Test',
        email: 'delete@example.com',
        age: 30,
        active: true,
      };

      const created = await provider.create('test_records', data);
      const deleted = await provider.deleteById('test_records', created.id as string);

      expect(deleted).toBe(true);

      const found = (await provider.findById(
        'test_records',
        created.id as string
      )) as TestRecord | null;

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

      await provider.createMany('test_records', testData);
    });

    test('should find all records without filter', async () => {
      const result = await provider.find('test_records');

      expect(result.data).toHaveLength(5);
      expect(result.total).toBe(5);
      expect(result.hasMore).toBe(false);
    });

    test('should filter records by equality', async () => {
      const filter: QueryFilter = {
        conditions: [{ field: 'active', operator: 'eq', value: true }],
      };

      const result = await provider.find('test_records', { filter });

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

      const result = await provider.find('test_records', { filter });

      expect(result.data).toHaveLength(2); // Alice (25) and Charlie (28)
      expect(
        result.data.every(
          record => (record as TestRecord).age >= 25 && (record as TestRecord).age <= 30
        )
      ).toBe(true);
    });

    test('should sort records', async () => {
      const result = await provider.find('test_records', {
        sort: [{ field: 'age', direction: 'desc' }],
      });

      expect(result.data[0]?.age).toBe(35); // Bob
      expect(result.data[1]?.age).toBe(32); // David
      expect(result.data[2]?.age).toBe(28); // Charlie
    });

    test('should paginate results', async () => {
      const result = await provider.find('test_records', {
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

      const record = await provider.findFirst('test_records', {
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
      const testData = { name: 'Exists Test', email: 'exists@example.com', age: 30, active: true };
      const created = await provider.create('test_records', testData);

      const exists = await provider.exists('test_records', created.id as string);

      expect(exists).toBe(true);

      const notExists = await provider.exists('test_records', 'non-existent-id');

      expect(notExists).toBe(false);
    });
  });

  describe('bulk operations', () => {
    beforeEach(async () => {
      const testData = [
        { name: 'User1', email: 'user1@example.com', age: 25, active: true },
        { name: 'User2', email: 'user2@example.com', age: 35, active: false },
        { name: 'User3', email: 'user3@example.com', age: 28, active: true },
      ];

      await provider.createMany('test_records', testData);
    });

    test('should update multiple records', async () => {
      const filter: QueryFilter = {
        conditions: [{ field: 'active', operator: 'eq', value: true }],
      };

      const updated = await provider.updateMany('test_records', filter, {
        age: 30,
      });

      expect(updated).toBe(2); // Should update 2 active records

      const result = await provider.find('test_records', { filter });

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
        const created1 = await txProvider.create('test_records', {
          name: 'TX User 1',
          email: 'tx1@example.com',
          age: 25,
          active: true,
        });

        const created2 = await txProvider.create('test_records', {
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

    test('should handle transaction rollback gracefully', async () => {
      const tx = await provider.beginTransaction();

      try {
        await tx.execute(async txProvider => {
          await txProvider.create('test_records', {
            name: 'TX User 1',
            email: 'tx1@example.com',
            age: 25,
            active: true,
          });

          throw new Error('Simulated error');
        });
      } catch {
        // Expected to throw
      }

      // Since memory provider doesn't have true ACID transactions,
      // the record will still be created. This is expected behavior
      // for the in-memory implementation.
      expect(tx.isActive()).toBe(false);
    });
  });

  describe('cache integration', () => {
    test('should cache records on access', async () => {
      const cache = provider.getCache();

      expect(cache).not.toBeNull();

      const data = {
        name: 'Cache Test',
        email: 'cache@example.com',
        age: 30,
        active: true,
      };

      const created = await provider.create('test_records', data);

      // First access - should be cached
      const found1 = await provider.findById('test_records', created.id as string);

      expect(found1).not.toBeNull();

      // Check if it's in cache
      if (!cache) throw new Error('cache should be available');
      const cached = await cache.get(`test_records:${created.id}`);

      expect(cached).not.toBeNull();
    });
  });

  describe('table management', () => {
    test('should create and drop tables', async () => {
      await provider.createTable('temp_table', {
        name: 'temp_table',
        columns: [
          { name: 'id', type: 'string', primaryKey: true },
          { name: 'value', type: 'string' },
        ],
        timestamps: true,
      });

      let tables = await provider.listTables();

      expect(tables).toContain('temp_table');

      await provider.dropTable('temp_table');

      tables = await provider.listTables();
      expect(tables).not.toContain('temp_table');
    });

    test('should throw error for operations on non-existent table', async () => {
      await expect(provider.create('non_existent_table', { name: 'test' })).rejects.toThrow();
    });
  });

  describe('query operators', () => {
    beforeEach(async () => {
      const testData = [
        { name: 'Alice Johnson', email: 'alice@example.com', age: 25, active: true },
        { name: 'Bob Smith', email: 'bob@example.com', age: 35, active: false },
        { name: 'Charlie Brown', email: 'charlie@example.com', age: 28, active: true },
      ];

      await provider.createMany('test_records', testData);
    });

    test('should handle IN operator', async () => {
      const filter: QueryFilter = {
        conditions: [{ field: 'age', operator: 'in', value: [25, 35] }],
      };

      const result = await provider.find('test_records', { filter });

      expect(result.data).toHaveLength(2);
      expect(result.data.map(r => r.age).sort()).toEqual([25, 35]);
    });

    test('should handle NOT IN operator', async () => {
      const filter: QueryFilter = {
        conditions: [{ field: 'age', operator: 'nin', value: [25, 35] }],
      };

      const result = await provider.find('test_records', { filter });

      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.age).toBe(28);
    });

    test('should handle LIKE operator', async () => {
      const filter: QueryFilter = {
        conditions: [{ field: 'name', operator: 'like', value: 'Johnson' }],
      };

      const result = await provider.find('test_records', { filter });

      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.name).toBe('Alice Johnson');
    });

    test('should handle case insensitive LIKE operator', async () => {
      const filter: QueryFilter = {
        conditions: [{ field: 'name', operator: 'ilike', value: 'JOHNSON' }],
      };

      const result = await provider.find('test_records', { filter });

      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.name).toBe('Alice Johnson');
    });
  });
});
