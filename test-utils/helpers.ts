/**
 * Test helper utilities
 */

import { createServer, type Server } from 'node:net';
import { type Config, ConfigSchema } from '@/config/schema.ts';
import type { Operation, QueryConditions, StorageProvider } from '@/shared/types/index.ts';

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

  return ConfigSchema.parse({
    server: {
      httpPort,
      grpcPort,
      maxConnections: 10,
    },
    storage: {
      type: 'memory',
    },
    auth: {
      enabled: false,
      mode: 'bypass',
    },
    // Every service key is required by the schema and defaults to enabled, so
    // the empty literals are enough to get a full, valid services block.
    services: {
      alloydb: {},
      cloudsql: {},
      compute: {},
      kms: {},
      memorystore: {},
      pubsub: {},
      scheduler: {},
      secrets: {},
      storage: {},
      tasks: {},
      workflows: {},
    },
    logging: {
      level: 'error',
      format: 'json',
    },
    ...overrides,
  });
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
 * Bind `port` and resolve with the bound number. The server is pushed onto
 * `held` so the caller can keep every reservation until the full set is known.
 */
function listenAndHold(held: Server[], port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.listen(port, () => {
      const address = server.address();

      if (address && typeof address === 'object') {
        held.push(server);

        resolve(address.port);

        return;
      }

      server.close(() => reject(new Error('Failed to get server address')));
    });

    server.on('error', err => {
      reject(err);
    });
  });
}

async function closeHeld(held: readonly Server[]): Promise<void> {
  await Promise.all(
    held.map(
      server =>
        new Promise<void>(resolve => {
          server.close(() => resolve());
        })
    )
  );
}

/**
 * Find an available port using Node.js net module.
 * Returns a promise that resolves to an available port number.
 */
export async function getAvailablePort(): Promise<number> {
  const [port] = await getAvailablePorts(1);

  if (port == null) {
    throw new Error('Failed to allocate a port');
  }

  return port;
}

/**
 * Claim `count` distinct ephemeral ports by holding every reservation until
 * the set is complete, then releasing.
 *
 * Binding `port: 0` twice in sequence (bind, close, bind again) can return
 * the same number: the first port is free before the second claim. A mutex
 * does not fix that. `reserved` ports that are still free are held during
 * allocation so the OS will not hand them out as port 0.
 */
export async function getAvailablePorts(
  count: number,
  reserved: readonly number[] = []
): Promise<number[]> {
  if (count < 1) {
    throw new Error('count must be at least 1');
  }

  const held: Server[] = [];

  try {
    for (const port of reserved) {
      try {
        await listenAndHold(held, port);
      } catch {
        // Already bound elsewhere, so the OS will not hand it out as port 0.
      }
    }

    const ports: number[] = [];

    for (let i = 0; i < count; i++) {
      ports.push(await listenAndHold(held, 0));
    }

    if (new Set(ports).size !== ports.length) {
      throw new Error(`port allocator returned duplicates: ${ports.join(', ')}`);
    }

    if (ports.some(port => reserved.includes(port))) {
      throw new Error(
        `port allocator reused a reserved port: ${ports.join(', ')} vs ${reserved.join(', ')}`
      );
    }

    return ports;
  } finally {
    await closeHeld(held);
  }
}

/**
 * Resolve two listener ports that must not collide. Explicit values are kept
 * as-is (and rejected when equal); missing values are filled from
 * {@link getAvailablePorts} while any already-chosen port is held.
 */
export async function allocateDistinctPorts(explicit: {
  first?: number | undefined;
  second?: number | undefined;
}): Promise<{ first: number; second: number }> {
  const { first: explicitFirst, second: explicitSecond } = explicit;

  if (explicitFirst != null && explicitSecond != null) {
    if (explicitFirst === explicitSecond) {
      throw new Error(
        `ports must differ (both are ${explicitFirst}) so a second listener can bind`
      );
    }

    return { first: explicitFirst, second: explicitSecond };
  }

  if (explicitFirst != null) {
    const [second] = await getAvailablePorts(1, [explicitFirst]);

    if (second == null) {
      throw new Error('Failed to allocate a distinct port');
    }

    return { first: explicitFirst, second };
  }

  if (explicitSecond != null) {
    const [first] = await getAvailablePorts(1, [explicitSecond]);

    if (first == null) {
      throw new Error('Failed to allocate a distinct port');
    }

    return { first, second: explicitSecond };
  }

  const [first, second] = await getAvailablePorts(2);

  if (first == null || second == null) {
    throw new Error('Failed to allocate distinct ports');
  }

  return { first, second };
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
