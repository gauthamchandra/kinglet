/**
 * Execution-related types, table schemas, and helper functions
 */

import type { BaseRecord, TableSchema } from '@/core/storage/types.ts';

// ── Constants ──

export const EXECUTIONS_TABLE = 'workflow_executions';

export const ExecutionState = {
  ACTIVE: 'ACTIVE',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;

export type ExecutionStateValue = (typeof ExecutionState)[keyof typeof ExecutionState];

export const CALL_STACK_DEPTH_LIMIT = 20;

// ── Error Tags ──

export const ErrorTag = {
  AuthError: 'AuthError',
  ConnectionError: 'ConnectionError',
  HttpError: 'HttpError',
  IndexError: 'IndexError',
  KeyError: 'KeyError',
  OperationError: 'OperationError',
  ParallelNestingError: 'ParallelNestingError',
  RecursionError: 'RecursionError',
  ResourceLimitError: 'ResourceLimitError',
  ResponseTypeError: 'ResponseTypeError',
  SystemError: 'SystemError',
  TimeoutError: 'TimeoutError',
  TypeError: 'TypeError',
  UnhandledBranchError: 'UnhandledBranchError',
  ValueError: 'ValueError',
  ZeroDivisionError: 'ZeroDivisionError',
} as const;

// ── Workflow Error ──

export class WorkflowRuntimeError extends Error {
  readonly tags: string[];
  readonly errorCode: number;

  constructor(message: string, tags: string[], errorCode = 0) {
    super(message);
    this.name = 'WorkflowRuntimeError';
    this.tags = tags;
    this.errorCode = errorCode;
  }

  toErrorObject(): WorkflowErrorObject {
    return {
      message: this.message,
      tags: this.tags,
      code: this.errorCode,
    };
  }
}

export interface WorkflowErrorObject {
  message: string;
  tags: string[];
  code: number;
}

// ── Execution Interfaces ──

export interface ExecutionResponse {
  name: string;
  state: string;
  argument: string;
  result: string;
  error?: ExecutionResponseError;
  startTime: string;
  endTime: string;
  workflowRevisionId: string;
  callLogLevel: string;
  duration?: string;
}

export interface ExecutionResponseError {
  payload: string;
  context: string;
  stackTrace?: ExecutionStackTrace;
}

export interface ExecutionStackTrace {
  elements: StackTraceElement[];
}

export interface StackTraceElement {
  step: string;
  routine: string;
  position: number;
}

// ── Storage Record ──

export interface ExecutionRecord extends BaseRecord {
  name: string;
  workflowName: string;
  state: string;
  argument: string;
  result: string | null;
  error: string | null; // JSON-serialized ExecutionResponseError
  startTime: string;
  endTime: string | null;
  workflowRevisionId: string;
  callLogLevel: string;
  duration: string | null;
}

// ── Table Schema ──

export const executionsTableSchema: TableSchema = {
  name: EXECUTIONS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'workflowName', type: 'string' },
    { name: 'state', type: 'string' },
    { name: 'argument', type: 'string' },
    { name: 'result', type: 'string', nullable: true },
    { name: 'error', type: 'json', nullable: true },
    { name: 'startTime', type: 'string' },
    { name: 'endTime', type: 'string', nullable: true },
    { name: 'workflowRevisionId', type: 'string' },
    { name: 'callLogLevel', type: 'string' },
    { name: 'duration', type: 'string', nullable: true },
  ],
  indexes: [
    { name: 'idx_executions_name', columns: ['name'], unique: true },
    { name: 'idx_executions_workflow', columns: ['workflowName'] },
    { name: 'idx_executions_state', columns: ['state'] },
  ],
  timestamps: true,
};

// ── Helper Functions ──

export function buildExecutionName(
  project: string,
  location: string,
  workflowId: string,
  executionId: string
): string {
  return `projects/${project}/locations/${location}/workflows/${workflowId}/executions/${executionId}`;
}

// ── Conversion Functions ──

export function executionRecordToResponse(record: ExecutionRecord): ExecutionResponse {
  const response: ExecutionResponse = {
    name: record.name,
    state: record.state,
    argument: record.argument,
    result: record.result ?? '',
    startTime: record.startTime,
    endTime: record.endTime ?? '',
    workflowRevisionId: record.workflowRevisionId,
    callLogLevel: record.callLogLevel,
  };

  if (record.error) {
    response.error = JSON.parse(record.error) as ExecutionResponseError;
  }

  if (record.duration) {
    response.duration = record.duration;
  }

  return response;
}

// ── Environment Variables ──

export function buildExecutionEnvVars(
  project: string,
  location: string,
  workflowId: string,
  revisionId: string,
  executionId: string,
  userEnvVars?: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {
    GOOGLE_CLOUD_PROJECT_NUMBER: '123456789',
    GOOGLE_CLOUD_PROJECT_ID: project,
    GOOGLE_CLOUD_LOCATION: location,
    GOOGLE_CLOUD_WORKFLOW_ID: workflowId,
    GOOGLE_CLOUD_WORKFLOW_REVISION_ID: revisionId,
    GOOGLE_CLOUD_WORKFLOW_EXECUTION_ID: executionId,
  };

  if (userEnvVars) {
    Object.assign(env, userEnvVars);
  }

  return env;
}

// ── Engine Types ──

export interface VariableScope {
  variables: Record<string, unknown>;
}

export interface WorkflowDefinition {
  main: WorkflowBlock;
  subworkflows: Record<string, WorkflowBlock>;
}

export interface WorkflowBlock {
  params?: string[] | Array<Record<string, unknown>>;
  steps: WorkflowStep[];
}

export interface WorkflowStep {
  name: string;
  body: Record<string, unknown>;
}

export interface EngineResult {
  output: unknown;
  state: ExecutionStateValue;
  error?: WorkflowErrorObject;
}
