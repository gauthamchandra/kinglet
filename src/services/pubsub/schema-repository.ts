/**
 * Persistence for Pub/Sub schemas. CRUD lives in {@link ResourceRepository}.
 *
 * <p>Uniqueness is enforced in the service layer, so the repository does not
 * reject duplicate names — see {@link ResourceRepositoryOptions.rejectDuplicateNames}.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import { ResourceRepository } from '@/core/storage/resource-repository.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import type { SchemaRecord } from './types.ts';
import { PUBSUB_SCHEMAS_TABLE, pubsubSchemasTableSchema } from './types.ts';

export interface ListSchemasResult {
  schemas: SchemaRecord[];
  nextPageToken?: string | undefined;
}

function buildSchemaListPrefix(project: string): string {
  return `projects/${project}/schemas/`;
}

export class SchemaRepository extends ResourceRepository<SchemaRecord> {
  constructor(storage: StorageManager) {
    super(storage, PUBSUB_SCHEMAS_TABLE, pubsubSchemasTableSchema, 'schema', {
      rejectDuplicateNames: false,
    });
  }

  createSchema(data: Omit<SchemaRecord, keyof BaseRecord>): Promise<SchemaRecord> {
    return this.create(data);
  }

  getSchemaByName(name: string): Promise<SchemaRecord | null> {
    return this.getByName(name);
  }

  updateSchema(
    name: string,
    data: Partial<Omit<SchemaRecord, keyof BaseRecord>>
  ): Promise<SchemaRecord | null> {
    return this.update(name, data);
  }

  deleteSchema(name: string): Promise<boolean> {
    return this.delete(name);
  }

  async listSchemas(
    project: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListSchemasResult> {
    const { records, nextPageToken } = await this.listByPrefix(
      buildSchemaListPrefix(project),
      pageSize,
      pageToken
    );

    return { schemas: records, nextPageToken };
  }

  deleteSchemasByProject(project: string): Promise<number> {
    return this.deleteByPrefix(buildSchemaListPrefix(project));
  }
}
