import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord, TableSchema } from '@/core/storage/types.ts';
import { BucketRepository } from './bucket-repository.ts';
import {
  BUCKETS_TABLE,
  bucketsTableSchema,
  projectNumberFromProjectId,
  requestToBucketRecord,
} from './types.ts';

const MY_PROJECT_NUMBER = '2052754419519117448';

/** Name createTable actually writes: `idx_${table}_${schemaIndexName}`. */
const PROJECT_INDEX_SQL_NAME = 'idx_storage_buckets_idx_storage_buckets_project';

const legacyBucketsSchema: TableSchema = {
  name: BUCKETS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'location', type: 'string' },
    { name: 'storageClass', type: 'string' },
    { name: 'metageneration', type: 'number' },
    { name: 'timeCreated', type: 'string' },
    { name: 'updated', type: 'string' },
    { name: 'versioning', type: 'json', nullable: true },
    { name: 'labels', type: 'json', nullable: true },
    { name: 'cors', type: 'json', nullable: true },
    { name: 'lifecycle', type: 'json', nullable: true },
    { name: 'projectNumber', type: 'string' },
  ],
  indexes: [
    { name: 'idx_storage_buckets_name', columns: ['name'], unique: true },
    { name: 'idx_storage_buckets_project', columns: ['projectNumber'] },
  ],
  timestamps: true,
};

interface LegacyBucketRow extends BaseRecord {
  name: string;
  location: string;
  storageClass: string;
  metageneration: number;
  timeCreated: string;
  updated: string;
  versioning: null;
  labels: null;
  cors: null;
  lifecycle: null;
  projectNumber: string;
}

function legacyBucket(
  name: string,
  projectNumber: string
): Omit<LegacyBucketRow, keyof BaseRecord> {
  return {
    name,
    location: 'US',
    storageClass: 'STANDARD',
    metageneration: 1,
    timeCreated: '2024-01-01T00:00:00.000Z',
    updated: '2024-01-01T00:00:00.000Z',
    versioning: null,
    labels: null,
    cors: null,
    lifecycle: null,
    projectNumber,
  };
}

function sqliteProjectIndexColumns(storage: StorageManager): string[] {
  const provider = storage.getProvider() as unknown as {
    db: { prepare: (sql: string) => { all: () => Array<{ name: string }> } } | null;
  };

  if (!provider.db) {
    throw new Error('sqlite database is not open');
  }

  return provider.db
    .prepare(`PRAGMA index_info(${PROJECT_INDEX_SQL_NAME})`)
    .all()
    .map(column => column.name);
}

function memoryProjectIndexColumns(storage: StorageManager): string[] {
  const provider = storage.getProvider() as unknown as {
    tables: Map<string, { schema: { indexes?: Array<{ name: string; columns: string[] }> } }>;
  };
  const index = provider.tables
    .get(BUCKETS_TABLE)
    ?.schema.indexes?.find(item => item.name === 'idx_storage_buckets_project');

  if (!index) {
    throw new Error('project index missing');
  }

  return index.columns;
}

describe('BucketRepository', () => {
  let storage: StorageManager;
  let repo: BucketRepository;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new BucketRepository(storage);
    await repo.initialize();
  });

  test('initialize creates table without error', async () => {
    const repo2 = new BucketRepository(storage);
    await expect(repo2.initialize()).resolves.toBeUndefined();
  });

  test('createBucket creates and returns a BucketRecord', async () => {
    const data = requestToBucketRecord('test-bucket', { name: 'test-bucket' }, 'proj-1');
    const result = await repo.createBucket(data);

    expect(result.name).toBe('test-bucket');
    expect(result.id).toBeTypeOf('string');
    expect(result.location).toBe('US');
    expect(result.storageClass).toBe('STANDARD');
  });

  test('createBucket rejects duplicate name', async () => {
    const data = requestToBucketRecord('dup-bucket', { name: 'dup-bucket' }, 'proj-1');
    await repo.createBucket(data);

    const data2 = requestToBucketRecord('dup-bucket', { name: 'dup-bucket' }, 'proj-1');
    await expect(repo.createBucket(data2)).rejects.toThrow('already exists');
  });

  test('getBucketByName returns bucket', async () => {
    const data = requestToBucketRecord('find-me', { name: 'find-me' }, 'proj-1');
    await repo.createBucket(data);

    const found = await repo.getBucketByName('find-me');
    expect(found?.name).toBe('find-me');
  });

  test('getBucketByName returns null for nonexistent', async () => {
    const found = await repo.getBucketByName('nonexistent');
    expect(found).toBeNull();
  });

  test('listBuckets returns all for project', async () => {
    await repo.createBucket(requestToBucketRecord('b1', { name: 'b1' }, 'proj-1'));
    await repo.createBucket(requestToBucketRecord('b2', { name: 'b2' }, 'proj-1'));
    await repo.createBucket(requestToBucketRecord('b3', { name: 'b3' }, 'proj-2'));

    const result = await repo.listBuckets('proj-1');
    expect(result.buckets).toHaveLength(2);
  });

  test('listBuckets supports pagination', async () => {
    await repo.createBucket(requestToBucketRecord('a1', { name: 'a1' }, 'proj-1'));
    await repo.createBucket(requestToBucketRecord('a2', { name: 'a2' }, 'proj-1'));
    await repo.createBucket(requestToBucketRecord('a3', { name: 'a3' }, 'proj-1'));

    const page1 = await repo.listBuckets('proj-1', 2);
    expect(page1.buckets).toHaveLength(2);
    expect(page1.nextPageToken).toBeTypeOf('string');

    const page2 = await repo.listBuckets('proj-1', 2, page1.nextPageToken);
    expect(page2.buckets).toHaveLength(1);
    expect(page2.nextPageToken).toBeUndefined();
  });

  test('listBuckets returns empty for unknown project', async () => {
    const result = await repo.listBuckets('unknown');
    expect(result.buckets).toHaveLength(0);
  });

  test('updateBucket updates fields', async () => {
    await repo.createBucket(requestToBucketRecord('upd', { name: 'upd' }, 'proj-1'));

    const updated = await repo.updateBucket('upd', { storageClass: 'NEARLINE' });
    expect(updated?.storageClass).toBe('NEARLINE');
  });

  test('updateBucket returns null for nonexistent', async () => {
    const result = await repo.updateBucket('nope', { storageClass: 'NEARLINE' });
    expect(result).toBeNull();
  });

  test('deleteBucket returns true', async () => {
    await repo.createBucket(requestToBucketRecord('del', { name: 'del' }, 'proj-1'));

    const result = await repo.deleteBucket('del');
    expect(result).toBe(true);

    const found = await repo.getBucketByName('del');
    expect(found).toBeNull();
  });

  test('deleteBucket returns false for nonexistent', async () => {
    const result = await repo.deleteBucket('nope');
    expect(result).toBe(false);
  });
});

describe('legacy projectNumber migration', () => {
  test('sqlite initialize rewrites an old row and retargets the project index', async () => {
    const storage = new StorageManager();
    await storage.initialize({ type: 'sqlite' });

    try {
      await storage.createTable(BUCKETS_TABLE, legacyBucketsSchema);
      expect(sqliteProjectIndexColumns(storage)).toEqual(['projectNumber']);

      await storage.create<LegacyBucketRow>(
        BUCKETS_TABLE,
        legacyBucket('legacy-bucket', 'my-project')
      );
      await storage.create<LegacyBucketRow>(
        BUCKETS_TABLE,
        legacyBucket('already-numeric', MY_PROJECT_NUMBER)
      );

      const repo = new BucketRepository(storage);
      await repo.initialize();

      const migrated = await repo.getBucketByName('legacy-bucket');
      expect(migrated?.projectId).toBe('my-project');
      expect(migrated?.projectNumber).toBe(MY_PROJECT_NUMBER);

      const listed = await repo.listBuckets('my-project');
      expect(listed.buckets.map(bucket => bucket.name)).toEqual(['legacy-bucket']);

      expect(sqliteProjectIndexColumns(storage)).toEqual(['projectId']);

      const numeric = await repo.getBucketByName('already-numeric');
      expect(numeric?.projectNumber).toBe(MY_PROJECT_NUMBER);
      expect(numeric?.projectId).toBe(MY_PROJECT_NUMBER);

      const listedByNumber = await repo.listBuckets(MY_PROJECT_NUMBER);
      expect(listedByNumber.buckets.map(bucket => bucket.name)).toEqual(['already-numeric']);

      await repo.initialize();

      const again = await repo.getBucketByName('legacy-bucket');
      expect(again?.projectId).toBe('my-project');
      expect(again?.projectNumber).toBe(MY_PROJECT_NUMBER);

      const numericAgain = await repo.getBucketByName('already-numeric');
      expect(numericAgain?.projectId).toBe(MY_PROJECT_NUMBER);
      expect(numericAgain?.projectNumber).toBe(MY_PROJECT_NUMBER);
      expect(sqliteProjectIndexColumns(storage)).toEqual(['projectId']);
    } finally {
      await storage.getProvider().close();
    }
  });

  test('sqlite initialize migrates a later legacy row without rebuilding the project index', async () => {
    const storage = new StorageManager();
    await storage.initialize({ type: 'sqlite' });

    try {
      await storage.createTable(BUCKETS_TABLE, legacyBucketsSchema);
      await storage.createTable(BUCKETS_TABLE, bucketsTableSchema);
      expect(sqliteProjectIndexColumns(storage)).toEqual(['projectNumber']);

      const provider = storage.getProvider();
      expect(
        provider.retargetIndex(BUCKETS_TABLE, 'idx_storage_buckets_project', ['projectId'])
      ).toBe(true);
      expect(sqliteProjectIndexColumns(storage)).toEqual(['projectId']);
      expect(
        provider.retargetIndex(BUCKETS_TABLE, 'idx_storage_buckets_project', ['projectId'])
      ).toBe(false);

      await storage.create<LegacyBucketRow>(
        BUCKETS_TABLE,
        legacyBucket('other-bucket', 'other-id')
      );

      const repo = new BucketRepository(storage);
      await repo.initialize();

      const migrated = await repo.getBucketByName('other-bucket');
      expect(migrated?.projectId).toBe('other-id');
      expect(migrated?.projectNumber).toBe(projectNumberFromProjectId('other-id'));
      expect(sqliteProjectIndexColumns(storage)).toEqual(['projectId']);
      expect(
        provider.retargetIndex(BUCKETS_TABLE, 'idx_storage_buckets_project', ['projectId'])
      ).toBe(false);
    } finally {
      await storage.getProvider().close();
    }
  });

  test('memory initialize rewrites an old row and points the project index at projectId', async () => {
    const storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    await storage.createTable(BUCKETS_TABLE, legacyBucketsSchema);
    expect(memoryProjectIndexColumns(storage)).toEqual(['projectNumber']);

    await storage.create<LegacyBucketRow>(
      BUCKETS_TABLE,
      legacyBucket('legacy-bucket', 'my-project')
    );
    await storage.create<LegacyBucketRow>(BUCKETS_TABLE, legacyBucket('numeric-id', '123456789'));

    const repo = new BucketRepository(storage);
    await repo.initialize();

    const migrated = await repo.getBucketByName('legacy-bucket');
    expect(migrated?.projectId).toBe('my-project');
    expect(migrated?.projectNumber).toBe(MY_PROJECT_NUMBER);

    const listed = await repo.listBuckets('my-project');
    expect(listed.buckets.map(bucket => bucket.name)).toEqual(['legacy-bucket']);

    const numeric = await repo.getBucketByName('numeric-id');
    expect(numeric?.projectId).toBe('123456789');
    expect(numeric?.projectNumber).toBe('123456789');

    const listedNumeric = await repo.listBuckets('123456789');
    expect(listedNumeric.buckets.map(bucket => bucket.name)).toEqual(['numeric-id']);
    expect(memoryProjectIndexColumns(storage)).toEqual(['projectId']);
  });
});
