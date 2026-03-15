/**
 * Unit tests for SchemaService
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { SchemaRepository } from './schema-repository.ts';
import { SchemaService } from './schema-service.ts';
import { PubSubError } from './types.ts';

describe('SchemaService', () => {
  let storage: StorageManager;
  let repo: SchemaRepository;
  let service: SchemaService;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new SchemaRepository(storage);
    await repo.initialize();
    service = new SchemaService(repo);
  });

  // ── createSchema ──

  test('createSchema creates and returns a SchemaResponse', async () => {
    const schema = await service.createSchema('my-project', 'my-schema', {
      type: 'AVRO',
      definition: '{"type":"record","name":"Test"}',
    });

    expect(schema.name).toBe('projects/my-project/schemas/my-schema');
    expect(schema.type).toBe('AVRO');
    expect(schema.definition).toBe('{"type":"record","name":"Test"}');
    expect(schema.revisionId).toBeTypeOf('string');
    expect(schema.revisionCreateTime).toBeTypeOf('string');
  });

  test('createSchema with minimal body defaults type', async () => {
    const schema = await service.createSchema('p', 's', {
      type: 'PROTOCOL_BUFFER',
    });

    expect(schema.name).toBe('projects/p/schemas/s');
    expect(schema.type).toBe('PROTOCOL_BUFFER');
  });

  test('createSchema throws INVALID_ARGUMENT when type is missing', async () => {
    const promise = service.createSchema('p', 's', {});

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('createSchema throws ALREADY_EXISTS for duplicate', async () => {
    await service.createSchema('p', 's', { type: 'AVRO' });

    const promise = service.createSchema('p', 's', { type: 'AVRO' });

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
  });

  // ── getSchema ──

  test('getSchema returns a SchemaResponse with FULL view', async () => {
    await service.createSchema('p', 's', {
      type: 'AVRO',
      definition: '{"type":"record"}',
    });

    const schema = await service.getSchema('projects/p/schemas/s', 'FULL');

    expect(schema.name).toBe('projects/p/schemas/s');
    expect(schema.definition).toBe('{"type":"record"}');
  });

  test('getSchema with BASIC view omits definition', async () => {
    await service.createSchema('p', 's', {
      type: 'AVRO',
      definition: '{"type":"record"}',
    });

    const schema = await service.getSchema('projects/p/schemas/s', 'BASIC');

    expect(schema.name).toBe('projects/p/schemas/s');
    expect(schema.definition).toBeUndefined();
  });

  test('getSchema defaults to FULL view', async () => {
    await service.createSchema('p', 's', {
      type: 'AVRO',
      definition: '{"type":"record"}',
    });

    const schema = await service.getSchema('projects/p/schemas/s');

    expect(schema.definition).toBe('{"type":"record"}');
  });

  test('getSchema throws NOT_FOUND for missing schema', async () => {
    const promise = service.getSchema('projects/p/schemas/missing');

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── listSchemas ──

  test('listSchemas returns paginated results', async () => {
    await service.createSchema('p', 'a', { type: 'AVRO' });
    await service.createSchema('p', 'b', { type: 'AVRO' });

    const result = await service.listSchemas('p', 1);

    expect(result.schemas.length).toBe(1);
    expect(result.nextPageToken).toBeDefined();

    const result2 = await service.listSchemas('p', 1, result.nextPageToken);

    expect(result2.schemas.length).toBe(1);
  });

  test('listSchemas returns empty for project with no schemas', async () => {
    const result = await service.listSchemas('empty-project');

    expect(result.schemas).toEqual([]);
  });

  test('listSchemas with BASIC view omits definitions', async () => {
    await service.createSchema('p', 's', {
      type: 'AVRO',
      definition: '{"type":"record"}',
    });

    const result = await service.listSchemas('p', undefined, undefined, 'BASIC');

    expect(result.schemas.length).toBe(1);
    expect(result.schemas[0]?.definition).toBeUndefined();
  });

  // ── deleteSchema ──

  test('deleteSchema deletes the schema', async () => {
    await service.createSchema('p', 's', { type: 'AVRO' });
    await service.deleteSchema('projects/p/schemas/s');

    const promise = service.getSchema('projects/p/schemas/s');

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('deleteSchema throws NOT_FOUND for missing schema', async () => {
    const promise = service.deleteSchema('projects/p/schemas/missing');

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── commitSchema ──

  test('commitSchema updates definition and generates new revisionId', async () => {
    const original = await service.createSchema('p', 's', {
      type: 'AVRO',
      definition: '{"old":"def"}',
    });

    const committed = await service.commitSchema('projects/p/schemas/s', {
      schema: { type: 'AVRO', definition: '{"new":"def"}' },
    });

    expect(committed.definition).toBe('{"new":"def"}');
    expect(committed.revisionId).not.toBe(original.revisionId);
    expect(committed.revisionCreateTime).toBeTypeOf('string');
  });

  test('commitSchema throws NOT_FOUND for missing schema', async () => {
    const promise = service.commitSchema('projects/p/schemas/missing', {
      schema: { type: 'AVRO', definition: '{}' },
    });

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── rollbackSchema ──

  test('rollbackSchema returns the current schema (simplified)', async () => {
    await service.createSchema('p', 's', { type: 'AVRO', definition: '{}' });

    const result = await service.rollbackSchema('projects/p/schemas/s', {
      revisionId: 'some-rev',
    });

    expect(result.name).toBe('projects/p/schemas/s');
  });

  test('rollbackSchema throws NOT_FOUND for missing schema', async () => {
    const promise = service.rollbackSchema('projects/p/schemas/missing', {
      revisionId: 'rev',
    });

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── listRevisions ──

  test('listRevisions returns the current schema as a single-item list', async () => {
    await service.createSchema('p', 's', { type: 'AVRO' });

    const result = await service.listRevisions('projects/p/schemas/s');

    expect(result.schemas.length).toBe(1);
    expect(result.schemas[0]?.name).toBe('projects/p/schemas/s');
  });

  test('listRevisions throws NOT_FOUND for missing schema', async () => {
    const promise = service.listRevisions('projects/p/schemas/missing');

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── deleteRevision ──

  test('deleteRevision returns the current schema (simplified)', async () => {
    const created = await service.createSchema('p', 's', { type: 'AVRO' });

    const result = await service.deleteRevision('projects/p/schemas/s', created.revisionId);

    expect(result.name).toBe('projects/p/schemas/s');
  });

  test('deleteRevision throws NOT_FOUND for missing schema', async () => {
    const promise = service.deleteRevision('projects/p/schemas/missing', 'rev');

    await expect(promise).rejects.toBeInstanceOf(PubSubError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  // ── validateSchema ──

  test('validateSchema returns empty object (stub)', async () => {
    const result = await service.validateSchema('p', {
      schema: { type: 'AVRO', definition: '{}' },
    });

    expect(result).toEqual({});
  });

  // ── validateMessage ──

  test('validateMessage returns empty object (stub)', async () => {
    const result = await service.validateMessage('p', {
      message: 'dGVzdA==',
      encoding: 'JSON',
    });

    expect(result).toEqual({});
  });
});
