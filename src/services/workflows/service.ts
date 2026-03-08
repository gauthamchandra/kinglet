/**
 * Workflow Service - business logic for Cloud Workflows CRUD and revision management
 */

import type { OperationsStore } from './operations.ts';
import type { WorkflowRepository } from './repository.ts';
import type { OperationResponse, WorkflowResponse } from './types.ts';
import {
  buildWorkflowName,
  CreateWorkflowRequestSchema,
  generateRevisionId,
  requestToWorkflowRecord,
  revisionRecordToResponse,
  UpdateWorkflowRequestSchema,
  workflowRecordToResponse,
} from './types.ts';

export type WorkflowsErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_ARGUMENT'
  | 'FAILED_PRECONDITION';

export class WorkflowsError extends Error {
  readonly code: WorkflowsErrorCode;

  constructor(code: WorkflowsErrorCode, message: string) {
    super(message);
    this.name = 'WorkflowsError';
    this.code = code;
  }
}

export interface ListWorkflowsServiceResponse {
  workflows: WorkflowResponse[];
  nextPageToken?: string | undefined;
}

export interface ListRevisionsServiceResponse {
  workflows: WorkflowResponse[];
  nextPageToken?: string | undefined;
}

export class WorkflowService {
  private repo: WorkflowRepository;
  private operations: OperationsStore;

  constructor(repo: WorkflowRepository, operations: OperationsStore) {
    this.repo = repo;
    this.operations = operations;
  }

  async createWorkflow(
    project: string,
    location: string,
    workflowId: string,
    body: unknown
  ): Promise<OperationResponse> {
    const parsed = CreateWorkflowRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new WorkflowsError(
        'INVALID_ARGUMENT',
        `Invalid workflow request: ${parsed.error.message}`
      );
    }

    if (!workflowId) {
      throw new WorkflowsError('INVALID_ARGUMENT', 'workflowId is required');
    }

    const request = parsed.data;
    const name = buildWorkflowName(project, location, workflowId);

    const existing = await this.repo.getWorkflowByName(name);

    if (existing) {
      throw new WorkflowsError('ALREADY_EXISTS', `Workflow ${name} already exists`);
    }

    const revisionId = generateRevisionId(1);

    const record = await this.repo.createWorkflow(
      requestToWorkflowRecord(name, request, revisionId)
    );

    // Create first revision snapshot
    await this.repo.createRevision({
      workflowName: name,
      revisionId,
      description: record.description,
      state: record.state,
      revisionCreateTime: record.revisionCreateTime,
      labels: record.labels,
      serviceAccount: record.serviceAccount,
      sourceContents: record.sourceContents,
      cryptoKeyName: record.cryptoKeyName,
      stateError: record.stateError,
      callLogLevel: record.callLogLevel,
      userEnvVars: record.userEnvVars,
      executionHistoryLevel: record.executionHistoryLevel,
      tags: record.tags,
    });

    const workflowResponse = workflowRecordToResponse(record);

    return this.operations.createOperation(project, location, name, 'create', workflowResponse);
  }

  async getWorkflow(name: string, revisionId?: string): Promise<WorkflowResponse> {
    if (revisionId) {
      const revision = await this.repo.getWorkflowRevision(name, revisionId);

      if (!revision) {
        throw new WorkflowsError('NOT_FOUND', `Workflow revision ${name}@${revisionId} not found`);
      }

      // We need the original workflow's createTime
      const workflow = await this.repo.getWorkflowByName(name);
      const originalCreatedAt = workflow?.createdAt ?? revision.createdAt;

      return revisionRecordToResponse(revision, originalCreatedAt);
    }

    const record = await this.repo.getWorkflowByName(name);

    if (!record) {
      throw new WorkflowsError('NOT_FOUND', `Workflow ${name} not found`);
    }

    return workflowRecordToResponse(record);
  }

  async listWorkflows(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListWorkflowsServiceResponse> {
    const result = await this.repo.listWorkflows(project, location, pageSize, pageToken);

    return {
      workflows: result.workflows.map(workflowRecordToResponse),
      nextPageToken: result.nextPageToken,
    };
  }

  // Note: updateMask is accepted for API compatibility but not enforced.
  // All provided fields are applied regardless of the mask value.
  async updateWorkflow(
    name: string,
    body: unknown,
    _updateMask?: string
  ): Promise<OperationResponse> {
    const parsed = UpdateWorkflowRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new WorkflowsError(
        'INVALID_ARGUMENT',
        `Invalid update request: ${parsed.error.message}`
      );
    }

    const existing = await this.repo.getWorkflowByName(name);

    if (!existing) {
      throw new WorkflowsError('NOT_FOUND', `Workflow ${name} not found`);
    }

    const request = parsed.data;
    const updates: Record<string, unknown> = {};
    let needsNewRevision = false;

    if (request.sourceContents !== undefined) {
      updates.sourceContents = request.sourceContents;
      needsNewRevision = true;
    }

    if (request.serviceAccount !== undefined) {
      updates.serviceAccount = request.serviceAccount;
      needsNewRevision = true;
    }

    if (request.description !== undefined) {
      updates.description = request.description;
    }

    if (request.labels !== undefined) {
      updates.labels = JSON.stringify(request.labels);
    }

    if (request.cryptoKeyName !== undefined) {
      updates.cryptoKeyName = request.cryptoKeyName;
    }

    if (request.callLogLevel !== undefined) {
      updates.callLogLevel = request.callLogLevel;
    }

    if (request.userEnvVars !== undefined) {
      updates.userEnvVars = JSON.stringify(request.userEnvVars);
    }

    if (request.executionHistoryLevel !== undefined) {
      updates.executionHistoryLevel = request.executionHistoryLevel;
    }

    if (request.tags !== undefined) {
      updates.tags = JSON.stringify(request.tags);
    }

    if (needsNewRevision) {
      const revisionCount = await this.repo.countRevisions(name);
      const ordinal = revisionCount + 1;
      const newRevisionId = generateRevisionId(ordinal);
      const now = new Date().toISOString();

      updates.revisionId = newRevisionId;
      updates.revisionCreateTime = now;

      const updated = await this.repo.updateWorkflow(name, updates);

      if (!updated) {
        throw new WorkflowsError('NOT_FOUND', `Workflow ${name} not found`);
      }

      // Create revision snapshot
      await this.repo.createRevision({
        workflowName: name,
        revisionId: newRevisionId,
        description: updated.description,
        state: updated.state,
        revisionCreateTime: now,
        labels: updated.labels,
        serviceAccount: updated.serviceAccount,
        sourceContents: updated.sourceContents,
        cryptoKeyName: updated.cryptoKeyName,
        stateError: updated.stateError,
        callLogLevel: updated.callLogLevel,
        userEnvVars: updated.userEnvVars,
        executionHistoryLevel: updated.executionHistoryLevel,
        tags: updated.tags,
      });

      const { project, location } = parseNameComponents(name);
      const workflowResponse = workflowRecordToResponse(updated);

      return this.operations.createOperation(project, location, name, 'update', workflowResponse);
    }

    // No new revision needed — just update the record
    const updated = await this.repo.updateWorkflow(name, updates);

    if (!updated) {
      throw new WorkflowsError('NOT_FOUND', `Workflow ${name} not found`);
    }

    const { project, location } = parseNameComponents(name);
    const workflowResponse = workflowRecordToResponse(updated);

    return this.operations.createOperation(project, location, name, 'update', workflowResponse);
  }

  async deleteWorkflow(name: string): Promise<OperationResponse> {
    const existing = await this.repo.getWorkflowByName(name);

    if (!existing) {
      throw new WorkflowsError('NOT_FOUND', `Workflow ${name} not found`);
    }

    const deleted = await this.repo.deleteWorkflow(name);

    if (!deleted) {
      throw new WorkflowsError('NOT_FOUND', `Workflow ${name} not found`);
    }

    const { project, location } = parseNameComponents(name);

    return this.operations.createOperation(project, location, name, 'delete');
  }

  async listRevisions(
    workflowName: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListRevisionsServiceResponse> {
    // Verify workflow exists
    const workflow = await this.repo.getWorkflowByName(workflowName);

    if (!workflow) {
      throw new WorkflowsError('NOT_FOUND', `Workflow ${workflowName} not found`);
    }

    const result = await this.repo.listRevisions(workflowName, pageSize, pageToken);

    return {
      workflows: result.revisions.map(rev => revisionRecordToResponse(rev, workflow.createdAt)),
      nextPageToken: result.nextPageToken,
    };
  }
}

function parseNameComponents(name: string): { project: string; location: string } {
  const match = name.match(/^projects\/([^/]+)\/locations\/([^/]+)\//);

  if (!match) {
    throw new Error(`Cannot parse project/location from name: ${name}`);
  }

  return { project: match[1] as string, location: match[2] as string };
}
