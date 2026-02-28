/**
 * Tests for CronEngine
 */

import { test, expect, describe } from 'bun:test';
import { CronEngine } from './cron-engine.ts';

describe('CronEngine', () => {
  const engine = new CronEngine();

  describe('validate', () => {
    test('should validate standard cron expressions', () => {
      expect(engine.validate('* * * * *')).toEqual({ valid: true });
      expect(engine.validate('0 9 * * 1-5')).toEqual({ valid: true });
      expect(engine.validate('0 0 1 1 *')).toEqual({ valid: true });
      expect(engine.validate('*/5 * * * *')).toEqual({ valid: true });
      expect(engine.validate('0 0 * * *')).toEqual({ valid: true });
    });

    test('should reject invalid cron expressions', () => {
      const result = engine.validate('invalid');

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('should reject empty expression', () => {
      const result = engine.validate('');

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('getNextRunTime', () => {
    test('should return next minute for every-minute cron', () => {
      const from = new Date('2024-01-15T10:30:00Z');
      const next = engine.getNextRunTime('* * * * *', 'UTC', from);

      expect(next).toBeInstanceOf(Date);
      expect(next.getTime()).toBe(new Date('2024-01-15T10:31:00Z').getTime());
    });

    test('should return next weekday 9am for weekday cron', () => {
      // Jan 15, 2024 is a Monday
      const from = new Date('2024-01-15T09:00:00Z');
      const next = engine.getNextRunTime('0 9 * * 1-5', 'UTC', from);

      expect(next).toBeInstanceOf(Date);
      // Should be Tuesday 9am
      expect(next.getTime()).toBe(new Date('2024-01-16T09:00:00Z').getTime());
    });

    test('should use UTC as default timezone', () => {
      const from = new Date('2024-06-15T12:00:00Z');
      const next1 = engine.getNextRunTime('* * * * *', undefined, from);
      const next2 = engine.getNextRunTime('* * * * *', 'UTC', from);

      expect(next1.getTime()).toBe(next2.getTime());
    });

    test('should handle timezone-aware scheduling', () => {
      const from = new Date('2024-01-15T14:00:00Z'); // 9am EST
      const next = engine.getNextRunTime('0 9 * * *', 'America/New_York', from);

      expect(next).toBeInstanceOf(Date);
      // Next 9am EST = 14:00 UTC the following day
      expect(next.getTime()).toBe(new Date('2024-01-16T14:00:00Z').getTime());
    });

    test('should throw for invalid expression', () => {
      expect(() => engine.getNextRunTime('invalid', 'UTC')).toThrow();
    });
  });

  describe('getPreviousRunTime', () => {
    test('should return previous minute for every-minute cron', () => {
      const from = new Date('2024-01-15T10:30:00Z');
      const prev = engine.getPreviousRunTime('* * * * *', 'UTC', from);

      expect(prev).toBeInstanceOf(Date);
      expect(prev.getTime()).toBe(new Date('2024-01-15T10:29:00Z').getTime());
    });

    test('should throw for invalid expression', () => {
      expect(() => engine.getPreviousRunTime('invalid', 'UTC')).toThrow();
    });
  });

  describe('isDue', () => {
    test('should return true when current time matches cron', () => {
      // Every minute cron at exactly the minute boundary
      const now = new Date('2024-01-15T10:30:00Z');
      const result = engine.isDue('* * * * *', 'UTC', 60000, now);

      expect(result).toBe(true);
    });

    test('should return true within tolerance window', () => {
      // 30 seconds past the minute — still within 60s tolerance
      const now = new Date('2024-01-15T10:30:30Z');
      const result = engine.isDue('* * * * *', 'UTC', 60000, now);

      expect(result).toBe(true);
    });

    test('should return false outside tolerance window', () => {
      // 0 9 * * * means daily at 9am
      // Check at 10am — well outside any reasonable tolerance
      const now = new Date('2024-01-15T10:00:00Z');
      const result = engine.isDue('0 9 * * *', 'UTC', 60000, now);

      expect(result).toBe(false);
    });
  });
});
