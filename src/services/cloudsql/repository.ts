/**
 * Cloud SQL Repository - persistence layer wrapping StorageManager
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord, QueryCondition } from '@/core/storage/types.ts';
import { DEFAULT_LIST_PAGE_SIZE, parseOffsetToken } from '@/shared/utils/pagination.ts';
import type {
  SqlDatabaseRecord,
  SqlInstanceRecord,
  SqlOperationRecord,
  SqlUserRecord,
} from './types.ts';
import {
  CLOUDSQL_DATABASES_TABLE,
  CLOUDSQL_INSTANCES_TABLE,
  CLOUDSQL_OPERATIONS_TABLE,
  CLOUDSQL_USERS_TABLE,
  cloudsqlDatabasesTableSchema,
  cloudsqlInstancesTableSchema,
  cloudsqlOperationsTableSchema,
  cloudsqlUsersTableSchema,
} from './types.ts';

export interface ListInstancesResult {
  instances: SqlInstanceRecord[];
  nextPageToken?: string | undefined;
}

export interface ListOperationsResult {
  operations: SqlOperationRecord[];
  nextPageToken?: string | undefined;
}

export class CloudSqlRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(CLOUDSQL_INSTANCES_TABLE, cloudsqlInstancesTableSchema);
    await this.storage.createTable(CLOUDSQL_DATABASES_TABLE, cloudsqlDatabasesTableSchema);
    await this.storage.createTable(CLOUDSQL_USERS_TABLE, cloudsqlUsersTableSchema);
    await this.storage.createTable(CLOUDSQL_OPERATIONS_TABLE, cloudsqlOperationsTableSchema);
  }

  // ── Instances ──

  async createInstance(
    data: Omit<SqlInstanceRecord, keyof BaseRecord>
  ): Promise<SqlInstanceRecord> {
    // Memory provider doesn't enforce unique indexes, so guard here as a safety net.
    const existing = await this.getInstance(data.project, data.name);

    if (existing) {
      throw new Error(`Instance ${data.project}/${data.name} already exists`);
    }

    return this.storage.create<SqlInstanceRecord>(CLOUDSQL_INSTANCES_TABLE, data);
  }

  async getInstance(project: string, name: string): Promise<SqlInstanceRecord | null> {
    return this.storage.findFirst<SqlInstanceRecord>(CLOUDSQL_INSTANCES_TABLE, {
      filter: {
        conditions: [
          { field: 'project', operator: 'eq', value: project },
          { field: 'name', operator: 'eq', value: name },
        ],
        operator: 'and',
      },
    });
  }

  async listInstances(
    project: string,
    maxResults?: number,
    pageToken?: string
  ): Promise<ListInstancesResult> {
    const offset = parseOffsetToken(pageToken);
    const limit = maxResults ?? DEFAULT_LIST_PAGE_SIZE;

    const result = await this.storage.find<SqlInstanceRecord>(CLOUDSQL_INSTANCES_TABLE, {
      filter: { conditions: [{ field: 'project', operator: 'eq', value: project }] },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    return {
      instances: result.data,
      nextPageToken: result.hasMore ? String(offset + limit) : undefined,
    };
  }

  async updateInstance(
    project: string,
    name: string,
    data: Partial<Omit<SqlInstanceRecord, keyof BaseRecord>>
  ): Promise<SqlInstanceRecord | null> {
    const existing = await this.getInstance(project, name);

    if (!existing) {
      return null;
    }

    return this.storage.updateById<SqlInstanceRecord>(CLOUDSQL_INSTANCES_TABLE, existing.id, data);
  }

  async deleteInstance(project: string, name: string): Promise<boolean> {
    const existing = await this.getInstance(project, name);

    if (!existing) {
      return false;
    }

    const instanceScope: QueryCondition[] = [
      { field: 'project', operator: 'eq', value: project },
      { field: 'instance', operator: 'eq', value: name },
    ];

    await this.storage.deleteMany(CLOUDSQL_DATABASES_TABLE, {
      conditions: instanceScope,
      operator: 'and',
    });

    await this.storage.deleteMany(CLOUDSQL_USERS_TABLE, {
      conditions: instanceScope,
      operator: 'and',
    });

    return this.storage.deleteById(CLOUDSQL_INSTANCES_TABLE, existing.id);
  }

  // ── Databases ──

  async createDatabase(
    data: Omit<SqlDatabaseRecord, keyof BaseRecord>
  ): Promise<SqlDatabaseRecord> {
    const existing = await this.getDatabase(data.project, data.instance, data.name);

    if (existing) {
      throw new Error(
        `Database ${data.name} already exists on instance ${data.project}/${data.instance}`
      );
    }

    return this.storage.create<SqlDatabaseRecord>(CLOUDSQL_DATABASES_TABLE, data);
  }

  async getDatabase(
    project: string,
    instance: string,
    name: string
  ): Promise<SqlDatabaseRecord | null> {
    return this.storage.findFirst<SqlDatabaseRecord>(CLOUDSQL_DATABASES_TABLE, {
      filter: {
        conditions: [
          { field: 'project', operator: 'eq', value: project },
          { field: 'instance', operator: 'eq', value: instance },
          { field: 'name', operator: 'eq', value: name },
        ],
        operator: 'and',
      },
    });
  }

  async listDatabases(project: string, instance: string): Promise<SqlDatabaseRecord[]> {
    const result = await this.storage.find<SqlDatabaseRecord>(CLOUDSQL_DATABASES_TABLE, {
      filter: {
        conditions: [
          { field: 'project', operator: 'eq', value: project },
          { field: 'instance', operator: 'eq', value: instance },
        ],
        operator: 'and',
      },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    return result.data;
  }

  async updateDatabase(
    project: string,
    instance: string,
    name: string,
    data: Partial<Omit<SqlDatabaseRecord, keyof BaseRecord>>
  ): Promise<SqlDatabaseRecord | null> {
    const existing = await this.getDatabase(project, instance, name);

    if (!existing) {
      return null;
    }

    return this.storage.updateById<SqlDatabaseRecord>(CLOUDSQL_DATABASES_TABLE, existing.id, data);
  }

  async deleteDatabase(project: string, instance: string, name: string): Promise<boolean> {
    const existing = await this.getDatabase(project, instance, name);

    if (!existing) {
      return false;
    }

    return this.storage.deleteById(CLOUDSQL_DATABASES_TABLE, existing.id);
  }

  // ── Users ──

  async createUser(data: Omit<SqlUserRecord, keyof BaseRecord>): Promise<SqlUserRecord> {
    const existing = await this.getUser(data.project, data.instance, data.name, data.host);

    if (existing) {
      throw new Error(
        `User ${data.name} already exists on instance ${data.project}/${data.instance}`
      );
    }

    return this.storage.create<SqlUserRecord>(CLOUDSQL_USERS_TABLE, data);
  }

  async getUser(
    project: string,
    instance: string,
    name: string,
    host?: string
  ): Promise<SqlUserRecord | null> {
    const conditions: QueryCondition[] = [
      { field: 'project', operator: 'eq', value: project },
      { field: 'instance', operator: 'eq', value: instance },
      { field: 'name', operator: 'eq', value: name },
    ];

    if (host !== undefined) {
      conditions.push({ field: 'host', operator: 'eq', value: host });
    }

    return this.storage.findFirst<SqlUserRecord>(CLOUDSQL_USERS_TABLE, {
      filter: { conditions, operator: 'and' },
    });
  }

  async listUsers(project: string, instance: string): Promise<SqlUserRecord[]> {
    const result = await this.storage.find<SqlUserRecord>(CLOUDSQL_USERS_TABLE, {
      filter: {
        conditions: [
          { field: 'project', operator: 'eq', value: project },
          { field: 'instance', operator: 'eq', value: instance },
        ],
        operator: 'and',
      },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    return result.data;
  }

  async updateUser(
    project: string,
    instance: string,
    name: string,
    host: string | undefined,
    data: Partial<Omit<SqlUserRecord, keyof BaseRecord>>
  ): Promise<SqlUserRecord | null> {
    const existing = await this.getUser(project, instance, name, host);

    if (!existing) {
      return null;
    }

    return this.storage.updateById<SqlUserRecord>(CLOUDSQL_USERS_TABLE, existing.id, data);
  }

  async deleteUser(
    project: string,
    instance: string,
    name: string,
    host?: string
  ): Promise<boolean> {
    const existing = await this.getUser(project, instance, name, host);

    if (!existing) {
      return false;
    }

    return this.storage.deleteById(CLOUDSQL_USERS_TABLE, existing.id);
  }

  // ── Operations ──

  async createOperation(
    data: Omit<SqlOperationRecord, keyof BaseRecord>
  ): Promise<SqlOperationRecord> {
    return this.storage.create<SqlOperationRecord>(CLOUDSQL_OPERATIONS_TABLE, data);
  }

  async getOperation(project: string, name: string): Promise<SqlOperationRecord | null> {
    return this.storage.findFirst<SqlOperationRecord>(CLOUDSQL_OPERATIONS_TABLE, {
      filter: {
        conditions: [
          { field: 'project', operator: 'eq', value: project },
          { field: 'name', operator: 'eq', value: name },
        ],
        operator: 'and',
      },
    });
  }

  async listOperations(
    project: string,
    instance?: string,
    maxResults?: number,
    pageToken?: string
  ): Promise<ListOperationsResult> {
    const offset = parseOffsetToken(pageToken);
    const limit = maxResults ?? DEFAULT_LIST_PAGE_SIZE;

    const conditions: QueryCondition[] = [{ field: 'project', operator: 'eq', value: project }];

    if (instance !== undefined) {
      conditions.push({ field: 'targetId', operator: 'eq', value: instance });
    }

    const result = await this.storage.find<SqlOperationRecord>(CLOUDSQL_OPERATIONS_TABLE, {
      filter: { conditions, operator: 'and' },
      pagination: { limit, offset },
      sort: [{ field: 'insertTime', direction: 'desc' }],
    });

    return {
      operations: result.data,
      nextPageToken: result.hasMore ? String(offset + limit) : undefined,
    };
  }
}
