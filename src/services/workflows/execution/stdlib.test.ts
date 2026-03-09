/**
 * Standard library tests — written BEFORE implementation (TDD)
 *
 * Tests all GCP Workflows standard library modules:
 * sys, json, base64, map, list, text, math, uuid, built-in functions
 * HTTP is tested more lightly here (behavior tested in e2e).
 */

import { describe, expect, test } from 'bun:test';
import { createStdlib } from './stdlib.ts';
import { WorkflowRuntimeError } from './types.ts';

const envVars: Record<string, string> = {
  GOOGLE_CLOUD_PROJECT_ID: 'test-project',
  GOOGLE_CLOUD_LOCATION: 'us-central1',
  GOOGLE_CLOUD_WORKFLOW_ID: 'my-workflow',
  GOOGLE_CLOUD_WORKFLOW_REVISION_ID: '000001-abc',
  GOOGLE_CLOUD_WORKFLOW_EXECUTION_ID: 'exec-123',
  GOOGLE_CLOUD_PROJECT_NUMBER: '123456789',
};

const stdlib = createStdlib({ envVars });

describe('Standard Library', () => {
  // ── Built-in Functions ──

  describe('built-in functions', () => {
    test('default() returns value when non-null', () => {
      expect(stdlib('default', [42, 0])).toBe(42);
      expect(stdlib('default', ['hello', 'fallback'])).toBe('hello');
    });

    test('default() returns fallback when value is null', () => {
      expect(stdlib('default', [null, 'fallback'])).toBe('fallback');
    });

    test('string() converts values to string', () => {
      expect(stdlib('string', [42])).toBe('42');
      expect(stdlib('string', [3.14])).toBe('3.14');
      expect(stdlib('string', [true])).toBe('true');
      expect(stdlib('string', [null])).toBe('null');
    });

    test('int() converts to integer', () => {
      expect(stdlib('int', [3.7])).toBe(3);
      expect(stdlib('int', ['42'])).toBe(42);
    });

    test('int() raises ValueError on invalid input', () => {
      expect(() => stdlib('int', ['abc'])).toThrow(WorkflowRuntimeError);
    });

    test('double() converts to double', () => {
      expect(stdlib('double', [42])).toBe(42.0);
      expect(stdlib('double', ['3.14'])).toBe(3.14);
    });

    test('double() raises ValueError on invalid input', () => {
      expect(() => stdlib('double', ['abc'])).toThrow(WorkflowRuntimeError);
    });

    test('len() returns length of list', () => {
      expect(stdlib('len', [[1, 2, 3]])).toBe(3);
      expect(stdlib('len', [[]])).toBe(0);
    });

    test('len() returns length of string', () => {
      expect(stdlib('len', ['hello'])).toBe(5);
    });

    test('len() returns count of map keys', () => {
      expect(stdlib('len', [{ a: 1, b: 2 }])).toBe(2);
    });

    test('keys() returns map keys', () => {
      const result = stdlib('keys', [{ b: 2, a: 1 }]) as string[];
      expect(result).toContain('a');
      expect(result).toContain('b');
      expect(result).toHaveLength(2);
    });

    test('if() returns trueVal when condition is true', () => {
      expect(stdlib('if', [true, 'yes', 'no'])).toBe('yes');
    });

    test('if() returns falseVal when condition is false', () => {
      expect(stdlib('if', [false, 'yes', 'no'])).toBe('no');
    });
  });

  // ── sys module ──

  describe('sys', () => {
    test('sys.get_env returns environment variable', () => {
      expect(stdlib('sys.get_env', ['GOOGLE_CLOUD_PROJECT_ID'])).toBe('test-project');
      expect(stdlib('sys.get_env', ['GOOGLE_CLOUD_LOCATION'])).toBe('us-central1');
    });

    test('sys.get_env raises KeyError for unknown variable', () => {
      expect(() => stdlib('sys.get_env', ['UNKNOWN_VAR'])).toThrow(WorkflowRuntimeError);
    });

    test('sys.log does not throw', () => {
      expect(() => stdlib('sys.log', ['INFO', 'test message'])).not.toThrow();
      expect(() => stdlib('sys.log', ['ERROR', { detail: 'bad' }])).not.toThrow();
    });

    test('sys.now returns a number (epoch seconds)', () => {
      const result = stdlib('sys.now', []);
      expect(typeof result).toBe('number');
      expect(result as number).toBeGreaterThan(0);
    });

    test('sys.sleep resolves (no-op in emulator)', () => {
      expect(() => stdlib('sys.sleep', [1])).not.toThrow();
    });
  });

  // ── json module ──

  describe('json', () => {
    test('json.encode_to_string serializes to JSON string', () => {
      expect(stdlib('json.encode_to_string', [{ a: 1 }])).toBe('{"a":1}');
      expect(stdlib('json.encode_to_string', [[1, 2]])).toBe('[1,2]');
      expect(stdlib('json.encode_to_string', ['hello'])).toBe('"hello"');
    });

    test('json.decode parses JSON string', () => {
      expect(stdlib('json.decode', ['{"a":1}'])).toEqual({ a: 1 });
      expect(stdlib('json.decode', ['[1,2,3]'])).toEqual([1, 2, 3]);
    });

    test('json.decode raises ValueError on invalid JSON', () => {
      expect(() => stdlib('json.decode', ['not json'])).toThrow(WorkflowRuntimeError);
    });

    test('json.encode converts value to JSON-compatible form', () => {
      expect(stdlib('json.encode', [{ a: 1 }])).toEqual({ a: 1 });
    });
  });

  // ── base64 module ──

  describe('base64', () => {
    test('base64.encode encodes string to base64', () => {
      expect(stdlib('base64.encode', ['hello'])).toBe(btoa('hello'));
    });

    test('base64.decode decodes base64 to string', () => {
      expect(stdlib('base64.decode', [btoa('hello')])).toBe('hello');
    });
  });

  // ── map module ──

  describe('map', () => {
    test('map.get retrieves value by key', () => {
      expect(stdlib('map.get', [{ a: 1 }, 'a'])).toBe(1);
    });

    test('map.get returns default when key is missing', () => {
      expect(stdlib('map.get', [{ a: 1 }, 'b', 'default'])).toBe('default');
    });

    test('map.get raises KeyError when key is missing and no default', () => {
      expect(() => stdlib('map.get', [{ a: 1 }, 'b'])).toThrow(WorkflowRuntimeError);
    });

    test('map.get with dot-path retrieves nested value', () => {
      const obj = { a: { b: { c: 42 } } };
      expect(stdlib('map.get', [obj, 'a.b.c'])).toBe(42);
    });

    test('map.merge combines two maps (second wins)', () => {
      const result = stdlib('map.merge', [
        { a: 1, b: 2 },
        { b: 3, c: 4 },
      ]);
      expect(result).toEqual({ a: 1, b: 3, c: 4 });
    });

    test('map.merge_nested deep-merges maps', () => {
      const result = stdlib('map.merge_nested', [
        { a: { x: 1 }, b: 2 },
        { a: { y: 2 }, c: 3 },
      ]);
      expect(result).toEqual({ a: { x: 1, y: 2 }, b: 2, c: 3 });
    });

    test('map.keys returns list of keys', () => {
      const result = stdlib('map.keys', [{ a: 1, b: 2 }]) as string[];
      expect(result).toContain('a');
      expect(result).toContain('b');
    });

    test('map.values returns list of values', () => {
      const result = stdlib('map.values', [{ a: 1, b: 2 }]) as number[];
      expect(result).toContain(1);
      expect(result).toContain(2);
    });
  });

  // ── list module ──

  describe('list', () => {
    test('list.concat appends item to list (immutable)', () => {
      const original = [1, 2];
      const result = stdlib('list.concat', [original, 3]);
      expect(result).toEqual([1, 2, 3]);
      expect(original).toEqual([1, 2]); // original unchanged (immutable)
    });

    test('list.concat concatenates two lists', () => {
      expect(
        stdlib('list.concat', [
          [1, 2],
          [3, 4],
        ])
      ).toEqual([1, 2, 3, 4]);
    });

    test('list.prepend adds item to front (immutable)', () => {
      const original = [2, 3];
      const result = stdlib('list.prepend', [original, 1]);
      expect(result).toEqual([1, 2, 3]);
      expect(original).toEqual([2, 3]);
    });

    test('list.range generates a range of integers', () => {
      expect(stdlib('list.range', [0, 5])).toEqual([0, 1, 2, 3, 4]);
      expect(stdlib('list.range', [3, 7])).toEqual([3, 4, 5, 6]);
    });
  });

  // ── text module ──

  describe('text', () => {
    test('text.to_lower converts to lowercase', () => {
      expect(stdlib('text.to_lower', ['HELLO'])).toBe('hello');
    });

    test('text.to_upper converts to uppercase', () => {
      expect(stdlib('text.to_upper', ['hello'])).toBe('HELLO');
    });

    test('text.find_all returns all match indices', () => {
      expect(stdlib('text.find_all', ['abcabc', 'bc'])).toEqual([1, 4]);
    });

    test('text.find_all returns empty list for no matches', () => {
      expect(stdlib('text.find_all', ['hello', 'xyz'])).toEqual([]);
    });

    test('text.replace_all replaces all occurrences', () => {
      expect(stdlib('text.replace_all', ['aabbaa', 'aa', 'cc'])).toBe('ccbbcc');
    });

    test('text.split splits string by delimiter', () => {
      expect(stdlib('text.split', ['a,b,c', ','])).toEqual(['a', 'b', 'c']);
    });

    test('text.substring extracts substring', () => {
      expect(stdlib('text.substring', ['hello world', 6, 11])).toBe('world');
    });

    test('text.url_encode encodes string for URLs', () => {
      expect(stdlib('text.url_encode', ['hello world'])).toBe('hello%20world');
    });
  });

  // ── math module ──

  describe('math', () => {
    test('math.abs returns absolute value', () => {
      expect(stdlib('math.abs', [-5])).toBe(5);
      expect(stdlib('math.abs', [5])).toBe(5);
    });

    test('math.max returns larger value', () => {
      expect(stdlib('math.max', [3, 7])).toBe(7);
      expect(stdlib('math.max', [10, 2])).toBe(10);
    });

    test('math.min returns smaller value', () => {
      expect(stdlib('math.min', [3, 7])).toBe(3);
      expect(stdlib('math.min', [10, 2])).toBe(2);
    });
  });

  // ── uuid module ──

  describe('uuid', () => {
    test('uuid.generate returns a valid UUID string', () => {
      const result = stdlib('uuid.generate', []) as string;
      expect(typeof result).toBe('string');
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    test('uuid.generate returns unique values', () => {
      const a = stdlib('uuid.generate', []);
      const b = stdlib('uuid.generate', []);
      expect(a).not.toBe(b);
    });
  });

  // ── http module ──

  describe('http', () => {
    test('http.default_retry_predicate returns true for retryable errors', () => {
      const err429 = { tags: ['HttpError'], code: 429, message: 'Too Many Requests' };
      expect(stdlib('http.default_retry_predicate', [err429])).toBe(true);

      const err502 = { tags: ['HttpError'], code: 502, message: 'Bad Gateway' };
      expect(stdlib('http.default_retry_predicate', [err502])).toBe(true);

      const err503 = { tags: ['HttpError'], code: 503, message: 'Unavailable' };
      expect(stdlib('http.default_retry_predicate', [err503])).toBe(true);

      const err504 = { tags: ['HttpError'], code: 504, message: 'Timeout' };
      expect(stdlib('http.default_retry_predicate', [err504])).toBe(true);
    });

    test('http.default_retry_predicate returns true for connection/timeout errors', () => {
      const connErr = { tags: ['ConnectionError'], code: 0, message: 'Connection refused' };
      expect(stdlib('http.default_retry_predicate', [connErr])).toBe(true);

      const timeoutErr = { tags: ['TimeoutError'], code: 0, message: 'Timeout' };
      expect(stdlib('http.default_retry_predicate', [timeoutErr])).toBe(true);
    });

    test('http.default_retry_predicate returns false for non-retryable errors', () => {
      const err400 = { tags: ['HttpError'], code: 400, message: 'Bad Request' };
      expect(stdlib('http.default_retry_predicate', [err400])).toBe(false);

      const err404 = { tags: ['HttpError'], code: 404, message: 'Not Found' };
      expect(stdlib('http.default_retry_predicate', [err404])).toBe(false);
    });
  });

  // ── Unknown function ──

  describe('error handling', () => {
    test('throws on unknown function', () => {
      expect(() => stdlib('nonexistent.function', [])).toThrow(WorkflowRuntimeError);
    });
  });
});
