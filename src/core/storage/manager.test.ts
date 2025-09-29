/**
 * Storage Manager Tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { StorageManager } from './manager';
import type { StorageConfig, QueryFilter } from './types';

describe('StorageManager', () => {
  let manager: StorageManager;

  describe('SQLite storage type', () => {
    const config: StorageConfig = {
      type: 'sqlite',
      database: {
        memory: true,
      },
      cache: {
        maxSize: 100,
        ttlSeconds: 60,
      },
    };

    beforeEach(async () => {
      manager = new StorageManager();
      await manager.initialize(config);

      await manager.createTable('test_records', {
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
      await manager.close();
    });

    test('should initialize with SQLite provider', async () => {
      const healthCheck = await manager.healthCheck();

      expect(healthCheck).toBe(true);

      const provider = manager.getProvider();

      expect(provider).toBeDefined();

      const cache = manager.getCache();

      expect(cache).toBeNull(); // SQLite doesn't have built-in cache
    });

    test('should perform basic CRUD operations', async () => {
      const data = {
        name: 'John Doe',
        email: 'john@example.com',
        age: 30,
        active: true,
      };

      // Create
      const created = await manager.create('test_records', data);

      expect(created.id as string).toBeDefined();
      expect(created.name).toBe(data.name);

      // Read
      const found = await manager.findById('test_records', created.id as string);

      expect(found).not.toBeNull();
      expect(found?.email).toBe(data.email);

      // Update
      const updated = await manager.updateById('test_records', created.id as string, {
        age: 31,
      });

      expect(updated?.age).toBe(31);

      // Delete
      const deleted = await manager.deleteById('test_records', created.id as string);

      expect(deleted).toBe(true);

      const notFound = await manager.findById('test_records', created.id as string);

      expect(notFound).toBeNull();
    });

    test('should provide storage statistics', async () => {
      await manager.create('test_records', {
        name: 'Stats Test',
        email: 'stats@example.com',
        age: 25,
        active: true,
      });

      const stats = await manager.getStats();

      expect(stats.provider).toBe('sqlite');
      expect(stats.tablesCount).toBeGreaterThan(0);
      expect(stats.totalRecords).toBeGreaterThan(0);
      expect(stats.performance.totalQueries).toBeGreaterThan(0);
    });

    test('should support transactions', async () => {
      const result = await manager.withTransaction(async tx => {
        const created1 = await tx.create('test_records', {
          name: 'TX User 1',
          email: 'tx1@example.com',
          age: 25,
          active: true,
        });

        const created2 = await tx.create('test_records', {
          name: 'TX User 2',
          email: 'tx2@example.com',
          age: 30,
          active: true,
        });

        return { created1, created2 };
      });

      expect(result.created1.name).toBe('TX User 1');
      expect(result.created2.name).toBe('TX User 2');

      // Verify records exist outside transaction
      const count = await manager.count('test_records');

      expect(count).toBe(2);
    });
  });

  describe('Memory storage type', () => {
    const config: StorageConfig = {
      type: 'memory',
      cache: {
        maxSize: 100,
        ttlSeconds: 60,
      },
    };

    beforeEach(async () => {
      manager = new StorageManager();
      await manager.initialize(config);

      await manager.createTable('test_records', {
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
      await manager.close();
    });

    test('should initialize with Memory provider and cache', async () => {
      const healthCheck = await manager.healthCheck();

      expect(healthCheck).toBe(true);

      const cache = manager.getCache();

      expect(cache).not.toBeNull();
    });

    test('should cache records on access', async () => {
      const cache = manager.getCache();

      expect(cache).not.toBeNull();

      const data = {
        name: 'Cache Test',
        email: 'cache@example.com',
        age: 30,
        active: true,
      };

      const created = await manager.create('test_records', data);

      // First access should cache the record
      await manager.findById('test_records', created.id as string);

      // Check if it's cached
      if (!cache) throw new Error('cache should be available');
      const cached = await cache.get(`test_records:${created.id as string}`);

      expect(cached).not.toBeNull();
    });

    test('should invalidate cache on updates and deletes', async () => {
      const cache = manager.getCache();

      expect(cache).not.toBeNull();

      const data = {
        name: 'Cache Invalidation Test',
        email: 'invalidate@example.com',
        age: 30,
        active: true,
      };

      const created = await manager.create('test_records', data);

      // Cache the record
      await manager.findById('test_records', created.id as string);
      if (!cache) throw new Error('cache should be available');
      let cached = await cache.get(`test_records:${created.id as string}`);

      expect(cached).not.toBeNull();

      // Update should invalidate cache
      await manager.updateById('test_records', created.id as string, { age: 31 });
      cached = await cache.get(`test_records:${created.id as string}`);
      expect(cached).toBeNull();

      // Cache again
      await manager.findById('test_records', created.id as string);
      cached = await cache.get(`test_records:${created.id as string}`);
      expect(cached).not.toBeNull();

      // Delete should invalidate cache
      await manager.deleteById('test_records', created.id as string);
      cached = await cache.get(`test_records:${created.id as string}`);
      expect(cached).toBeNull();
    });
  });

  describe('Hybrid storage type', () => {
    const config: StorageConfig = {
      type: 'hybrid',
      database: {
        memory: true,
      },
      cache: {
        maxSize: 100,
        ttlSeconds: 60,
      },
    };

    beforeEach(async () => {
      manager = new StorageManager();
      await manager.initialize(config);

      await manager.createTable('test_records', {
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
      await manager.close();
    });

    test('should initialize hybrid storage (SQLite + cache features)', async () => {
      const healthCheck = await manager.healthCheck();

      expect(healthCheck).toBe(true);

      const stats = await manager.getStats();

      expect(stats.provider).toBe('hybrid');
    });

    test('should provide cache-aware operations', async () => {
      const data = {
        name: 'Hybrid Test',
        email: 'hybrid@example.com',
        age: 28,
        active: true,
      };

      const created = await manager.create('test_records', data);

      // Multiple accesses should be efficient with caching
      const found1 = await manager.findById('test_records', created.id as string);
      const found2 = await manager.findById('test_records', created.id as string);

      expect(found1).toEqual(found2);
    });
  });

  describe('Event system', () => {
    const config: StorageConfig = {
      type: 'memory',
      cache: { maxSize: 10 },
    };

    beforeEach(async () => {
      manager = new StorageManager();
      await manager.initialize(config);

      await manager.createTable('test_records', {
        name: 'test_records',
        columns: [
          { name: 'id', type: 'string', primaryKey: true },
          { name: 'name', type: 'string', nullable: false },
        ],
        timestamps: true,
      });
    });

    afterEach(async () => {
      await manager.close();
    });

    test('should emit events for storage operations', async () => {
      const events: Array<{ type: string; data: unknown }> = [];

      manager.on('record:created', data => {
        events.push({ type: 'created', data });
      });

      manager.on('record:updated', data => {
        events.push({ type: 'updated', data });
      });

      manager.on('record:deleted', data => {
        events.push({ type: 'deleted', data });
      });

      // Create
      const created = await manager.create('test_records', {
        name: 'Event Test',
        email: 'event@example.com',
        age: 25,
        active: true,
      });

      // Update
      await manager.updateById('test_records', created.id as string, { age: 26 });

      // Delete
      await manager.deleteById('test_records', created.id as string);

      expect(events).toHaveLength(3);
      expect(events[0]?.type).toBe('created');
      expect(events[1]?.type).toBe('updated');
      expect(events[2]?.type).toBe('deleted');
    });

    test('should support event listener removal', async () => {
      let eventCount = 0;

      const listener = () => {
        eventCount++;
      };

      manager.on('record:created', listener);

      // Create record - should trigger event
      await manager.create('test_records', {
        name: 'Test 1',
        email: 'test1@example.com',
        age: 25,
        active: true,
      });

      expect(eventCount).toBe(1);

      // Remove listener
      manager.off('record:created', listener);

      // Create another record - should not trigger event
      await manager.create('test_records', {
        name: 'Test 2',
        email: 'test2@example.com',
        age: 25,
        active: true,
      });

      expect(eventCount).toBe(1); // Still 1, not incremented
    });
  });

  describe('Error handling', () => {
    test('should throw error when not initialized', async () => {
      const uninitializedManager = new StorageManager();

      await expect(uninitializedManager.create('test', { name: 'test' })).rejects.toThrow(
        'Storage manager not initialized'
      );
    });

    test('should throw error for unsupported storage type', async () => {
      const invalidManager = new StorageManager();

      await expect(
        invalidManager.initialize({ type: 'invalid' as 'memory' | 'sqlite' })
      ).rejects.toThrow('Unsupported storage type');
    });
  });

  describe('Query operations', () => {
    const config: StorageConfig = {
      type: 'memory',
      cache: { maxSize: 100 },
    };

    beforeEach(async () => {
      manager = new StorageManager();
      await manager.initialize(config);

      await manager.createTable('test_records', {
        name: 'test_records',
        columns: [
          { name: 'id', type: 'string', primaryKey: true },
          { name: 'name', type: 'string', nullable: false },
          { name: 'age', type: 'number' },
          { name: 'active', type: 'boolean' },
        ],
        timestamps: true,
      });

      // Create test data
      await manager.createMany('test_records', [
        { name: 'Alice', email: 'alice@example.com', age: 25, active: true },
        { name: 'Bob', email: 'bob@example.com', age: 35, active: false },
        { name: 'Charlie', email: 'charlie@example.com', age: 28, active: true },
      ]);
    });

    afterEach(async () => {
      await manager.close();
    });

    test('should support complex queries', async () => {
      const filter: QueryFilter = {
        conditions: [{ field: 'active', operator: 'eq', value: true }],
      };

      const result = await manager.find('test_records', { filter });

      expect(result.data).toHaveLength(2);
      expect(result.data.every(record => record.active)).toBe(true);
    });

    test('should support bulk operations', async () => {
      const filter: QueryFilter = {
        conditions: [{ field: 'active', operator: 'eq', value: true }],
      };

      const updatedCount = await manager.updateMany('test_records', filter, {
        age: 30,
      });

      expect(updatedCount).toBe(2);

      const deletedCount = await manager.deleteMany('test_records', filter);

      expect(deletedCount).toBe(2);

      const remainingCount = await manager.count('test_records');

      expect(remainingCount).toBe(1);
    });
  });
});
