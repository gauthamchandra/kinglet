/**
 * LRU Cache Tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { LRUCache, LRUCacheConfig } from './lru-cache';

describe('LRUCache', () => {
  let cache: LRUCache;
  const config: LRUCacheConfig = {
    maxSize: 10, // Increased to accommodate data types test
    defaultTTL: 2, // 2 seconds
    // No cleanup interval to avoid hanging tests
  };

  beforeEach(() => {
    cache = new LRUCache(config);
  });

  afterEach(() => {
    cache.destroy();
  });

  describe('basic operations', () => {
    test('should set and get values', async () => {
      await cache.set('key1', 'value1');
      const result = await cache.get('key1');

      expect(result).toBe('value1');
    });

    test('should return null for non-existent keys', async () => {
      const result = await cache.get('non-existent');

      expect(result).toBeNull();
    });

    test('should delete values', async () => {
      await cache.set('key1', 'value1');
      const deleted = await cache.delete('key1');

      expect(deleted).toBe(true);

      const result = await cache.get('key1');

      expect(result).toBeNull();
    });

    test('should return false when deleting non-existent key', async () => {
      const deleted = await cache.delete('non-existent');

      expect(deleted).toBe(false);
    });

    test('should check if key exists', async () => {
      await cache.set('key1', 'value1');
      expect(await cache.has('key1')).toBe(true);
      expect(await cache.has('non-existent')).toBe(false);
    });

    test('should clear all entries', async () => {
      await cache.set('key1', 'value1');
      await cache.set('key2', 'value2');
      expect(cache.size()).toBe(2);

      await cache.clear();
      expect(cache.size()).toBe(0);
      expect(await cache.get('key1')).toBeNull();
    });
  });

  describe('LRU eviction', () => {
    test('should evict least recently used item when at capacity', async () => {
      // Create a cache with smaller size for this test
      const smallCache = new LRUCache({
        maxSize: 3,
        defaultTTL: 10, // Longer TTL to avoid expiration during test
      });

      await smallCache.set('key1', 'value1');
      await smallCache.set('key2', 'value2');
      await smallCache.set('key3', 'value3');
      expect(smallCache.size()).toBe(3);

      // Access key1 to make it recently used
      await smallCache.get('key1');

      // Add new item - should evict key2 (least recently used)
      await smallCache.set('key4', 'value4');
      expect(smallCache.size()).toBe(3);

      expect(await smallCache.get('key1')).toBe('value1'); // Should still exist
      expect(await smallCache.get('key2')).toBeNull(); // Should be evicted
      expect(await smallCache.get('key3')).toBe('value3'); // Should still exist
      expect(await smallCache.get('key4')).toBe('value4'); // Should exist

      smallCache.destroy();
    });

    test('should update existing keys without eviction', async () => {
      // Create a cache with smaller size for this test
      const smallCache = new LRUCache({
        maxSize: 3,
        defaultTTL: 10, // Longer TTL to avoid expiration during test
      });

      await smallCache.set('key1', 'value1');
      await smallCache.set('key2', 'value2');
      await smallCache.set('key3', 'value3');
      expect(smallCache.size()).toBe(3);

      // Update existing key
      await smallCache.set('key1', 'updated-value1');
      expect(smallCache.size()).toBe(3);
      expect(await smallCache.get('key1')).toBe('updated-value1');

      smallCache.destroy();
    });
  });

  describe('TTL expiration', () => {
    test('should expire items after TTL', async () => {
      await cache.set('key1', 'value1', 0.1); // 100ms TTL

      expect(await cache.get('key1')).toBe('value1');

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(await cache.get('key1')).toBeNull();
      expect(await cache.has('key1')).toBe(false);
    });

    test('should use default TTL when not specified', async () => {
      await cache.set('key1', 'value1'); // Uses default TTL of 2 seconds

      expect(await cache.get('key1')).toBe('value1');

      // Should still exist before expiration
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await cache.get('key1')).toBe('value1');
    });

    test('should not expire items without TTL', async () => {
      const neverExpireCache = new LRUCache({
        maxSize: 5,
        // No default TTL
      });

      await neverExpireCache.set('key1', 'value1');
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(await neverExpireCache.get('key1')).toBe('value1');

      neverExpireCache.destroy();
    });
  });

  describe('statistics', () => {
    test('should track cache statistics', async () => {
      // Perform some operations
      await cache.set('key1', 'value1');
      await cache.set('key2', 'value2');

      await cache.get('key1'); // Hit
      await cache.get('key1'); // Hit
      await cache.get('non-existent'); // Miss

      const stats = await cache.getStats();

      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.entries).toBe(2);
      expect(stats.hitRate).toBeCloseTo(66.67, 1);
      expect(stats.memoryUsage).toBeGreaterThan(0);
    });

    test('should handle zero requests gracefully', async () => {
      const stats = await cache.getStats();

      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.hitRate).toBe(0);
    });
  });

  describe('data types', () => {
    test('should handle different data types', async () => {
      await cache.set('string', 'hello');
      await cache.set('number', 42);
      await cache.set('boolean', true);
      await cache.set('object', { foo: 'bar' });
      await cache.set('array', [1, 2, 3]);
      await cache.set('null', null);

      expect(await cache.get('string')).toBe('hello');
      expect(await cache.get('number')).toBe(42);
      expect(await cache.get('boolean')).toBe(true);
      expect(await cache.get('object')).toEqual({ foo: 'bar' });
      expect(await cache.get('array')).toEqual([1, 2, 3]);
      expect(await cache.get('null')).toBe(null);
    });
  });

  describe('cleanup', () => {
    test('should clean up expired entries', async () => {
      await cache.set('key1', 'value1', 0.1); // 100ms TTL
      await cache.set('key2', 'value2'); // Default TTL

      expect(cache.size()).toBe(2);

      // Wait for first key to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      // Trigger cleanup
      cache.cleanup();

      expect(cache.size()).toBe(1);
      expect(await cache.get('key1')).toBeNull();
      expect(await cache.get('key2')).toBe('value2');
    });
  });

  describe('memory management', () => {
    test('should respect memory limits', async () => {
      const memoryLimitedCache = new LRUCache({
        maxSize: 100,
        maxMemoryMb: 0.001, // Very small memory limit (1KB)
      });

      // Add many large strings to exceed memory limit
      for (let i = 0; i < 20; i++) {
        await memoryLimitedCache.set(`key${i}`, 'x'.repeat(100)); // 100 char strings
      }

      // Should have evicted some entries due to memory pressure
      expect(memoryLimitedCache.size()).toBeLessThan(20);

      memoryLimitedCache.destroy();
    });
  });

  describe('cache capacity', () => {
    test('should report capacity status', async () => {
      // Create a cache with smaller size for this test
      const smallCache = new LRUCache({
        maxSize: 3,
        defaultTTL: 10, // Longer TTL to avoid expiration during test
      });

      expect(smallCache.isFull()).toBe(false);

      await smallCache.set('key1', 'value1');
      await smallCache.set('key2', 'value2');
      expect(smallCache.isFull()).toBe(false);

      await smallCache.set('key3', 'value3');
      expect(smallCache.isFull()).toBe(true);

      smallCache.destroy();
    });
  });
});
