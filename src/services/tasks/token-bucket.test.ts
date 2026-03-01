/**
 * Tests for TokenBucket rate limiter
 */

import { test, expect, describe } from 'bun:test';
import { TokenBucket } from './token-bucket.ts';
import type { TokenBucketConfig } from './token-bucket.ts';

describe('TokenBucket', () => {
  const defaultConfig: TokenBucketConfig = {
    maxTokens: 10,
    refillRate: 5,
    maxConcurrent: 3,
  };

  describe('acquire', () => {
    test('should acquire a token when available', () => {
      const bucket = new TokenBucket(defaultConfig);

      const acquired = bucket.acquire();

      expect(acquired).toBe(true);
    });

    test('should decrement tokens on acquire', () => {
      const bucket = new TokenBucket(defaultConfig);

      bucket.acquire();
      const stats = bucket.getStats();

      expect(stats.tokens).toBe(9);
    });

    test('should track concurrent dispatches', () => {
      const bucket = new TokenBucket(defaultConfig);

      bucket.acquire();
      bucket.acquire();

      const stats = bucket.getStats();

      expect(stats.concurrent).toBe(2);
    });

    test('should fail when tokens exhausted', () => {
      const bucket = new TokenBucket({ maxTokens: 2, refillRate: 1, maxConcurrent: 100 });

      bucket.acquire();
      bucket.acquire();
      const third = bucket.acquire();

      expect(third).toBe(false);
    });

    test('should fail when concurrent limit reached', () => {
      const bucket = new TokenBucket({ maxTokens: 100, refillRate: 10, maxConcurrent: 2 });

      bucket.acquire();
      bucket.acquire();
      const third = bucket.acquire();

      expect(third).toBe(false);
    });
  });

  describe('release', () => {
    test('should decrement concurrent count', () => {
      const bucket = new TokenBucket(defaultConfig);

      bucket.acquire();
      bucket.acquire();
      bucket.release();

      const stats = bucket.getStats();

      expect(stats.concurrent).toBe(1);
    });

    test('should not go below zero', () => {
      const bucket = new TokenBucket(defaultConfig);

      bucket.release();

      const stats = bucket.getStats();

      expect(stats.concurrent).toBe(0);
    });

    test('should allow new acquires after release when at concurrency limit', () => {
      const bucket = new TokenBucket({ maxTokens: 100, refillRate: 10, maxConcurrent: 1 });

      bucket.acquire();
      expect(bucket.acquire()).toBe(false);

      bucket.release();
      expect(bucket.acquire()).toBe(true);
    });
  });

  describe('refill', () => {
    test('should add tokens based on refillRate', () => {
      const bucket = new TokenBucket({ maxTokens: 10, refillRate: 5, maxConcurrent: 100 });

      for (let i = 0; i < 10; i++) {
        bucket.acquire();
      }

      expect(bucket.getStats().tokens).toBe(0);

      bucket.refill();

      expect(bucket.getStats().tokens).toBe(5);
    });

    test('should not exceed maxTokens', () => {
      const bucket = new TokenBucket({ maxTokens: 10, refillRate: 100, maxConcurrent: 100 });

      bucket.refill();

      expect(bucket.getStats().tokens).toBe(10);
    });

    test('should refill from empty', () => {
      const bucket = new TokenBucket({ maxTokens: 10, refillRate: 3, maxConcurrent: 100 });

      for (let i = 0; i < 10; i++) {
        bucket.acquire();
      }

      bucket.refill();
      bucket.refill();

      expect(bucket.getStats().tokens).toBe(6);
    });
  });

  describe('updateConfig', () => {
    test('should update configuration', () => {
      const bucket = new TokenBucket(defaultConfig);

      bucket.updateConfig({ maxTokens: 20, refillRate: 10, maxConcurrent: 5 });

      const stats = bucket.getStats();

      expect(stats.config.maxTokens).toBe(20);
      expect(stats.config.refillRate).toBe(10);
      expect(stats.config.maxConcurrent).toBe(5);
    });

    test('should cap tokens to new maxTokens if lower', () => {
      const bucket = new TokenBucket({ maxTokens: 10, refillRate: 5, maxConcurrent: 3 });

      bucket.updateConfig({ maxTokens: 5, refillRate: 5, maxConcurrent: 3 });

      expect(bucket.getStats().tokens).toBe(5);
    });
  });

  describe('getStats', () => {
    test('should return current state', () => {
      const bucket = new TokenBucket(defaultConfig);

      bucket.acquire();

      const stats = bucket.getStats();

      expect(stats.tokens).toBe(9);
      expect(stats.concurrent).toBe(1);
      expect(stats.config).toEqual(defaultConfig);
    });
  });
});
