/**
 * Test helper utilities
 */

import type { Config, StorageProvider } from '@/shared/types/index.ts';

/**
 * Create a test configuration with defaults
 */
export function createTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    server: {
      httpPort: 9000,
      grpcPort: 9001,
      maxConnections: 10,
    },
    storage: {
      type: 'memory',
      cacheSize: 1048576, // 1MB
    },
    auth: {
      enabled: false,
      mode: 'bypass',
    },
    services: {
      pubsub: { enabled: true },
      scheduler: { enabled: true },
      tasks: { enabled: true },
      secrets: { enabled: true },
    },
    logging: {
      level: 'error',
      format: 'json',
    },
    ...overrides,
  };
}

/**
 * Mock storage provider for testing
 */
export class MockStorageProvider implements StorageProvider {
  private storage: Map<string, any> = new Map();

  async get<T>(key: string): Promise<T | null> {
    return this.storage.get(key) || null;
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    this.storage.set(key, value);
    // For testing, we ignore TTL
  }

  async delete(key: string): Promise<boolean> {
    return this.storage.delete(key);
  }

  async query<T>(table: string, conditions: any): Promise<T[]> {
    // Simple mock implementation
    const results: T[] = [];
    for (const [key, value] of this.storage.entries()) {
      if (key.startsWith(`${table}:`)) {
        results.push(value);
      }
    }
    return results;
  }

  async transaction<T>(operations: any[]): Promise<T> {
    // Simple mock transaction - execute operations sequentially
    let result: any;
    for (const op of operations) {
      switch (op.type) {
        case 'get':
          result = await this.get(op.key);
          break;
        case 'set':
          await this.set(op.key, op.value);
          result = op.value;
          break;
        case 'delete':
          result = await this.delete(op.key);
          break;
      }
    }
    return result;
  }

  clear(): void {
    this.storage.clear();
  }
}

/**
 * Create a test HTTP request
 */
export function createTestRequest(
  method: string = 'GET',
  url: string = 'http://localhost:9000/',
  body?: any,
  headers: Record<string, string> = {}
): Request {
  return new Request(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

/**
 * Wait for a specified amount of time (useful for async testing)
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate a random test ID
 */
export function generateTestId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).substring(2)}`;
}

/**
 * Assert that a promise rejects with specific error
 */
export async function expectToThrow(
  fn: () => Promise<any>,
  expectedError?: string
): Promise<Error> {
  try {
    await fn();
    throw new Error('Expected function to throw but it did not');
  } catch (error) {
    // Handle both Error objects and non-Error values that might be thrown
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (expectedError && errorMessage !== expectedError) {
      throw new Error(`Expected error message "${expectedError}" but got "${errorMessage}"`);
    }

    // If it's not an Error object, wrap it in one for consistency
    return error instanceof Error ? error : new Error(String(error));
  }
}
