/**
 * SQL Admin Service - business logic for Cloud SQL control-plane emulation
 */

import type { BaseRecord } from '@/core/storage/types.ts';
import type { CloudSqlRepository } from './repository.ts';
import type {
  DatabaseInstanceResponse,
  DatabaseResponse,
  OperationResponse,
  OperationTypeValue,
  SqlDatabaseRecord,
  SqlInstanceRecord,
  UserResponse,
} from './types.ts';
import {
  DEFAULT_REGION,
  databaseRecordToResponse,
  InsertDatabaseRequestSchema,
  InsertInstanceRequestSchema,
  InsertUserRequestSchema,
  InstanceState,
  instanceRecordToResponse,
  OperationType,
  operationRecordToResponse,
  SUPPORTED_DATABASE_VERSION_PREFIX,
  UpdateDatabaseRequestSchema,
  UpdateInstanceRequestSchema,
  UpdateUserRequestSchema,
  userRecordToResponse,
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

    const incoming = request.settings ?? {};
    const { settingsVersion, kind, ...userSettings } = incoming as Record<string, unknown>;

    void kind;

    const record = await this.repo.createInstance({
      project,
      name: request.name,
      region: request.region ?? DEFAULT_REGION,
      databaseVersion: request.databaseVersion,
      state: InstanceState.RUNNABLE,
      settings: JSON.stringify(userSettings),
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

  // ── Databases ──

  async createDatabase(
    project: string,
    instance: string,
    body: unknown
  ): Promise<OperationResponse> {
    await this.requireInstance(project, instance);

    const parsed = InsertDatabaseRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new SqlAdminError(
        'INVALID_ARGUMENT',
        `Invalid database request: ${parsed.error.message}`
      );
    }

    const request = parsed.data;
    const existing = await this.repo.getDatabase(project, instance, request.name);

    if (existing) {
      throw new SqlAdminError(
        'ALREADY_EXISTS',
        `Database ${request.name} already exists on instance ${project}/${instance}`
      );
    }

    await this.repo.createDatabase({
      project,
      instance,
      name: request.name,
      charset: request.charset,
      collation: request.collation,
    });

    return this.recordOperation(project, OperationType.CREATE_DATABASE, instance);
  }

  async getDatabase(project: string, instance: string, name: string): Promise<DatabaseResponse> {
    await this.requireInstance(project, instance);

    const record = await this.repo.getDatabase(project, instance, name);

    if (!record) {
      throw new SqlAdminError(
        'NOT_FOUND',
        `Database ${name} does not exist on instance ${project}/${instance}`
      );
    }

    return databaseRecordToResponse(record);
  }

  async listDatabases(project: string, instance: string): Promise<{ items: DatabaseResponse[] }> {
    await this.requireInstance(project, instance);

    const records = await this.repo.listDatabases(project, instance);

    return { items: records.map(databaseRecordToResponse) };
  }

  async updateDatabase(
    project: string,
    instance: string,
    name: string,
    body: unknown
  ): Promise<OperationResponse> {
    await this.requireInstance(project, instance);

    const parsed = UpdateDatabaseRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new SqlAdminError(
        'INVALID_ARGUMENT',
        `Invalid database update: ${parsed.error.message}`
      );
    }

    const updates: Partial<Omit<SqlDatabaseRecord, keyof BaseRecord>> = {};

    if (parsed.data.charset !== undefined) {
      updates.charset = parsed.data.charset;
    }

    if (parsed.data.collation !== undefined) {
      updates.collation = parsed.data.collation;
    }

    const updated = await this.repo.updateDatabase(project, instance, name, updates);

    if (!updated) {
      throw new SqlAdminError(
        'NOT_FOUND',
        `Database ${name} does not exist on instance ${project}/${instance}`
      );
    }

    return this.recordOperation(project, OperationType.UPDATE_DATABASE, instance);
  }

  async deleteDatabase(
    project: string,
    instance: string,
    name: string
  ): Promise<OperationResponse> {
    await this.requireInstance(project, instance);

    const deleted = await this.repo.deleteDatabase(project, instance, name);

    if (!deleted) {
      throw new SqlAdminError(
        'NOT_FOUND',
        `Database ${name} does not exist on instance ${project}/${instance}`
      );
    }

    return this.recordOperation(project, OperationType.DELETE_DATABASE, instance);
  }

  // ── Users ──

  async createUser(project: string, instance: string, body: unknown): Promise<OperationResponse> {
    await this.requireInstance(project, instance);

    const parsed = InsertUserRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new SqlAdminError('INVALID_ARGUMENT', `Invalid user request: ${parsed.error.message}`);
    }

    const request = parsed.data;
    const existing = await this.repo.getUser(project, instance, request.name, request.host);

    if (existing) {
      throw new SqlAdminError(
        'ALREADY_EXISTS',
        `User ${request.name} already exists on instance ${project}/${instance}`
      );
    }

    await this.repo.createUser({
      project,
      instance,
      name: request.name,
      host: request.host,
      type: request.type,
      password: request.password,
    });

    return this.recordOperation(project, OperationType.CREATE_USER, instance);
  }

  async getUser(
    project: string,
    instance: string,
    name: string,
    host?: string
  ): Promise<UserResponse> {
    await this.requireInstance(project, instance);

    const record = await this.repo.getUser(project, instance, name, host);

    if (!record) {
      throw new SqlAdminError(
        'NOT_FOUND',
        `User ${name} does not exist on instance ${project}/${instance}`
      );
    }

    return userRecordToResponse(record);
  }

  async listUsers(project: string, instance: string): Promise<{ items: UserResponse[] }> {
    await this.requireInstance(project, instance);

    const records = await this.repo.listUsers(project, instance);

    return { items: records.map(userRecordToResponse) };
  }

  async updateUser(
    project: string,
    instance: string,
    name: string | undefined,
    host: string | undefined,
    body: unknown
  ): Promise<OperationResponse> {
    await this.requireInstance(project, instance);

    const parsed = UpdateUserRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new SqlAdminError('INVALID_ARGUMENT', `Invalid user update: ${parsed.error.message}`);
    }

    // Real API behavior: the name query parameter is optional and falls back
    // to the request body's name field.
    const targetName = name ?? parsed.data.name;

    if (targetName == null || targetName === '') {
      throw new SqlAdminError(
        'INVALID_ARGUMENT',
        'A user name is required, either as the name query parameter or in the request body'
      );
    }

    const updates: Partial<{ password: string }> = {};

    if (parsed.data.password !== undefined) {
      updates.password = parsed.data.password;
    }

    // Real API behavior: the host query parameter is optional and falls back
    // to the request body's host field.
    const targetHost = host ?? parsed.data.host;

    const updated = await this.repo.updateUser(project, instance, targetName, targetHost, updates);

    if (!updated) {
      throw new SqlAdminError(
        'NOT_FOUND',
        `User ${targetName} does not exist on instance ${project}/${instance}`
      );
    }

    return this.recordOperation(project, OperationType.UPDATE_USER, instance);
  }

  async deleteUser(
    project: string,
    instance: string,
    name: string | undefined,
    host?: string
  ): Promise<OperationResponse> {
    await this.requireInstance(project, instance);

    if (name == null || name === '') {
      throw new SqlAdminError(
        'INVALID_ARGUMENT',
        'The name query parameter is required to delete a user'
      );
    }

    const deleted = await this.repo.deleteUser(project, instance, name, host);

    if (!deleted) {
      throw new SqlAdminError(
        'NOT_FOUND',
        `User ${name} does not exist on instance ${project}/${instance}`
      );
    }

    return this.recordOperation(project, OperationType.DELETE_USER, instance);
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

    if (requireVersion && parsed.data.settings == null) {
      throw new SqlAdminError('INVALID_ARGUMENT', 'settings is required for instances.update');
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

    // PUT (instances.update) replaces the settings object entirely; PATCH
    // (instances.patch) merges the provided keys into the existing settings.
    const nextSettings = requireVersion
      ? userSettings
      : { ...(JSON.parse(existing.settings) as Record<string, unknown>), ...userSettings };

    await this.repo.updateInstance(project, name, {
      settings: JSON.stringify(nextSettings),
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
