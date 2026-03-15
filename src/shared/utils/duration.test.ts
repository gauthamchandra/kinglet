import { describe, expect, test } from 'bun:test';
import { parseDurationSeconds } from './duration.ts';

describe('parseDurationSeconds', () => {
  test('parses integer durations', () => {
    expect(parseDurationSeconds('5s')).toBe(5);
    expect(parseDurationSeconds('3600s')).toBe(3600);
    expect(parseDurationSeconds('0s')).toBe(0);
  });

  test('parses fractional durations', () => {
    expect(parseDurationSeconds('0.100s')).toBe(0.1);
    expect(parseDurationSeconds('1.5s')).toBe(1.5);
    expect(parseDurationSeconds('0.5s')).toBe(0.5);
  });

  test('throws on invalid formats', () => {
    expect(() => parseDurationSeconds('')).toThrow('Invalid duration format');
    expect(() => parseDurationSeconds('5')).toThrow('Invalid duration format');
    expect(() => parseDurationSeconds('5m')).toThrow('Invalid duration format');
    expect(() => parseDurationSeconds('abc')).toThrow('Invalid duration format');
  });
});
