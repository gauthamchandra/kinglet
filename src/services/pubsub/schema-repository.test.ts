/**
 * Unit tests for SchemaRepository
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { SchemaRepository } from './schema-repository.ts';

describe('SchemaRepository', () => {
  let storage: StorageManager;
  let repo: SchemaRepository;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new SchemaRepository(storage);
    await repo.initialize();
  });

  test('createSchema persists and returns a SchemaRecord', async () => {
    const record = await repo.createSchema({
      name: 'projects/p/schemas/s',
      type: 'AVRO',
      definition: '{"type":"record","name":"Test"}',
      revisionId: 'rev-1',
      revisionCreateTime: '2024-01-01T00:00:00.000Z',
    });

    expect(record.name).toBe('projects/p/schemas/s');
    expect(record.type).toBe('AVRO');
    expect(record.definition).toBe('{"type":"record","name":"Test"}');
    expect(record.revisionId).toBe('rev-1');
    expect(record.id).toBeTypeOf('string');
    expect(record.createdAt).toBeInstanceOf(Date);
  });

  test('getSchemaByName returns the schema when it exists', async () => {
    await repo.createSchema({
      name: 'projects/p/schemas/s',
      type: 'AVRO',
      definition: null,
      revisionId: 'rev-1',
      revisionCreateTime: '2024-01-01T00:00:00.000Z',
    });

    const found = await repo.getSchemaByName('projects/p/schemas/s');

    expect(found).not.toBeNull();
    expect(found?.name).toBe('projects/p/schemas/s');
  });

  test('getSchemaByName returns null when schema does not exist', async () => {
    const found = await repo.getSchemaByName('projects/p/schemas/missing');

    expect(found).toBeNull();
  });

  test('listSchemas filters by project and respects pageSize', async () => {
    await repo.createSchema({
      name: 'projects/p1/schemas/a',
      type: 'AVRO',
      definition: null,
      revisionId: 'rev-1',
      revisionCreateTime: '2024-01-01T00:00:00.000Z',
    });

    await repo.createSchema({
      name: 'projects/p1/schemas/b',
      type: 'PROTOCOL_BUFFER',
      definition: null,
      revisionId: 'rev-2',
      revisionCreateTime: '2024-01-01T00:00:00.000Z',
    });

    await repo.createSchema({
      name: 'projects/p2/schemas/c',
      type: 'AVRO',
      definition: null,
      revisionId: 'rev-3',
      revisionCreateTime: '2024-01-01T00:00:00.000Z',
    });

    // List only project p1
    const result = await repo.listSchemas('p1');

    expect(result.schemas.length).toBe(2);

    // List with pageSize
    const paged = await repo.listSchemas('p1', 1);

    expect(paged.schemas.length).toBe(1);
    expect(paged.nextPageToken).toBeDefined();

    // Fetch next page
    const page2 = await repo.listSchemas('p1', 1, paged.nextPageToken);

    expect(page2.schemas.length).toBe(1);
    expect(page2.schemas[0]?.name).not.toBe(paged.schemas[0]?.name);
  });

  test('updateSchema updates fields and returns updated record', async () => {
    await repo.createSchema({
      name: 'projects/p/schemas/s',
      type: 'AVRO',
      definition: '{"old":"def"}',
      revisionId: 'rev-1',
      revisionCreateTime: '2024-01-01T00:00:00.000Z',
    });

    const updated = await repo.updateSchema('projects/p/schemas/s', {
      definition: '{"new":"def"}',
      revisionId: 'rev-2',
      revisionCreateTime: '2024-02-01T00:00:00.000Z',
    });

    expect(updated).not.toBeNull();
    expect(updated?.definition).toBe('{"new":"def"}');
    expect(updated?.revisionId).toBe('rev-2');
  });

  test('updateSchema returns null for non-existent schema', async () => {
    const result = await repo.updateSchema('projects/p/schemas/missing', {
      definition: '{}',
    });

    expect(result).toBeNull();
  });

  test('deleteSchema removes the schema', async () => {
    await repo.createSchema({
      name: 'projects/p/schemas/s',
      type: 'AVRO',
      definition: null,
      revisionId: 'rev-1',
      revisionCreateTime: '2024-01-01T00:00:00.000Z',
    });

    const deleted = await repo.deleteSchema('projects/p/schemas/s');

    expect(deleted).toBe(true);

    const found = await repo.getSchemaByName('projects/p/schemas/s');

    expect(found).toBeNull();
  });

  test('deleteSchema returns false for non-existent schema', async () => {
    const result = await repo.deleteSchema('projects/p/schemas/missing');

    expect(result).toBe(false);
  });

  test('deleteSchemasByProject removes all schemas for a project', async () => {
    await repo.createSchema({
      name: 'projects/p1/schemas/a',
      type: 'AVRO',
      definition: null,
      revisionId: 'rev-1',
      revisionCreateTime: '2024-01-01T00:00:00.000Z',
    });

    await repo.createSchema({
      name: 'projects/p1/schemas/b',
      type: 'AVRO',
      definition: null,
      revisionId: 'rev-2',
      revisionCreateTime: '2024-01-01T00:00:00.000Z',
    });

    await repo.createSchema({
      name: 'projects/p2/schemas/c',
      type: 'AVRO',
      definition: null,
      revisionId: 'rev-3',
      revisionCreateTime: '2024-01-01T00:00:00.000Z',
    });

    const deletedCount = await repo.deleteSchemasByProject('p1');

    expect(deletedCount).toBe(2);

    const remaining = await repo.listSchemas('p1');

    expect(remaining.schemas.length).toBe(0);

    // p2 schemas should still exist
    const p2 = await repo.listSchemas('p2');

    expect(p2.schemas.length).toBe(1);
  });
});
