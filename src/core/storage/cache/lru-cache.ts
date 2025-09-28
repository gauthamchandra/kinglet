/**
 * LRU Cache with TTL Support
 *
 * This module implements a Least Recently Used (LRU) cache with Time-To-Live (TTL) support.
 * It provides high-performance caching with automatic eviction of stale and least recently used entries.
 */

import type { CacheOperations, CacheStats } from '../types';

/**
 * Cache entry with metadata
 */
interface CacheEntry<T> {
  value: T;
  expiresAt?: number;
  prev?: string;
  next?: string;
}

/**
 * Cache configuration options
 */
export interface LRUCacheConfig {
  maxSize: number; // Maximum number of entries
  defaultTTL?: number; // Default TTL in seconds
  maxMemoryMb?: number; // Maximum memory usage in MB
  cleanupInterval?: number; // Cleanup interval in seconds
}

/**
 * LRU Cache implementation with TTL support
 */
export class LRUCache implements CacheOperations {
  private entries = new Map<string, CacheEntry<unknown>>();
  private head?: string; // Most recently used
  private tail?: string; // Least recently used
  private stats = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    evictions: 0,
  };

  private cleanupTimer?: number;

  constructor(private config: LRUCacheConfig) {
    // Start cleanup timer if specified
    if (config.cleanupInterval && config.cleanupInterval > 0) {
      this.cleanupTimer = setInterval(
        () => this.cleanup(),
        config.cleanupInterval * 1000
      ) as unknown as number;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key) as CacheEntry<T> | undefined;

    if (!entry) {
      this.stats.misses++;

      return null;
    }

    // Check TTL expiration
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      this.removeFromList(key);
      this.stats.misses++;

      return null;
    }

    // Move to head (mark as recently used)
    this.moveToHead(key);
    this.stats.hits++;

    return entry.value;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const now = Date.now();
    const ttl = ttlSeconds ?? this.config.defaultTTL;
    const expiresAt = ttl ? now + ttl * 1000 : undefined;

    const existingEntry = this.entries.get(key);

    if (existingEntry) {
      // Update existing entry
      existingEntry.value = value;

      if (expiresAt !== undefined) {
        existingEntry.expiresAt = expiresAt;
      } else {
        delete existingEntry.expiresAt;
      }
      this.moveToHead(key);
    } else {
      // Create new entry
      const entry: CacheEntry<T> = {
        value,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      };

      this.entries.set(key, entry as CacheEntry<unknown>);
      this.addToHead(key);

      // Check if we need to evict
      if (this.entries.size > this.config.maxSize) {
        await this.evictLRU();
      }

      // Check memory usage if configured
      if (this.config.maxMemoryMb) {
        const memoryUsage = this.getMemoryUsage();

        if (memoryUsage > this.config.maxMemoryMb * 1024 * 1024) {
          await this.evictByMemory();
        }
      }
    }

    this.stats.sets++;
  }

  async delete(key: string): Promise<boolean> {
    const entry = this.entries.get(key);

    if (!entry) {
      return false;
    }

    this.removeFromList(key);
    this.entries.delete(key);
    this.stats.deletes++;

    return true;
  }

  async has(key: string): Promise<boolean> {
    const entry = this.entries.get(key);

    if (!entry) {
      return false;
    }

    // Check TTL expiration
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      this.removeFromList(key);

      return false;
    }

    return true;
  }

  async clear(): Promise<void> {
    this.entries.clear();
    delete this.head;
    delete this.tail;
    this.stats.sets = 0;
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.deletes = 0;
    this.stats.evictions = 0;
  }

  async getStats(): Promise<CacheStats> {
    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRate = totalRequests > 0 ? (this.stats.hits / totalRequests) * 100 : 0;

    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      entries: this.entries.size,
      memoryUsage: this.getMemoryUsage(),
      hitRate: Math.round(hitRate * 100) / 100, // Round to 2 decimal places
    };
  }

  /**
   * Clean up expired entries
   */
  cleanup(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAt && now > entry.expiresAt) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      this.entries.delete(key);
      this.removeFromList(key);
    }
  }

  /**
   * Destroy the cache and clean up resources
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      delete this.cleanupTimer;
    }
    this.entries.clear();
    delete this.head;
    delete this.tail;
  }

  /**
   * Move entry to head of LRU list
   */
  private moveToHead(key: string): void {
    if (this.head === key) {
      return; // Already at head
    }

    // Remove from current position
    this.removeFromList(key);

    // Add to head
    this.addToHead(key);
  }

  /**
   * Add entry to head of LRU list
   */
  private addToHead(key: string): void {
    const entry = this.entries.get(key);

    if (!entry) return;

    if (this.head !== undefined) {
      entry.next = this.head;
    }
    delete entry.prev;

    if (this.head) {
      const headEntry = this.entries.get(this.head);

      if (headEntry) {
        headEntry.prev = key;
      }
    }

    this.head = key;

    if (!this.tail) {
      this.tail = key;
    }
  }

  /**
   * Remove entry from LRU list
   */
  private removeFromList(key: string): void {
    const entry = this.entries.get(key);

    if (!entry) return;

    if (entry.prev) {
      const prevEntry = this.entries.get(entry.prev);

      if (prevEntry) {
        if (entry.next !== undefined) {
          prevEntry.next = entry.next;
        } else {
          delete prevEntry.next;
        }
      }
    } else if (entry.next) {
      this.head = entry.next;
    } else {
      delete this.head;
    }

    if (entry.next) {
      const nextEntry = this.entries.get(entry.next);

      if (nextEntry) {
        if (entry.prev !== undefined) {
          nextEntry.prev = entry.prev;
        } else {
          delete nextEntry.prev;
        }
      }
    } else if (entry.prev) {
      this.tail = entry.prev;
    } else {
      delete this.tail;
    }

    delete entry.prev;
    delete entry.next;
  }

  /**
   * Evict least recently used entry
   */
  private async evictLRU(): Promise<void> {
    if (!this.tail) return;

    const tailKey = this.tail;

    this.removeFromList(tailKey);
    this.entries.delete(tailKey);
    this.stats.evictions++;
  }

  /**
   * Evict entries to free memory
   */
  private async evictByMemory(): Promise<void> {
    if (this.config.maxMemoryMb === undefined) {
      throw new Error('maxMemoryMb should be defined for memory eviction');
    }
    const maxMemoryBytes = this.config.maxMemoryMb * 1024 * 1024;

    while (this.getMemoryUsage() > maxMemoryBytes && this.tail) {
      await this.evictLRU();
    }
  }

  /**
   * Estimate memory usage in bytes
   */
  private getMemoryUsage(): number {
    let total = 0;

    for (const [key, entry] of this.entries.entries()) {
      // Rough estimation of memory usage
      total += key.length * 2; // UTF-16 string
      total += this.estimateValueSize(entry.value);
      total += 64; // Overhead for entry object and references
    }

    return total;
  }

  /**
   * Estimate the size of a value in bytes
   */
  private estimateValueSize(value: unknown): number {
    if (value === null || value === undefined) {
      return 8;
    }

    if (typeof value === 'string') {
      return value.length * 2; // UTF-16
    }

    if (typeof value === 'number') {
      return 8; // 64-bit number
    }

    if (typeof value === 'boolean') {
      return 4; // 32-bit boolean
    }

    if (typeof value === 'object') {
      try {
        return JSON.stringify(value).length * 2; // Rough estimation
      } catch {
        return 100; // Fallback estimate for complex objects
      }
    }

    return 50; // Default estimate for unknown types
  }

  /**
   * Get keys matching a prefix (more efficient than getKeys() + filter)
   */
  async getKeysByPrefix(prefix: string): Promise<string[]> {
    const matchingKeys: string[] = [];

    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        matchingKeys.push(key);
      }
    }

    return matchingKeys;
  }

  /**
   * Delete all keys matching a prefix
   */
  async deleteByPrefix(prefix: string): Promise<number> {
    let deletedCount = 0;
    const keysToDelete: string[] = [];

    // First, collect all matching keys
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }

    // Then delete them
    for (const key of keysToDelete) {
      if (await this.delete(key)) {
        deletedCount++;
      }
    }

    return deletedCount;
  }

  /**
   * Get cache keys for debugging/testing
   */
  getKeys(): string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * Get cache size
   */
  size(): number {
    return this.entries.size;
  }

  /**
   * Check if cache is at capacity
   */
  isFull(): boolean {
    return this.entries.size >= this.config.maxSize;
  }
}
