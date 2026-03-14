/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: GCP Workflows uses ${...} syntax, not JS templates */

/**
 * Expression evaluator tests — written BEFORE implementation (TDD)
 *
 * Tests the GCP Workflows ${...} expression language:
 * - Variable references
 * - Property/bracket/index access
 * - Arithmetic, comparison, logical operators
 * - String concatenation
 * - Function calls
 * - Type system (strict, no implicit coercion)
 * - `in` operator for map key existence
 * - `if()` built-in function
 */

import { describe, expect, test } from 'bun:test';
import { evaluateExpression, evaluateTemplate } from './expressions.ts';
import type { VariableScope } from './types.ts';
import { WorkflowRuntimeError } from './types.ts';

// Stub stdlib resolver that just returns the function name for testing expressions
// The actual stdlib is tested separately
const noopStdlib = () => {
  throw new Error('stdlib not configured');
};

function makeScope(vars: Record<string, unknown>): VariableScope {
  return { variables: vars };
}

describe('Expression Evaluator', () => {
  // ── Literals ──

  describe('literals', () => {
    test('evaluates integer literals', () => {
      expect(evaluateExpression('42', makeScope({}), noopStdlib)).toBe(42);
    });

    test('evaluates negative integer literals', () => {
      expect(evaluateExpression('-5', makeScope({}), noopStdlib)).toBe(-5);
    });

    test('evaluates double literals', () => {
      expect(evaluateExpression('3.14', makeScope({}), noopStdlib)).toBe(3.14);
    });

    test('evaluates string literals with double quotes', () => {
      expect(evaluateExpression('"hello"', makeScope({}), noopStdlib)).toBe('hello');
    });

    test('evaluates string literals with single quotes', () => {
      expect(evaluateExpression("'world'", makeScope({}), noopStdlib)).toBe('world');
    });

    test('evaluates boolean true (all case variants)', () => {
      expect(evaluateExpression('true', makeScope({}), noopStdlib)).toBe(true);
      expect(evaluateExpression('True', makeScope({}), noopStdlib)).toBe(true);
      expect(evaluateExpression('TRUE', makeScope({}), noopStdlib)).toBe(true);
    });

    test('evaluates boolean false (all case variants)', () => {
      expect(evaluateExpression('false', makeScope({}), noopStdlib)).toBe(false);
      expect(evaluateExpression('False', makeScope({}), noopStdlib)).toBe(false);
      expect(evaluateExpression('FALSE', makeScope({}), noopStdlib)).toBe(false);
    });

    test('evaluates null literal', () => {
      expect(evaluateExpression('null', makeScope({}), noopStdlib)).toBeNull();
    });
  });

  // ── Variable References ──

  describe('variable references', () => {
    test('resolves a simple variable', () => {
      expect(evaluateExpression('x', makeScope({ x: 10 }), noopStdlib)).toBe(10);
    });

    test('resolves a string variable', () => {
      expect(evaluateExpression('name', makeScope({ name: 'Alice' }), noopStdlib)).toBe('Alice');
    });

    test('throws on undefined variable', () => {
      expect(() => evaluateExpression('missing', makeScope({}), noopStdlib)).toThrow();
    });
  });

  // ── Property Access ──

  describe('property access', () => {
    test('resolves dot notation', () => {
      const scope = makeScope({ order: { id: 'ORD-1', total: 99.5 } });
      expect(evaluateExpression('order.id', scope, noopStdlib)).toBe('ORD-1');
      expect(evaluateExpression('order.total', scope, noopStdlib)).toBe(99.5);
    });

    test('resolves nested dot notation', () => {
      const scope = makeScope({ a: { b: { c: 42 } } });
      expect(evaluateExpression('a.b.c', scope, noopStdlib)).toBe(42);
    });

    test('resolves bracket notation with string', () => {
      const scope = makeScope({ obj: { key: 'value' } });
      expect(evaluateExpression('obj["key"]', scope, noopStdlib)).toBe('value');
    });

    test('resolves array indexing', () => {
      const scope = makeScope({ arr: [10, 20, 30] });
      expect(evaluateExpression('arr[0]', scope, noopStdlib)).toBe(10);
      expect(evaluateExpression('arr[2]', scope, noopStdlib)).toBe(30);
    });

    test('raises IndexError on out-of-bounds array access', () => {
      const scope = makeScope({ arr: [1, 2] });

      expect(() => evaluateExpression('arr[5]', scope, noopStdlib)).toThrow(WorkflowRuntimeError);
    });

    test('raises KeyError on missing map key', () => {
      const scope = makeScope({ obj: { a: 1 } });

      expect(() => evaluateExpression('obj["missing"]', scope, noopStdlib)).toThrow(
        WorkflowRuntimeError
      );
    });
  });

  // ── Arithmetic Operators ──

  describe('arithmetic', () => {
    test('addition', () => {
      expect(evaluateExpression('2 + 3', makeScope({}), noopStdlib)).toBe(5);
    });

    test('subtraction', () => {
      expect(evaluateExpression('10 - 4', makeScope({}), noopStdlib)).toBe(6);
    });

    test('multiplication', () => {
      expect(evaluateExpression('3 * 7', makeScope({}), noopStdlib)).toBe(21);
    });

    test('division yields double (5/2 = 2.5)', () => {
      expect(evaluateExpression('5 / 2', makeScope({}), noopStdlib)).toBe(2.5);
    });

    test('modulo', () => {
      expect(evaluateExpression('7 % 3', makeScope({}), noopStdlib)).toBe(1);
    });

    test('raises ZeroDivisionError on division by zero', () => {
      expect(() => evaluateExpression('5 / 0', makeScope({}), noopStdlib)).toThrow(
        WorkflowRuntimeError
      );
    });

    test('operator precedence: multiplication before addition', () => {
      expect(evaluateExpression('2 + 3 * 4', makeScope({}), noopStdlib)).toBe(14);
    });

    test('parentheses override precedence', () => {
      expect(evaluateExpression('(2 + 3) * 4', makeScope({}), noopStdlib)).toBe(20);
    });

    test('arithmetic with variables', () => {
      const scope = makeScope({ x: 10, y: 3 });
      expect(evaluateExpression('x + y', scope, noopStdlib)).toBe(13);
      expect(evaluateExpression('x * y - 1', scope, noopStdlib)).toBe(29);
    });
  });

  // ── String Concatenation ──

  describe('string concatenation', () => {
    test('concatenates two strings with +', () => {
      expect(evaluateExpression('"hello" + " world"', makeScope({}), noopStdlib)).toBe(
        'hello world'
      );
    });

    test('raises TypeError when concatenating string + non-string', () => {
      expect(() => evaluateExpression('"count: " + 5', makeScope({}), noopStdlib)).toThrow(
        WorkflowRuntimeError
      );
    });
  });

  // ── Comparison Operators ──

  describe('comparison', () => {
    test('equality', () => {
      expect(evaluateExpression('1 == 1', makeScope({}), noopStdlib)).toBe(true);
      expect(evaluateExpression('1 == 2', makeScope({}), noopStdlib)).toBe(false);
    });

    test('inequality', () => {
      expect(evaluateExpression('1 != 2', makeScope({}), noopStdlib)).toBe(true);
      expect(evaluateExpression('1 != 1', makeScope({}), noopStdlib)).toBe(false);
    });

    test('greater than', () => {
      expect(evaluateExpression('5 > 3', makeScope({}), noopStdlib)).toBe(true);
      expect(evaluateExpression('3 > 5', makeScope({}), noopStdlib)).toBe(false);
    });

    test('less than', () => {
      expect(evaluateExpression('3 < 5', makeScope({}), noopStdlib)).toBe(true);
    });

    test('greater or equal', () => {
      expect(evaluateExpression('5 >= 5', makeScope({}), noopStdlib)).toBe(true);
      expect(evaluateExpression('5 >= 6', makeScope({}), noopStdlib)).toBe(false);
    });

    test('less or equal', () => {
      expect(evaluateExpression('3 <= 3', makeScope({}), noopStdlib)).toBe(true);
    });

    test('string comparison', () => {
      expect(evaluateExpression('"abc" == "abc"', makeScope({}), noopStdlib)).toBe(true);
      expect(evaluateExpression('"abc" != "def"', makeScope({}), noopStdlib)).toBe(true);
    });

    test('null == null is true', () => {
      expect(evaluateExpression('null == null', makeScope({}), noopStdlib)).toBe(true);
    });

    test('raises TypeError comparing different types', () => {
      expect(() => evaluateExpression('1 == "1"', makeScope({}), noopStdlib)).toThrow(
        WorkflowRuntimeError
      );

      expect(() => evaluateExpression('null == 0', makeScope({}), noopStdlib)).toThrow(
        WorkflowRuntimeError
      );
    });
  });

  // ── Logical Operators ──

  describe('logical operators', () => {
    test('and operator', () => {
      expect(evaluateExpression('true and true', makeScope({}), noopStdlib)).toBe(true);
      expect(evaluateExpression('true and false', makeScope({}), noopStdlib)).toBe(false);
    });

    test('or operator', () => {
      expect(evaluateExpression('false or true', makeScope({}), noopStdlib)).toBe(true);
      expect(evaluateExpression('false or false', makeScope({}), noopStdlib)).toBe(false);
    });

    test('not operator', () => {
      expect(evaluateExpression('not true', makeScope({}), noopStdlib)).toBe(false);
      expect(evaluateExpression('not false', makeScope({}), noopStdlib)).toBe(true);
    });

    test('combined logical operators', () => {
      expect(evaluateExpression('true and not false', makeScope({}), noopStdlib)).toBe(true);
      expect(evaluateExpression('false or true and true', makeScope({}), noopStdlib)).toBe(true);
    });

    test('no short-circuit: both sides evaluated', () => {
      // Both sides are evaluated even if left side determines result
      // We can't easily test side effects here, but we can test that
      // errors on the right side ARE raised (no short circuit)
      const scope = makeScope({ x: true });

      expect(() => evaluateExpression('x or (1 / 0 == 0)', scope, noopStdlib)).toThrow(
        WorkflowRuntimeError
      );
    });
  });

  // ── `in` Operator ──

  describe('in operator', () => {
    test('key exists in map', () => {
      const scope = makeScope({ myMap: { name: 'test', count: 5 } });
      expect(evaluateExpression('"name" in myMap', scope, noopStdlib)).toBe(true);
    });

    test('key does not exist in map', () => {
      const scope = makeScope({ myMap: { name: 'test' } });
      expect(evaluateExpression('"missing" in myMap', scope, noopStdlib)).toBe(false);
    });

    test('element exists in list', () => {
      const scope = makeScope({ tags: ['a', 'b', 'c'] });
      expect(evaluateExpression('"b" in tags', scope, noopStdlib)).toBe(true);
      expect(evaluateExpression('"z" in tags', scope, noopStdlib)).toBe(false);
    });
  });

  // ── Function Calls ──

  describe('function calls', () => {
    const mockStdlib = (name: string, args: unknown[]) => {
      if (name === 'len') return (args[0] as unknown[]).length;
      if (name === 'string') return String(args[0]);
      if (name === 'int') return Math.floor(args[0] as number);
      if (name === 'default') return args[0] ?? args[1];
      if (name === 'map.get') {
        const map = args[0] as Record<string, unknown>;
        const key = args[1] as string;

        return key in map ? map[key] : args[2];
      }
      if (name === 'if') return args[0] ? args[1] : args[2];

      throw new Error(`Unknown function: ${name}`);
    };

    test('calls built-in function with arguments', () => {
      const scope = makeScope({ arr: [1, 2, 3] });
      expect(evaluateExpression('len(arr)', scope, mockStdlib)).toBe(3);
    });

    test('calls namespaced function', () => {
      const scope = makeScope({ obj: { a: 1 } });
      expect(evaluateExpression('map.get(obj, "a")', scope, mockStdlib)).toBe(1);
    });

    test('calls function with default value', () => {
      const scope = makeScope({ val: null });
      expect(evaluateExpression('default(val, "fallback")', scope, mockStdlib)).toBe('fallback');
    });

    test('calls if() function', () => {
      expect(evaluateExpression('if(true, "yes", "no")', makeScope({}), mockStdlib)).toBe('yes');
      expect(evaluateExpression('if(false, "yes", "no")', makeScope({}), mockStdlib)).toBe('no');
    });

    test('calls string() conversion', () => {
      expect(evaluateExpression('string(42)', makeScope({}), mockStdlib)).toBe('42');
    });

    test('nested function calls', () => {
      const scope = makeScope({ obj: { a: null } });
      expect(evaluateExpression('string(default(obj.a, 0))', scope, mockStdlib)).toBe('0');
    });
  });

  // ── Template Evaluation ──

  describe('evaluateTemplate', () => {
    test('returns plain string as-is', () => {
      expect(evaluateTemplate('hello world', makeScope({}), noopStdlib)).toBe('hello world');
    });

    test('evaluates ${...} expression in string', () => {
      const scope = makeScope({ name: 'Alice' });
      expect(evaluateTemplate('${name}', scope, noopStdlib)).toBe('Alice');
    });

    test('evaluates pure expression (returns non-string types)', () => {
      expect(evaluateTemplate('${42}', makeScope({}), noopStdlib)).toBe(42);
      expect(evaluateTemplate('${true}', makeScope({}), noopStdlib)).toBe(true);
      expect(evaluateTemplate('${null}', makeScope({}), noopStdlib)).toBeNull();
    });

    test('evaluates complex expression', () => {
      const scope = makeScope({ x: 10, y: 5 });
      expect(evaluateTemplate('${x + y}', scope, noopStdlib)).toBe(15);
    });

    test('returns non-expression values as-is', () => {
      expect(evaluateTemplate(42, makeScope({}), noopStdlib)).toBe(42);
      expect(evaluateTemplate(true, makeScope({}), noopStdlib)).toBe(true);
      expect(evaluateTemplate(null, makeScope({}), noopStdlib)).toBeNull();
    });

    test('$$ produces literal $', () => {
      expect(evaluateTemplate('price: $$5', makeScope({}), noopStdlib)).toBe('price: $5');
    });
  });
});
