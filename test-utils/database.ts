/**
 * Shared database test utilities
 */

import type { StorageProvider } from '@/shared/types/index.ts';
import type { TableSchema, StorageConfig } from '@/core/storage/types.ts';
import { SQLiteStorageProvider } from '@/core/storage/providers/sqlite.ts';
import { MemoryStorageProvider } from '@/core/storage/providers/memory.ts';

/**
 * Create a test SQLite storage provider with in-memory database
 */
export async function createTestSQLiteProvider(): Promise<SQLiteStorageProvider> {
  const provider = new SQLiteStorageProvider();
  const config: StorageConfig = {
    type: 'sqlite',
    database: {
      memory: true, // Use in-memory database for tests
    },
  };

  await provider.initialize(config);
  return provider;
}

/**
 * Create a test memory storage provider
 */
export async function createTestMemoryProvider(): Promise<MemoryStorageProvider> {
  const provider = new MemoryStorageProvider();
  const config: StorageConfig = {
    type: 'memory',
    cache: {
      maxMemoryMb: 1, // 1MB for tests
    },
  };

  await provider.initialize(config);
  return provider;
}

/**
 * Create a test storage provider of specified type
 */
export async function createTestStorageProvider(
  type: 'sqlite' | 'memory'
): Promise<SQLiteStorageProvider | MemoryStorageProvider> {
  switch (type) {
    case 'sqlite':
      return createTestSQLiteProvider();
    case 'memory':
      return createTestMemoryProvider();
    default:
      throw new Error(`Unsupported storage type: ${type}`);
  }
}

/**
 * Standard test table schema for testing storage operations
 */
export const testRecordSchema: TableSchema = {
  name: 'test_records',
  columns: [
    { name: 'id', type: 'string', primaryKey: true },
    { name: 'name', type: 'string', nullable: false },
    { name: 'email', type: 'string', unique: true },
    { name: 'age', type: 'number', nullable: true },
    { name: 'active', type: 'boolean', defaultValue: true },
  ],
  timestamps: true,
  indexes: [
    { name: 'email_idx', columns: ['email'], unique: true },
    { name: 'name_age_idx', columns: ['name', 'age'] },
  ],
};

/**
 * Create and initialize a test table with standard schema
 */
export async function createTestTable(
  provider: SQLiteStorageProvider | MemoryStorageProvider,
  tableName: string = 'test_records'
): Promise<void> {
  const schema = { ...testRecordSchema, name: tableName };
  await provider.createTable(tableName, schema);
}

/**
 * Test record interface for consistent testing
 */
export interface TestRecord {
  id: string;
  name: string;
  email: string;
  age?: number;
  active: boolean;
  created_at?: string;
  updated_at?: string;
}

/**
 * Generate test data for database operations
 */
export function generateTestRecords(count: number = 5): TestRecord[] {
  const records: TestRecord[] = [];

  for (let i = 0; i < count; i++) {
    records.push({
      id: `test-${i + 1}`,
      name: `Test User ${i + 1}`,
      email: `test${i + 1}@example.com`,
      age: 20 + i,
      active: i % 2 === 0,
    });
  }

  return records;
}

/**
 * Setup a provider with test table and sample data
 */
export async function setupTestDatabase(
  type: 'sqlite' | 'memory' = 'memory',
  tableName: string = 'test_records',
  withSampleData: boolean = true
): Promise<{
  provider: SQLiteStorageProvider | MemoryStorageProvider;
  cleanup: () => Promise<void>;
}> {
  const provider = await createTestStorageProvider(type);
  await createTestTable(provider, tableName);

  if (withSampleData) {
    const testData = generateTestRecords(3);
    for (const record of testData) {
      const { id, created_at, updated_at, ...dataToCreate } = record;
      await provider.create(tableName, dataToCreate);
    }
  }

  const cleanup = async () => {
    await provider.close();
  };

  return { provider, cleanup };
}
