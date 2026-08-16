import { describe, expect, test } from 'bun:test';
import { parseOffsetToken, parsePageSize } from './pagination.ts';

describe('parsePageSize', () => {
  test('returns a positive integer unchanged', () => {
    expect(parsePageSize('25')).toBe(25);
    expect(parsePageSize('1')).toBe(1);
  });

  test('returns undefined for missing, empty, or non-numeric values', () => {
    expect(parsePageSize(undefined)).toBeUndefined();
    expect(parsePageSize(null)).toBeUndefined();
    expect(parsePageSize('')).toBeUndefined();
    expect(parsePageSize('abc')).toBeUndefined();
  });

  test('returns undefined for zero and negative values', () => {
    expect(parsePageSize('0')).toBeUndefined();
    expect(parsePageSize('-5')).toBeUndefined();
  });
});

describe('parseOffsetToken', () => {
  test('parses a non-negative integer offset', () => {
    expect(parseOffsetToken('10')).toBe(10);
    expect(parseOffsetToken('0')).toBe(0);
  });

  test('treats missing, empty, or malformed tokens as offset 0', () => {
    expect(parseOffsetToken(undefined)).toBe(0);
    expect(parseOffsetToken(null)).toBe(0);
    expect(parseOffsetToken('')).toBe(0);
    expect(parseOffsetToken('abc')).toBe(0);
    expect(parseOffsetToken('-3')).toBe(0);
  });
});
