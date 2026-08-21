/**
 * Cloud SQL Admin API data models, table schemas, and helper functions
 *
 * Field names, kind strings, and resource shapes follow the sqladmin v1
 * discovery document: https://sqladmin.googleapis.com/$discovery/rest?version=v1
 */

import { z } from 'zod';
import type { BaseRecord, TableSchema } from '@/core/storage/types.ts';

// ── Constants ──

export const CLOUDSQL_INSTANCES_TABLE = 'cloudsql_instances';
export const CLOUDSQL_DATABASES_TABLE = 'cloudsql_databases';
export const CLOUDSQL_USERS_TABLE = 'cloudsql_users';
export const CLOUDSQL_OPERATIONS_TABLE = 'cloudsql_operations';

export const SUPPORTED_DATABASE_VERSION_PREFIX = 'POSTGRES_';

export const DEFAULT_REGION = 'us-central1';

const SQLADMIN_BASE_URL = 'https://sqladmin.googleapis.com/v1';

// Instance names: start with a lowercase letter; lowercase letters, digits, hyphens.
const INSTANCE_NAME_PATTERN = /^[a-z](?:[-a-z0-9]{0,96}[a-z0-9])?$/;

export const InstanceState = {
  RUNNABLE: 'RUNNABLE',
} as const;

export const OperationType = {
  CREATE: 'CREATE',
  DELETE: 'DELETE',
  UPDATE: 'UPDATE',
  RESTART: 'RESTART',
  CREATE_DATABASE: 'CREATE_DATABASE',
  DELETE_DATABASE: 'DELETE_DATABASE',
  UPDATE_DATABASE: 'UPDATE_DATABASE',
  CREATE_USER: 'CREATE_USER',
  DELETE_USER: 'DELETE_USER',
  UPDATE_USER: 'UPDATE_USER',
} as const;

export type OperationTypeValue = (typeof OperationType)[keyof typeof OperationType];

// ── Storage Records ──

export interface SqlInstanceRecord extends BaseRecord {
  project: string;
  name: string;
  region: string;
  databaseVersion: string;
  state: string;
  settings: string; // JSON-serialized user settings (without kind/settingsVersion)
  settingsVersion: number;
  createTime: string;
}

export interface SqlDatabaseRecord extends BaseRecord {
  project: string;
  instance: string;
  name: string;
  charset: string;
  collation: string;
}

export interface SqlUserRecord extends BaseRecord {
  project: string;
  instance: string;
  name: string;
  host: string;
  type: string;
  password: string;
}

export interface SqlOperationRecord extends BaseRecord {
  project: string;
  name: string;
  operationType: string;
  status: string;
  targetId: string;
  insertTime: string;
  startTime: string;
  endTime: string;
}

// ── Table Schemas ──

export const cloudsqlInstancesTableSchema: TableSchema = {
  name: CLOUDSQL_INSTANCES_TABLE,
  columns: [
    { name: 'project', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'region', type: 'string' },
    { name: 'databaseVersion', type: 'string' },
    { name: 'state', type: 'string' },
    { name: 'settings', type: 'json' },
    { name: 'settingsVersion', type: 'number' },
    { name: 'createTime', type: 'string' },
  ],
  indexes: [
    {
      name: 'idx_cloudsql_instances_project_name',
      columns: ['project', 'name'],
      unique: true,
    },
  ],
  timestamps: true,
};

export const cloudsqlDatabasesTableSchema: TableSchema = {
  name: CLOUDSQL_DATABASES_TABLE,
  columns: [
    { name: 'project', type: 'string' },
    { name: 'instance', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'charset', type: 'string' },
    { name: 'collation', type: 'string' },
  ],
  indexes: [
    {
      name: 'idx_cloudsql_databases_identity',
      columns: ['project', 'instance', 'name'],
      unique: true,
    },
  ],
  timestamps: true,
};

export const cloudsqlUsersTableSchema: TableSchema = {
  name: CLOUDSQL_USERS_TABLE,
  columns: [
    { name: 'project', type: 'string' },
    { name: 'instance', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'host', type: 'string' },
    { name: 'type', type: 'string' },
    { name: 'password', type: 'string' },
  ],
  indexes: [
    {
      name: 'idx_cloudsql_users_identity',
      columns: ['project', 'instance', 'name', 'host'],
      unique: true,
    },
  ],
  timestamps: true,
};

export const cloudsqlOperationsTableSchema: TableSchema = {
  name: CLOUDSQL_OPERATIONS_TABLE,
  columns: [
    { name: 'project', type: 'string' },
    { name: 'name', type: 'string', unique: true },
    { name: 'operationType', type: 'string' },
    { name: 'status', type: 'string' },
    { name: 'targetId', type: 'string' },
    { name: 'insertTime', type: 'string' },
    { name: 'startTime', type: 'string' },
    { name: 'endTime', type: 'string' },
  ],
  indexes: [
    { name: 'idx_cloudsql_operations_name', columns: ['name'], unique: true },
    { name: 'idx_cloudsql_operations_project', columns: ['project'] },
    { name: 'idx_cloudsql_operations_target', columns: ['targetId'] },
  ],
  timestamps: true,
};

// ── API Response Types ──

export interface IpMapping {
  type: string;
  ipAddress: string;
}

export interface DatabaseInstanceResponse {
  kind: 'sql#instance';
  name: string;
  project: string;
  region: string;
  databaseVersion: string;
  state: string;
  instanceType: 'CLOUD_SQL_INSTANCE';
  backendType: 'SECOND_GEN';
  connectionName: string;
  ipAddresses: IpMapping[];
  settings: Record<string, unknown>;
  selfLink: string;
  createTime: string;
  etag: string;
}

export interface DatabaseResponse {
  kind: 'sql#database';
  name: string;
  instance: string;
  project: string;
  charset: string;
  collation: string;
  selfLink: string;
}

export interface UserResponse {
  kind: 'sql#user';
  name: string;
  host: string;
  instance: string;
  project: string;
  type: string;
}

export interface OperationResponse {
  kind: 'sql#operation';
  name: string;
  operationType: string;
  status: string;
  user: string;
  targetId: string;
  targetProject: string;
  targetLink: string;
  selfLink: string;
  insertTime: string;
  startTime: string;
  endTime: string;
}

// ── Zod Request Schemas ──

export const InsertInstanceRequestSchema = z.object({
  name: z
    .string()
    .regex(
      INSTANCE_NAME_PATTERN,
      'Instance name must start with a lowercase letter and use only lowercase letters, digits, and hyphens'
    ),
  databaseVersion: z.string().min(1),
  region: z.string().min(1).optional(),
  rootPassword: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export const UpdateInstanceRequestSchema = z.object({
  settings: z.record(z.string(), z.unknown()).optional(),
});

export const InsertDatabaseRequestSchema = z.object({
  name: z.string().min(1),
  charset: z.string().default('UTF8'),
  collation: z.string().default('en_US.UTF8'),
});

export const UpdateDatabaseRequestSchema = z.object({
  charset: z.string().optional(),
  collation: z.string().optional(),
});

export const InsertUserRequestSchema = z.object({
  name: z.string().min(1),
  host: z.string().default(''),
  password: z.string().default(''),
  type: z.string().default('BUILT_IN'),
});

export const UpdateUserRequestSchema = z.object({
  name: z.string().optional(),
  host: z.string().optional(),
  password: z.string().optional(),
});

// ── Name Helpers ──

export function buildConnectionName(project: string, region: string, name: string): string {
  return `${project}:${region}:${name}`;
}

export function buildInstanceSelfLink(project: string, name: string): string {
  return `${SQLADMIN_BASE_URL}/projects/${project}/instances/${name}`;
}

function buildOperationSelfLink(project: string, operationName: string): string {
  return `${SQLADMIN_BASE_URL}/projects/${project}/operations/${operationName}`;
}

function buildDatabaseSelfLink(project: string, instance: string, name: string): string {
  return `${SQLADMIN_BASE_URL}/projects/${project}/instances/${instance}/databases/${name}`;
}

// ── Conversion Functions ──

export function instanceRecordToResponse(record: SqlInstanceRecord): DatabaseInstanceResponse {
  const userSettings = JSON.parse(record.settings) as Record<string, unknown>;

  return {
    kind: 'sql#instance',
    name: record.name,
    project: record.project,
    region: record.region,
    databaseVersion: record.databaseVersion,
    state: record.state,
    instanceType: 'CLOUD_SQL_INSTANCE',
    backendType: 'SECOND_GEN',
    connectionName: buildConnectionName(record.project, record.region, record.name),
    ipAddresses: [{ type: 'PRIMARY', ipAddress: '127.0.0.1' }],
    settings: {
      kind: 'sql#settings',
      settingsVersion: record.settingsVersion,
      ...userSettings,
    },
    selfLink: buildInstanceSelfLink(record.project, record.name),
    createTime: record.createTime,
    etag: String(record.settingsVersion),
  };
}

export function databaseRecordToResponse(record: SqlDatabaseRecord): DatabaseResponse {
  return {
    kind: 'sql#database',
    name: record.name,
    instance: record.instance,
    project: record.project,
    charset: record.charset,
    collation: record.collation,
    selfLink: buildDatabaseSelfLink(record.project, record.instance, record.name),
  };
}

export function userRecordToResponse(record: SqlUserRecord): UserResponse {
  return {
    kind: 'sql#user',
    name: record.name,
    host: record.host,
    instance: record.instance,
    project: record.project,
    type: record.type,
  };
}

export function operationRecordToResponse(record: SqlOperationRecord): OperationResponse {
  return {
    kind: 'sql#operation',
    name: record.name,
    operationType: record.operationType,
    status: record.status,
    user: 'emulator@kinglet.local',
    targetId: record.targetId,
    targetProject: record.project,
    targetLink: buildInstanceSelfLink(record.project, record.targetId),
    selfLink: buildOperationSelfLink(record.project, record.name),
    insertTime: record.insertTime,
    startTime: record.startTime,
    endTime: record.endTime,
  };
}
