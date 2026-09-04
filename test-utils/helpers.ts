/**
 * Test helper utilities
 */

import type { Config, Operation, QueryConditions, StorageProvider } from '@/shared/types/index.ts';

/**
 * Create a test configuration with defaults
 * Uses dynamic port allocation to avoid conflicts
 */
export async function createTestConfig(overrides: Partial<Config> = {}): Promise<Config> {
  const ports = await getAvailablePorts(2);
  if (ports.length < 2) {
    throw new Error('Failed to allocate required ports');
  }
  const [httpPort, grpcPort] = ports;

  if (httpPort == null || grpcPort == null) {
    throw new Error('Failed to allocate required ports');
  }

  return {
    server: {
      httpPort,
      grpcPort,
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
  private storage = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    return (this.storage.get(key) as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    // TTL is ignored in the mock provider
    this.storage.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.storage.delete(key);
  }

  async query<T>(table: string, _conditions: QueryConditions): Promise<T[]> {
    // Simple mock implementation
    const results: T[] = [];

    for (const [key, value] of this.storage.entries()) {
      if (key.startsWith(`${table}:`)) {
        results.push(value as T);
      }
    }

    return results;
  }

  async transaction<T>(operations: Operation[]): Promise<T> {
    // Simple mock transaction - execute operations sequentially
    let result: unknown;

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

    return result as T;
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
  body?: unknown,
  headers: Record<string, string> = {}
): Request {
  const requestInit: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };

  if (body) {
    requestInit.body = JSON.stringify(body);
  }

  return new Request(url, requestInit);
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
 * Find an available port using Node.js net module
 * Returns a promise that resolves to an available port number
 */
export async function getAvailablePort(): Promise<number> {
  const net = await import('node:net');

  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to get server address')));
      }
    });

    server.on('error', err => {
      reject(err);
    });
  });
}

/**
 * Get multiple available ports at once
 */
export async function getAvailablePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i++) {
    ports.push(await getAvailablePort());
  }
  return ports;
}

/**
 * Assert that a promise rejects with specific error
 */
export async function expectToThrow(
  fn: () => Promise<unknown>,
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
