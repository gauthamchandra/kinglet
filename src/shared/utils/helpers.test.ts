/**
 * Tests for test helper utilities
 */

import { test, expect, describe } from 'bun:test';
import {
  createTestConfig,
  MockStorageProvider,
  createTestRequest,
  delay,
  generateTestId,
  expectToThrow,
} from '../../../test-utils/helpers';

describe('Test Helpers', () => {
  describe('createTestConfig', () => {
    test('should create default test configuration', async () => {
      const config = await createTestConfig();

      expect(typeof config.server.httpPort).toBe('number');
      expect(typeof config.server.grpcPort).toBe('number');
      expect(config.server.httpPort).toBeGreaterThan(0);
      expect(config.server.grpcPort).toBeGreaterThan(0);
      expect(config.storage.type).toBe('memory');
      expect(config.auth.enabled).toBe(false);
      expect(config.logging.level).toBe('error');
    });

    test('should apply overrides to default configuration', async () => {
      const config = await createTestConfig({
        server: { httpPort: 8080, grpcPort: 8081, maxConnections: 50 },
        auth: { enabled: true, mode: 'mock' },
      });

      expect(config.server.httpPort).toBe(8080);
      expect(config.server.grpcPort).toBe(8081);
      expect(config.server.maxConnections).toBe(50);
      expect(config.auth.enabled).toBe(true);
      expect(config.auth.mode).toBe('mock');
    });
  });

  describe('MockStorageProvider', () => {
    test('should store and retrieve values', async () => {
      const storage = new MockStorageProvider();

      await storage.set('test-key', { value: 'test-data' });
      const result = await storage.get('test-key');

      expect(result).toEqual({ value: 'test-data' });
    });

    test('should return null for non-existent keys', async () => {
      const storage = new MockStorageProvider();
      const result = await storage.get('non-existent');

      expect(result).toBe(null);
    });

    test('should delete values', async () => {
      const storage = new MockStorageProvider();

      await storage.set('test-key', 'test-value');
      const deleted = await storage.delete('test-key');
      const result = await storage.get('test-key');

      expect(deleted).toBe(true);
      expect(result).toBe(null);
    });

    test('should clear all values', async () => {
      const storage = new MockStorageProvider();

      await storage.set('key1', 'value1');
      await storage.set('key2', 'value2');

      storage.clear();

      expect(await storage.get('key1')).toBe(null);
      expect(await storage.get('key2')).toBe(null);
    });
  });

  describe('createTestRequest', () => {
    test('should create GET request by default', () => {
      const request = createTestRequest();

      expect(request.method).toBe('GET');
      expect(request.url).toBe('http://localhost:9000/');
    });

    test('should create POST request with body', () => {
      const body = { data: 'test' };
      const request = createTestRequest('POST', 'http://localhost:9000/api', body);

      expect(request.method).toBe('POST');
      expect(request.url).toBe('http://localhost:9000/api');
      expect(request.headers.get('Content-Type')).toBe('application/json');
    });
  });

  describe('delay', () => {
    test('should wait for specified time', async () => {
      const start = Date.now();

      await delay(100);
      const end = Date.now();

      // Allow more tolerance for timing variations in concurrent test execution
      expect(end - start).toBeGreaterThanOrEqual(90); // Allow 10ms tolerance below
      expect(end - start).toBeLessThan(300); // Allow more tolerance above
    });
  });

  describe('generateTestId', () => {
    test('should generate unique IDs', () => {
      const id1 = generateTestId();
      const id2 = generateTestId();

      expect(id1).toMatch(/^test-\d+-[a-z0-9]+$/);
      expect(id2).toMatch(/^test-\d+-[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('expectToThrow', () => {
    test('should catch thrown errors', async () => {
      const error = await expectToThrow(async () => {
        throw new Error('Test error');
      });

      expect(error.message).toBe('Test error');
    });

    test('should validate error messages', async () => {
      await expectToThrow(async () => {
        throw new Error('Specific error');
      }, 'Specific error');
    });

    // TODO: Fix this test - there's an edge case with error handling
    // test('should throw if function does not throw', async () => {
    //   // Implementation needs work
    // });
  });
});
