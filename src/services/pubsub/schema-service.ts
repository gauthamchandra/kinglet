/**
 * Schema Service - business logic for Pub/Sub schema CRUD
 */

import type { SchemaRepository } from './schema-repository.ts';
import type { ListSchemaRevisionsResponse, ListSchemasResponse, SchemaResponse } from './types.ts';
import { buildSchemaName, PubSubError, schemaRecordToResponse } from './types.ts';

export class SchemaService {
  private repo: SchemaRepository;

  constructor(repo: SchemaRepository) {
    this.repo = repo;
  }

  async createSchema(project: string, schemaId: string, body: unknown): Promise<SchemaResponse> {
    const data = body as { type?: string; definition?: string };

    if (!data.type) {
      throw new PubSubError(
        'INVALID_ARGUMENT',
        'Schema type is required (AVRO or PROTOCOL_BUFFER)'
      );
    }

    const name = buildSchemaName(project, schemaId);

    const existing = await this.repo.getSchemaByName(name);

    if (existing) {
      throw new PubSubError('ALREADY_EXISTS', `Schema ${name} already exists`, name);
    }

    const revisionId = crypto.randomUUID();
    const revisionCreateTime = new Date().toISOString();

    const record = await this.repo.createSchema({
      name,
      type: data.type,
      definition: data.definition ?? null,
      revisionId,
      revisionCreateTime,
    });

    return schemaRecordToResponse(record);
  }

  async getSchema(name: string, view?: string): Promise<SchemaResponse> {
    const record = await this.repo.getSchemaByName(name);

    if (!record) {
      throw new PubSubError('NOT_FOUND', `Schema ${name} not found`, name);
    }

    const response = schemaRecordToResponse(record);

    if (view === 'BASIC') {
      delete response.definition;
    }

    return response;
  }

  async listSchemas(
    project: string,
    pageSize?: number,
    pageToken?: string,
    view?: string
  ): Promise<ListSchemasResponse> {
    const result = await this.repo.listSchemas(project, pageSize, pageToken);

    const schemas = result.schemas.map(record => {
      const response = schemaRecordToResponse(record);

      if (view === 'BASIC') {
        delete response.definition;
      }

      return response;
    });

    const listResponse: ListSchemasResponse = { schemas };

    if (result.nextPageToken) {
      listResponse.nextPageToken = result.nextPageToken;
    }

    return listResponse;
  }

  async deleteSchema(name: string): Promise<void> {
    const deleted = await this.repo.deleteSchema(name);

    if (!deleted) {
      throw new PubSubError('NOT_FOUND', `Schema ${name} not found`, name);
    }
  }

  async commitSchema(name: string, body: unknown): Promise<SchemaResponse> {
    const data = body as { schema?: { type?: string; definition?: string } };

    const existing = await this.repo.getSchemaByName(name);

    if (!existing) {
      throw new PubSubError('NOT_FOUND', `Schema ${name} not found`, name);
    }

    const revisionId = crypto.randomUUID();
    const revisionCreateTime = new Date().toISOString();

    const updates: Record<string, unknown> = {
      revisionId,
      revisionCreateTime,
    };

    if (data.schema?.type) {
      updates.type = data.schema.type;
    }

    if (data.schema?.definition != null) {
      updates.definition = data.schema.definition;
    }

    const updated = await this.repo.updateSchema(name, updates);

    if (!updated) {
      throw new PubSubError('NOT_FOUND', `Schema ${name} not found`, name);
    }

    return schemaRecordToResponse(updated);
  }

  async rollbackSchema(name: string, _body: unknown): Promise<SchemaResponse> {
    // Simplified for emulator: just return the current schema
    const record = await this.repo.getSchemaByName(name);

    if (!record) {
      throw new PubSubError('NOT_FOUND', `Schema ${name} not found`, name);
    }

    return schemaRecordToResponse(record);
  }

  async listRevisions(
    name: string,
    _pageSize?: number,
    _pageToken?: string,
    view?: string
  ): Promise<ListSchemaRevisionsResponse> {
    // Simplified for emulator: return just the current schema
    const record = await this.repo.getSchemaByName(name);

    if (!record) {
      throw new PubSubError('NOT_FOUND', `Schema ${name} not found`, name);
    }

    const response = schemaRecordToResponse(record);

    if (view === 'BASIC') {
      delete response.definition;
    }

    return { schemas: [response] };
  }

  async deleteRevision(name: string, _revisionId: string): Promise<SchemaResponse> {
    // Simplified for emulator: return the current schema
    const record = await this.repo.getSchemaByName(name);

    if (!record) {
      throw new PubSubError('NOT_FOUND', `Schema ${name} not found`, name);
    }

    return schemaRecordToResponse(record);
  }

  async validateSchema(_project: string, _body: unknown): Promise<Record<string, never>> {
    // Stub: always returns success
    return {};
  }

  async validateMessage(_project: string, _body: unknown): Promise<Record<string, never>> {
    // Stub: always returns success
    return {};
  }
}
