/**
 * Mock Storage Manager utility for tests
 * Provides a complete StorageManager implementation for testing with Bun's mock system
 */

import { mock, spyOn } from 'bun:test';
import type { IStorageManager, StorageStats } from '@/core/storage/interfaces.js';
import type {
  QueryResult,
  BaseRecord,
  QueryOptions,
  TransactionOptions,
  TableSchema,
  StorageOperations,
} from '@/core/storage/types.js';

/**
 * Create a complete mock StorageManager that implements all StorageManager interface methods
 */
export function createMockStorage(): IStorageManager & {
  resetAllMocks(): void;
} {
  const mockStorage: IStorageManager & { resetAllMocks(): void } = {
    initialize: mock(() => Promise.resolve()),
    getProvider: mock(() => null as any),
    getCache: mock(() => null),
    withTransaction: mock(
      async (
        fn: (tx: StorageOperations) => Promise<unknown>,
        options?: TransactionOptions
      ): Promise<unknown> => {
        return await fn(mockStorage);
      }
    ) as <T>(fn: (tx: StorageOperations) => Promise<T>, options?: TransactionOptions) => Promise<T>,
    createTable: mock(() => Promise.resolve()),
    dropTable: mock(() => Promise.resolve()),
    listTables: mock(() => Promise.resolve([])),
    healthCheck: mock(() => Promise.resolve(true)),
    getStats: mock(
      (): Promise<StorageStats> =>
        Promise.resolve({
          provider: 'mock',
          tablesCount: 0,
          totalRecords: 0,
          performance: {
            avgQueryTime: 0,
            totalQueries: 0,
            activeTransactions: 0,
          },
        })
    ),
    close: mock(() => Promise.resolve()),
    create: mock(() => Promise.resolve({} as any)),
    createMany: mock(() => Promise.resolve([] as any[])),
    findById: mock(() => Promise.resolve(null)),
    find: mock(() =>
      Promise.resolve({
        data: [],
        total: 0,
        hasMore: false,
        nextCursor: undefined,
      } as QueryResult<any>)
    ),
    findFirst: mock(() => Promise.resolve(null)),
    updateById: mock(() => Promise.resolve(null)),
    updateMany: mock(() => Promise.resolve(0)),
    deleteById: mock(() => Promise.resolve(false)),
    deleteMany: mock(() => Promise.resolve(0)),
    exists: mock(() => Promise.resolve(false)),
    count: mock(() => Promise.resolve(0)),
    resetAllMocks() {
      // Reset all mocks using the mock reset functionality
      Object.getOwnPropertyNames(this).forEach(key => {
        const value = (this as any)[key];
        if (
          value &&
          typeof value === 'function' &&
          'mockReset' in value &&
          typeof value.mockReset === 'function'
        ) {
          value.mockReset();
        }
      });
    },
  };

  return mockStorage as IStorageManager & { resetAllMocks(): void };
}

/**
 * Setup mock return value for a single call
 */
export function mockResolvedValueOnce<T>(mockFn: unknown, value: T): void {
  let called = false;
  const typedMockFn = mockFn as any;
  const originalImplementation = typedMockFn.getMockImplementation?.() ?? typedMockFn;

  typedMockFn.mockImplementation((...args: unknown[]) => {
    if (!called) {
      called = true;
      return Promise.resolve(value);
    }
    return originalImplementation(...args);
  });
}

/**
 * Setup mock rejection for a single call
 */
export function mockRejectedValueOnce(mockFn: unknown, error: Error): void {
  let called = false;
  const typedMockFn = mockFn as any;
  const originalImplementation = typedMockFn.getMockImplementation?.() ?? typedMockFn;

  typedMockFn.mockImplementation((...args: unknown[]) => {
    if (!called) {
      called = true;
      return Promise.reject(error);
    }
    return originalImplementation(...args);
  });
}

/**
 * Reset a mock function
 */
export function mockReset(mockFn: unknown): void {
  if (
    mockFn &&
    typeof mockFn === 'object' &&
    'mockReset' in mockFn &&
    typeof (mockFn as any).mockReset === 'function'
  ) {
    (mockFn as any).mockReset();
  } else if (
    mockFn &&
    typeof mockFn === 'object' &&
    'mockRestore' in mockFn &&
    typeof (mockFn as any).mockRestore === 'function'
  ) {
    (mockFn as any).mockRestore();
  }
}
