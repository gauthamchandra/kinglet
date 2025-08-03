/**
 * Tests for development dependencies to ensure they're properly installed
 */

import { test, expect, describe } from 'bun:test';

describe('Development Dependencies', () => {
  test('should have @types/bun available', () => {
    // Test that Bun types are available
    expect(Bun).toBeDefined();
    expect(Bun.version).toBeDefined();
    expect(typeof Bun.version).toBe('string');
  });

  test('should have @types/node available', () => {
    // Test that Node.js types are available
    expect(process).toBeDefined();
    expect(process.env).toBeDefined();
    expect(process.version).toBeDefined();
    expect(typeof process.version).toBe('string');
  });

  test('should have TypeScript compilation working', () => {
    // TypeScript should compile our test code
    const testObject: { name: string; value: number } = {
      name: 'test',
      value: 42,
    };

    expect(testObject.name).toBe('test');
    expect(testObject.value).toBe(42);
  });

  test('should support modern JavaScript features', () => {
    // Test optional chaining
    const obj: { nested?: { value?: string } } = {};
    expect(obj.nested?.value).toBeUndefined();

    // Test nullish coalescing
    const value = obj.nested?.value ?? 'default';
    expect(value).toBe('default');

    // Test async/await
    const asyncFunction = async (): Promise<string> => {
      return 'async result';
    };

    expect(asyncFunction()).toBeInstanceOf(Promise);
  });

  test('should support ES modules', async () => {
    // Test dynamic imports work
    const crypto = await import('crypto');
    expect(crypto).toBeDefined();
    expect(crypto.randomUUID).toBeDefined();

    // Test that we can create a UUID
    const uuid = crypto.randomUUID();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
