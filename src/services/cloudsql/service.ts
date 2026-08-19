/**
 * SQL Admin Service - business logic for Cloud SQL control-plane emulation
 */

import type { CloudSqlRepository } from './repository.ts';
import type {
  DatabaseInstanceResponse,
  OperationResponse,
  OperationTypeValue,
  SqlInstanceRecord,
} from './types.ts';
import {
  DEFAULT_REGION,
  InsertInstanceRequestSchema,
  InstanceState,
  instanceRecordToResponse,
  OperationType,
  operationRecordToResponse,
  SUPPORTED_DATABASE_VERSION_PREFIX,
  UpdateInstanceRequestSchema,
} from './types.ts';

export type CloudSqlErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_ARGUMENT'
  | 'FAILED_PRECONDITION'
  | 'INTERNAL';

export class SqlAdminError extends Error {
  readonly code: CloudSqlErrorCode;

  constructor(code: CloudSqlErrorCode, message: string) {
    super(message);
    this.name = 'SqlAdminError';
    this.code = code;
  }
}

export interface ListInstancesResponse {
  items: DatabaseInstanceResponse[];
  nextPageToken?: string | undefined;
}

export interface ListOperationsResponse {
  items: OperationResponse[];
  nextPageToken?: string | undefined;
}

export class SqlAdminService {
  private repo: CloudSqlRepository;

  constructor(repo: CloudSqlRepository) {
    this.repo = repo;
  }

  // ── Instances ──

  async createInstance(project: string, body: unknown): Promise<OperationResponse> {
    const parsed = InsertInstanceRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new SqlAdminError(
        'INVALID_ARGUMENT',
        `Invalid instance request: ${parsed.error.message}`
      );
    }

    const request = parsed.data;

    if (!request.databaseVersion.startsWith(SUPPORTED_DATABASE_VERSION_PREFIX)) {
      throw new SqlAdminError(
        'INVALID_ARGUMENT',
        `kinglet emulates Cloud SQL for PostgreSQL only; databaseVersion must start with POSTGRES_ (got ${request.databaseVersion})`
      );
    }

    const existing = await this.repo.getInstance(project, request.name);

    if (existing) {
      throw new SqlAdminError(
        'ALREADY_EXISTS',
        `The Cloud SQL instance already exists: ${project}/${request.name}`
      );
    }

    const record = await this.repo.createInstance({
      project,
      name: request.name,
      region: request.region ?? DEFAULT_REGION,
      databaseVersion: request.databaseVersion,
      state: InstanceState.RUNNABLE,
      settings: JSON.stringify(request.settings ?? {}),
      settingsVersion: 1,
      createTime: new Date().toISOString(),
    });

    await this.repo.createDatabase({
      project,
      instance: request.name,
      name: 'postgres',
      charset: 'UTF8',
      collation: 'en_US.UTF8',
    });

    await this.repo.createUser({
      project,
      instance: request.name,
      name: 'postgres',
      host: '',
      type: 'BUILT_IN',
      password: request.rootPassword ?? '',
    });

    return this.recordOperation(project, OperationType.CREATE, record.name);
  }

  async getInstance(project: string, name: string): Promise<DatabaseInstanceResponse> {
    const record = await this.requireInstance(project, name);

    return instanceRecordToResponse(record);
  }

  async listInstances(
    project: string,
    maxResults?: number,
    pageToken?: string
  ): Promise<ListInstancesResponse> {
    const result = await this.repo.listInstances(project, maxResults, pageToken);

    return {
      items: result.instances.map(instanceRecordToResponse),
      nextPageToken: result.nextPageToken,
    };
  }

  async deleteInstance(project: string, name: string): Promise<OperationResponse> {
    await this.requireInstance(project, name);

    await this.repo.deleteInstance(project, name);

    return this.recordOperation(project, OperationType.DELETE, name);
  }

  async updateInstance(project: string, name: string, body: unknown): Promise<OperationResponse> {
    return this.applySettings(project, name, body, true);
  }

  async patchInstance(project: string, name: string, body: unknown): Promise<OperationResponse> {
    return this.applySettings(project, name, body, false);
  }

  async restartInstance(project: string, name: string): Promise<OperationResponse> {
    await this.requireInstance(project, name);

    return this.recordOperation(project, OperationType.RESTART, name);
  }

  // ── Operations ──

  async getOperation(project: string, name: string): Promise<OperationResponse> {
    const record = await this.repo.getOperation(project, name);

    if (!record) {
      throw new SqlAdminError('NOT_FOUND', `Operation ${name} not found in project ${project}`);
    }

    return operationRecordToResponse(record);
  }

  async listOperations(
    project: string,
    instance?: string,
    maxResults?: number,
    pageToken?: string
  ): Promise<ListOperationsResponse> {
    const result = await this.repo.listOperations(project, instance, maxResults, pageToken);

    return {
      items: result.operations.map(operationRecordToResponse),
      nextPageToken: result.nextPageToken,
    };
  }

  // ── Internals ──

  private async requireInstance(project: string, name: string): Promise<SqlInstanceRecord> {
    const record = await this.repo.getInstance(project, name);

    if (!record) {
      throw new SqlAdminError(
        'NOT_FOUND',
        `The Cloud SQL instance does not exist: ${project}/${name}`
      );
    }

    return record;
  }

  private async applySettings(
    project: string,
    name: string,
    body: unknown,
    requireVersion: boolean
  ): Promise<OperationResponse> {
    const parsed = UpdateInstanceRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new SqlAdminError(
        'INVALID_ARGUMENT',
        `Invalid update request: ${parsed.error.message}`
      );
    }

    const existing = await this.requireInstance(project, name);
    const incoming = parsed.data.settings ?? {};
    const { settingsVersion, kind, ...userSettings } = incoming as Record<string, unknown>;

    void kind;

    if (requireVersion || settingsVersion != null) {
      const provided = typeof settingsVersion === 'number' ? settingsVersion : Number.NaN;

      if (provided !== existing.settingsVersion) {
        throw new SqlAdminError(
          'FAILED_PRECONDITION',
          `settings.settingsVersion mismatch: expected ${existing.settingsVersion}, got ${String(settingsVersion)}`
        );
      }
    }

    const currentSettings = JSON.parse(existing.settings) as Record<string, unknown>;
    const merged = { ...currentSettings, ...userSettings };

    await this.repo.updateInstance(project, name, {
      settings: JSON.stringify(merged),
      settingsVersion: existing.settingsVersion + 1,
    });

    return this.recordOperation(project, OperationType.UPDATE, name);
  }

  private async recordOperation(
    project: string,
    operationType: OperationTypeValue,
    targetId: string
  ): Promise<OperationResponse> {
    const now = new Date().toISOString();

    const record = await this.repo.createOperation({
      project,
      name: crypto.randomUUID(),
      operationType,
      status: 'DONE',
      targetId,
      insertTime: now,
      startTime: now,
      endTime: now,
    });

    return operationRecordToResponse(record);
  }
}
