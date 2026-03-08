/**
 * Cloud Workflows data models, schemas, and helper functions
 */

import { z } from 'zod';
import type { BaseRecord, TableSchema } from '@/core/storage/types.ts';

// ── Constants ──

export const WORKFLOWS_TABLE = 'workflows';
export const WORKFLOW_REVISIONS_TABLE = 'workflow_revisions';
export const WORKFLOW_OPERATIONS_TABLE = 'workflow_operations';

export const WorkflowState = {
  STATE_UNSPECIFIED: 'STATE_UNSPECIFIED',
  ACTIVE: 'ACTIVE',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;

export const CallLogLevel = {
  CALL_LOG_LEVEL_UNSPECIFIED: 'CALL_LOG_LEVEL_UNSPECIFIED',
  LOG_ALL_CALLS: 'LOG_ALL_CALLS',
  LOG_ERRORS_ONLY: 'LOG_ERRORS_ONLY',
  LOG_NONE: 'LOG_NONE',
} as const;

export const ExecutionHistoryLevel = {
  EXECUTION_HISTORY_LEVEL_UNSPECIFIED: 'EXECUTION_HISTORY_LEVEL_UNSPECIFIED',
  EXECUTION_HISTORY_BASIC: 'EXECUTION_HISTORY_BASIC',
  EXECUTION_HISTORY_DETAILED: 'EXECUTION_HISTORY_DETAILED',
  EXECUTION_HISTORY_NONE: 'EXECUTION_HISTORY_NONE',
} as const;

// ── Interfaces ──

export interface StateError {
  details: string;
  type: string;
}

export interface WorkflowResponse {
  name: string;
  description: string;
  state: string;
  revisionId: string;
  createTime: string;
  updateTime: string;
  revisionCreateTime: string;
  labels: Record<string, string>;
  serviceAccount: string;
  sourceContents: string;
  cryptoKeyName?: string;
  stateError?: StateError;
  callLogLevel?: string;
  userEnvVars?: Record<string, string>;
  executionHistoryLevel?: string;
  tags?: Record<string, string>;
  allKmsKeys?: string[];
  allKmsKeysVersions?: string[];
  cryptoKeyVersion?: string;
}

export interface OperationMetadata {
  '@type'?: string;
  createTime: string;
  endTime: string;
  target: string;
  verb: string;
  apiVersion: string;
}

export interface OperationResponse {
  name: string;
  metadata: OperationMetadata;
  done: boolean;
  response?: Record<string, unknown>;
  error?: unknown;
}

// ── Storage Records ──

export interface WorkflowRecord extends BaseRecord {
  name: string;
  description: string;
  state: string;
  revisionId: string;
  revisionCreateTime: string;
  labels: string; // JSON-serialized Record<string, string>
  serviceAccount: string;
  sourceContents: string;
  cryptoKeyName: string | null;
  stateError: string | null; // JSON-serialized StateError
  callLogLevel: string;
  userEnvVars: string | null; // JSON-serialized Record<string, string>
  executionHistoryLevel: string;
  tags: string | null; // JSON-serialized Record<string, string>
}

export interface WorkflowRevisionRecord extends BaseRecord {
  workflowName: string;
  revisionId: string;
  description: string;
  state: string;
  revisionCreateTime: string;
  labels: string;
  serviceAccount: string;
  sourceContents: string;
  cryptoKeyName: string | null;
  stateError: string | null;
  callLogLevel: string;
  userEnvVars: string | null;
  executionHistoryLevel: string;
  tags: string | null;
}

export interface OperationRecord extends BaseRecord {
  name: string;
  metadata: string; // JSON-serialized OperationMetadata
  done: number; // SQLite boolean (0/1)
  response: string | null; // JSON-serialized
  error: string | null; // JSON-serialized
}

// ── Table Schemas ──

export const workflowsTableSchema: TableSchema = {
  name: WORKFLOWS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'description', type: 'string', nullable: true },
    { name: 'state', type: 'string' },
    { name: 'revisionId', type: 'string' },
    { name: 'revisionCreateTime', type: 'string' },
    { name: 'labels', type: 'json' },
    { name: 'serviceAccount', type: 'string', nullable: true },
    { name: 'sourceContents', type: 'string', nullable: true },
    { name: 'cryptoKeyName', type: 'string', nullable: true },
    { name: 'stateError', type: 'json', nullable: true },
    { name: 'callLogLevel', type: 'string', nullable: true },
    { name: 'userEnvVars', type: 'json', nullable: true },
    { name: 'executionHistoryLevel', type: 'string', nullable: true },
    { name: 'tags', type: 'json', nullable: true },
  ],
  indexes: [
    { name: 'idx_workflows_name', columns: ['name'], unique: true },
    { name: 'idx_workflows_state', columns: ['state'] },
    { name: 'idx_workflows_revision_id', columns: ['revisionId'] },
  ],
  timestamps: true,
};

export const workflowRevisionsTableSchema: TableSchema = {
  name: WORKFLOW_REVISIONS_TABLE,
  columns: [
    { name: 'workflowName', type: 'string' },
    { name: 'revisionId', type: 'string' },
    { name: 'description', type: 'string', nullable: true },
    { name: 'state', type: 'string' },
    { name: 'revisionCreateTime', type: 'string' },
    { name: 'labels', type: 'json' },
    { name: 'serviceAccount', type: 'string', nullable: true },
    { name: 'sourceContents', type: 'string', nullable: true },
    { name: 'cryptoKeyName', type: 'string', nullable: true },
    { name: 'stateError', type: 'json', nullable: true },
    { name: 'callLogLevel', type: 'string', nullable: true },
    { name: 'userEnvVars', type: 'json', nullable: true },
    { name: 'executionHistoryLevel', type: 'string', nullable: true },
    { name: 'tags', type: 'json', nullable: true },
  ],
  indexes: [
    { name: 'idx_revisions_workflow_name', columns: ['workflowName'] },
    { name: 'idx_revisions_revision_id', columns: ['revisionId'] },
  ],
  timestamps: true,
};

export const workflowOperationsTableSchema: TableSchema = {
  name: WORKFLOW_OPERATIONS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'metadata', type: 'json' },
    { name: 'done', type: 'number' },
    { name: 'response', type: 'json', nullable: true },
    { name: 'error', type: 'json', nullable: true },
  ],
  indexes: [{ name: 'idx_operations_name', columns: ['name'], unique: true }],
  timestamps: true,
};

// ── Zod Schemas ──

export const CreateWorkflowRequestSchema = z.object({
  sourceContents: z.string().min(1),
  description: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  serviceAccount: z.string().optional(),
  cryptoKeyName: z.string().optional(),
  callLogLevel: z
    .enum(['CALL_LOG_LEVEL_UNSPECIFIED', 'LOG_ALL_CALLS', 'LOG_ERRORS_ONLY', 'LOG_NONE'])
    .optional(),
  userEnvVars: z.record(z.string(), z.string()).optional(),
  executionHistoryLevel: z
    .enum([
      'EXECUTION_HISTORY_LEVEL_UNSPECIFIED',
      'EXECUTION_HISTORY_BASIC',
      'EXECUTION_HISTORY_DETAILED',
      'EXECUTION_HISTORY_NONE',
    ])
    .optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

export const UpdateWorkflowRequestSchema = z.object({
  sourceContents: z.string().min(1).optional(),
  description: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  serviceAccount: z.string().optional(),
  cryptoKeyName: z.string().optional(),
  callLogLevel: z
    .enum(['CALL_LOG_LEVEL_UNSPECIFIED', 'LOG_ALL_CALLS', 'LOG_ERRORS_ONLY', 'LOG_NONE'])
    .optional(),
  userEnvVars: z.record(z.string(), z.string()).optional(),
  executionHistoryLevel: z
    .enum([
      'EXECUTION_HISTORY_LEVEL_UNSPECIFIED',
      'EXECUTION_HISTORY_BASIC',
      'EXECUTION_HISTORY_DETAILED',
      'EXECUTION_HISTORY_NONE',
    ])
    .optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

export type CreateWorkflowRequest = z.infer<typeof CreateWorkflowRequestSchema>;

// ── Helper Functions ──

export function parseWorkflowName(name: string): {
  project: string;
  location: string;
  workflowId: string;
} {
  const match = name.match(/^projects\/([^/]+)\/locations\/([^/]+)\/workflows\/([^/]+)$/);

  if (!match) {
    throw new Error(
      `Invalid workflow resource name: "${name}". Expected format: projects/{project}/locations/{location}/workflows/{workflowId}`
    );
  }

  return {
    project: match[1] as string,
    location: match[2] as string,
    workflowId: match[3] as string,
  };
}

export function buildWorkflowName(project: string, location: string, workflowId: string): string {
  return `projects/${project}/locations/${location}/workflows/${workflowId}`;
}

export function parseOperationName(name: string): {
  project: string;
  location: string;
  operationId: string;
} {
  const match = name.match(/^projects\/([^/]+)\/locations\/([^/]+)\/operations\/([^/]+)$/);

  if (!match) {
    throw new Error(
      `Invalid operation resource name: "${name}". Expected format: projects/{project}/locations/{location}/operations/{operationId}`
    );
  }

  return {
    project: match[1] as string,
    location: match[2] as string,
    operationId: match[3] as string,
  };
}

export function buildOperationName(project: string, location: string, operationId: string): string {
  return `projects/${project}/locations/${location}/operations/${operationId}`;
}

/**
 * Generate a revision ID in GCP format: zero-padded 6-digit ordinal + hyphen + 3 random hex chars.
 * Example: "000001-a4d"
 */
export function generateRevisionId(ordinal: number): string {
  const paddedOrdinal = String(ordinal).padStart(6, '0');
  const randomHex = Math.random().toString(16).substring(2, 5).padEnd(3, '0');

  return `${paddedOrdinal}-${randomHex}`;
}

// ── Conversion Functions ──

interface OptionalFieldsSource {
  cryptoKeyName: string | null;
  stateError: string | null;
  callLogLevel: string;
  userEnvVars: string | null;
  executionHistoryLevel: string;
  tags: string | null;
}

function applyOptionalFields(response: WorkflowResponse, record: OptionalFieldsSource): void {
  if (record.cryptoKeyName) {
    response.cryptoKeyName = record.cryptoKeyName;
    response.allKmsKeys = [record.cryptoKeyName];
  }

  if (record.stateError) {
    response.stateError = JSON.parse(record.stateError) as StateError;
  }

  if (record.callLogLevel && record.callLogLevel !== CallLogLevel.CALL_LOG_LEVEL_UNSPECIFIED) {
    response.callLogLevel = record.callLogLevel;
  }

  if (record.userEnvVars) {
    response.userEnvVars = JSON.parse(record.userEnvVars) as Record<string, string>;
  }

  if (
    record.executionHistoryLevel &&
    record.executionHistoryLevel !== ExecutionHistoryLevel.EXECUTION_HISTORY_LEVEL_UNSPECIFIED
  ) {
    response.executionHistoryLevel = record.executionHistoryLevel;
  }

  if (record.tags) {
    response.tags = JSON.parse(record.tags) as Record<string, string>;
  }

  response.allKmsKeysVersions = [];
  response.cryptoKeyVersion = '';
}

export function workflowRecordToResponse(record: WorkflowRecord): WorkflowResponse {
  const response: WorkflowResponse = {
    name: record.name,
    description: record.description,
    state: record.state,
    revisionId: record.revisionId,
    createTime: record.createdAt.toISOString(),
    updateTime: record.updatedAt.toISOString(),
    revisionCreateTime: record.revisionCreateTime,
    labels: JSON.parse(record.labels) as Record<string, string>,
    serviceAccount: record.serviceAccount,
    sourceContents: record.sourceContents,
  };

  applyOptionalFields(response, record);

  return response;
}

export function revisionRecordToResponse(
  record: WorkflowRevisionRecord,
  originalCreatedAt: Date
): WorkflowResponse {
  const response: WorkflowResponse = {
    name: record.workflowName,
    description: record.description,
    state: record.state,
    revisionId: record.revisionId,
    createTime: originalCreatedAt.toISOString(),
    updateTime: record.createdAt.toISOString(),
    revisionCreateTime: record.revisionCreateTime,
    labels: JSON.parse(record.labels) as Record<string, string>,
    serviceAccount: record.serviceAccount,
    sourceContents: record.sourceContents,
  };

  applyOptionalFields(response, record);

  return response;
}

export function requestToWorkflowRecord(
  name: string,
  body: CreateWorkflowRequest,
  revisionId: string
): Omit<WorkflowRecord, keyof BaseRecord> {
  const now = new Date().toISOString();

  return {
    name,
    description: body.description ?? '',
    state: WorkflowState.ACTIVE,
    revisionId,
    revisionCreateTime: now,
    labels: JSON.stringify(body.labels ?? {}),
    serviceAccount: body.serviceAccount ?? '',
    sourceContents: body.sourceContents,
    cryptoKeyName: body.cryptoKeyName ?? null,
    stateError: null,
    callLogLevel: body.callLogLevel ?? CallLogLevel.CALL_LOG_LEVEL_UNSPECIFIED,
    userEnvVars: body.userEnvVars ? JSON.stringify(body.userEnvVars) : null,
    executionHistoryLevel:
      body.executionHistoryLevel ?? ExecutionHistoryLevel.EXECUTION_HISTORY_LEVEL_UNSPECIFIED,
    tags: body.tags ? JSON.stringify(body.tags) : null,
  };
}

const OPERATION_METADATA_TYPE = 'type.googleapis.com/google.cloud.workflows.v1.OperationMetadata';
const WORKFLOW_TYPE = 'type.googleapis.com/google.cloud.workflows.v1.Workflow';

export function operationRecordToResponse(record: OperationRecord): OperationResponse {
  const metadata = JSON.parse(record.metadata) as OperationMetadata;
  metadata['@type'] = OPERATION_METADATA_TYPE;

  const response: OperationResponse = {
    name: record.name,
    metadata,
    done: record.done === 1,
  };

  if (record.response) {
    const parsed = JSON.parse(record.response) as Record<string, unknown>;
    parsed['@type'] = WORKFLOW_TYPE;
    response.response = parsed;
  }

  if (record.error) {
    response.error = JSON.parse(record.error);
  }

  return response;
}
