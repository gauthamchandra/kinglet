/**
 * Long-running operation storage shared by services that emulate
 * `google.longrunning.Operations`.
 *
 * <p>Cloud Workflows and Memorystore for Valkey each carry a near-identical
 * private copy of this logic, differing only in table name and the
 * `type.googleapis.com/...` prefix stamped into `metadata`. AlloyDB would have
 * been the third, so the shape moved here instead. The two incumbents still use
 * their own copies — migrating a working service belongs in its own change, not
 * in one adding a new service.
 *
 * <p><b>NOTE:</b> operations are created already `done`. The emulator performs
 * every mutation synchronously, so there is no intermediate state to report, and
 * a client polling until `done` terminates on its first read. Callers that need
 * routing across several services' operations should also expose a
 * {@link ComposableOperationsStore} — see `src/core/gateway/composable-operations.ts`.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord, TableSchema } from '@/core/storage/types.ts';
import { DEFAULT_LIST_PAGE_SIZE, parseOffsetToken } from '@/shared/utils/pagination.ts';

export interface OperationMetadata {
  '@type'?: string;
  createTime: string;
  endTime: string;
  target: string;
  verb: string;
  apiVersion: string;
  requestedCancellation?: boolean;
}

export interface OperationResponse {
  name: string;
  metadata: OperationMetadata;
  done: boolean;
  response?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

export interface OperationRecord extends BaseRecord {
  name: string;
  metadata: string; // JSON-serialized OperationMetadata
  done: number; // SQLite boolean (0/1)
  response: string | null; // JSON-serialized
  error: string | null; // JSON-serialized
}

export interface OperationsStoreConfig {
  /** Table this store owns. Must be unique per service. */
  readonly tableName: string;
  /**
   * The proto package the emulated service's messages live in, e.g.
   * `google.cloud.alloydb.v1`. Used to build the `@type` of both the operation
   * metadata and the embedded resource.
   */
  readonly apiTypePrefix: string;
}

const API_VERSION = 'v1';

/**
 * <p><b>IMPORTANT:</b> the index name is derived from the table rather than
 * fixed, because SQLite index names are schema-global. Two services that both
 * declared `idx_operations_name` would collide on the second `createTable`.
 */
export function buildOperationsTableSchema(tableName: string): TableSchema {
  return {
    name: tableName,
    columns: [
      { name: 'name', type: 'string', unique: true },
      { name: 'metadata', type: 'json' },
      { name: 'done', type: 'number' },
      { name: 'response', type: 'json', nullable: true },
      { name: 'error', type: 'json', nullable: true },
    ],
    indexes: [{ name: `idx_${tableName}_name`, columns: ['name'], unique: true }],
    timestamps: true,
  };
}

export function buildOperationName(project: string, location: string, operationId: string): string {
  return `projects/${project}/locations/${location}/operations/${operationId}`;
}

function operationRecordToResponse(record: OperationRecord): OperationResponse {
  const response: OperationResponse = {
    name: record.name,
    metadata: JSON.parse(record.metadata) as OperationMetadata,
    done: record.done === 1,
  };

  if (record.response != null) {
    response.response = JSON.parse(record.response) as Record<string, unknown>;
  }

  if (record.error != null) {
    response.error = JSON.parse(record.error) as Record<string, unknown>;
  }

  return response;
}

export interface ListOperationsResult {
  operations: OperationResponse[];
  nextPageToken?: string | undefined;
}

export class OperationsStore {
  private readonly storage: StorageManager;
  private readonly config: OperationsStoreConfig;

  constructor(storage: StorageManager, config: OperationsStoreConfig) {
    this.storage = storage;
    this.config = config;
  }

  async initialize(): Promise<void> {
    const existingTables = await this.storage.listTables();

    if (existingTables.includes(this.config.tableName)) return;

    await this.storage.createTable(
      this.config.tableName,
      buildOperationsTableSchema(this.config.tableName)
    );
  }

  /**
   * Record a completed operation for a mutation that has already been applied.
   *
   * @param resourceType the resource message name, e.g. `Cluster`. Combined with
   *     the store's `apiTypePrefix` to build the embedded response's `@type`.
   * @param response the mutated resource, omitted for verbs that return nothing
   *     (delete). An absent `response` and an empty one are different to a
   *     client, so the field is left off rather than set to `{}`.
   */
  async createOperation(
    project: string,
    location: string,
    target: string,
    verb: string,
    resourceType: string,
    response?: Record<string, unknown>
  ): Promise<OperationResponse> {
    const data = this.buildOperationRow(project, location, target, verb, resourceType, response);
    const record = await this.storage.create<OperationRecord>(this.config.tableName, data);

    return operationRecordToResponse(record);
  }

  /**
   * Build the operation a mutation *would* have produced, without storing it.
   *
   * <p>For `validateOnly` requests. The method still has to answer with an
   * `Operation` to match the real API's response type, but a validation-only call
   * must leave nothing behind — persisting the operation row would make a dry run
   * observable in `operations.list`.
   */
  buildUnpersistedOperation(
    project: string,
    location: string,
    target: string,
    verb: string,
    resourceType: string,
    response?: Record<string, unknown>
  ): OperationResponse {
    const now = new Date();

    return operationRecordToResponse({
      ...this.buildOperationRow(project, location, target, verb, resourceType, response),
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
  }

  private buildOperationRow(
    project: string,
    location: string,
    target: string,
    verb: string,
    resourceType: string,
    response?: Record<string, unknown>
  ): Omit<OperationRecord, keyof BaseRecord> {
    const now = new Date().toISOString();

    const metadata: OperationMetadata = {
      '@type': `type.googleapis.com/${this.config.apiTypePrefix}.OperationMetadata`,
      createTime: now,
      endTime: now,
      target,
      verb,
      apiVersion: API_VERSION,
    };

    return {
      name: buildOperationName(project, location, crypto.randomUUID()),
      metadata: JSON.stringify(metadata),
      done: 1,
      response:
        response === undefined
          ? null
          : JSON.stringify({
              '@type': `type.googleapis.com/${this.config.apiTypePrefix}.${resourceType}`,
              ...response,
            }),
      error: null,
    };
  }

  async getOperation(name: string): Promise<OperationResponse | null> {
    const record = await this.findRecordByName(name);

    return record ? operationRecordToResponse(record) : null;
  }

  async listOperations(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListOperationsResult> {
    const prefix = `projects/${project}/locations/${location}/operations/`;
    const offset = parseOffsetToken(pageToken);
    const limit = pageSize ?? DEFAULT_LIST_PAGE_SIZE;

    const result = await this.storage.find<OperationRecord>(this.config.tableName, {
      filter: {
        conditions: [{ field: 'name', operator: 'like', value: `${prefix}%` }],
      },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    return {
      operations: result.data.map(operationRecordToResponse),
      nextPageToken: result.hasMore ? String(offset + limit) : undefined,
    };
  }

  async deleteOperation(name: string): Promise<boolean> {
    const record = await this.findRecordByName(name);

    if (!record) return false;

    return this.storage.deleteById(this.config.tableName, record.id);
  }

  /**
   * Flag that cancellation was requested.
   *
   * <p>Nothing is actually cancelled: the operation was already `done` when the
   * caller received it. Real GCP behaves the same way for an operation that
   * completed before its cancel arrived, so `done` is deliberately left alone.
   */
  async cancelOperation(name: string): Promise<boolean> {
    const record = await this.findRecordByName(name);

    if (!record) return false;

    const metadata = JSON.parse(record.metadata) as OperationMetadata;

    metadata.requestedCancellation = true;

    const updated = await this.storage.updateById<OperationRecord>(
      this.config.tableName,
      record.id,
      { metadata: JSON.stringify(metadata) }
    );

    return updated !== null;
  }

  private async findRecordByName(name: string): Promise<OperationRecord | null> {
    return this.storage.findFirst<OperationRecord>(this.config.tableName, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }
}
