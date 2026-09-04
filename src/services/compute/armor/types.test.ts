import { describe, expect, test } from 'bun:test';
import {
  ArmorError,
  DEFAULT_RULE_PRIORITY,
  MAX_ENFORCE_ON_KEY_CONFIGS,
  MAX_EXPRESSION_CHARS,
  MAX_MATCHES_PER_EXPRESSION,
  MAX_SRC_IP_RANGES,
  MAX_SUBEXPRESSION_CHARS,
  MAX_SUBEXPRESSIONS,
  RATE_LIMIT_KEY_VALUE_MAX_BYTES,
  REQUEST_BODY_INSPECTION_BYTES,
} from './types.ts';

describe('ArmorError', () => {
  test('defaults to INVALID_ARGUMENT with HTTP 400', () => {
    const err = new ArmorError('bad expression');

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ArmorError');
    expect(err.message).toBe('bad expression');
    expect(err.status).toBe('INVALID_ARGUMENT');
    expect(err.code).toBe(400);
  });

  test('accepts an explicit status', () => {
    const err = new ArmorError('cannot downgrade ban', 'FAILED_PRECONDITION', 400);

    expect(err.status).toBe('FAILED_PRECONDITION');
    expect(err.code).toBe(400);
  });
});

describe('evaluation constants', () => {
  test('default rule priority is the Compute API sentinel', () => {
    expect(DEFAULT_RULE_PRIORITY).toBe(2147483647);
  });

  test('write-time expression limits match apply', () => {
    expect(MAX_SUBEXPRESSIONS).toBe(5);
    expect(MAX_SUBEXPRESSION_CHARS).toBe(1024);
    expect(MAX_EXPRESSION_CHARS).toBe(2048);
    expect(MAX_MATCHES_PER_EXPRESSION).toBe(1);
    expect(MAX_SRC_IP_RANGES).toBe(10);
  });

  test('rate-limit key constraints', () => {
    expect(MAX_ENFORCE_ON_KEY_CONFIGS).toBe(3);
    expect(RATE_LIMIT_KEY_VALUE_MAX_BYTES).toBe(128);
  });

  test('body inspection sizes are the documented KB steps', () => {
    expect(REQUEST_BODY_INSPECTION_BYTES['8KB']).toBe(8192);
    expect(REQUEST_BODY_INSPECTION_BYTES['16KB']).toBe(16384);
    expect(REQUEST_BODY_INSPECTION_BYTES['32KB']).toBe(32768);
    expect(REQUEST_BODY_INSPECTION_BYTES['48KB']).toBe(49152);
    expect(REQUEST_BODY_INSPECTION_BYTES['64KB']).toBe(65536);
  });
});
