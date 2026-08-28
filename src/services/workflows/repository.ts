/**
 * Workflow Repository - persistence layer wrapping StorageManager
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { DEFAULT_LIST_PAGE_SIZE, parseOffsetToken } from '@/shared/utils/pagination.ts';
import type { WorkflowRecord, WorkflowRevisionRecord } from './types.ts';
import {
  WORKFLOW_REVISIONS_TABLE,
  WORKFLOWS_TABLE,
  workflowRevisionsTableSchema,
  workflowsTableSchema,
} from './types.ts';

export interface ListWorkflowsResult {
  workflows: WorkflowRecord[];
  nextPageToken?: string | undefined;
}

export interface ListRevisionsResult {
  revisions: WorkflowRevisionRecord[];
  nextPageToken?: string | undefined;
}

export class WorkflowRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(WORKFLOWS_TABLE, workflowsTableSchema);
    await this.storage.createTable(WORKFLOW_REVISIONS_TABLE, workflowRevisionsTableSchema);
  }

  async createWorkflow(data: Omit<WorkflowRecord, keyof BaseRecord>): Promise<WorkflowRecord> {
    const existing = await this.getWorkflowByName(data.name);

    if (existing) {
      throw new Error(`Workflow ${data.name} already exists`);
    }

    return this.storage.create<WorkflowRecord>(WORKFLOWS_TABLE, data);
  }

  async createRevision(
    data: Omit<WorkflowRevisionRecord, keyof BaseRecord>
  ): Promise<WorkflowRevisionRecord> {
    return this.storage.create<WorkflowRevisionRecord>(WORKFLOW_REVISIONS_TABLE, data);
  }

  async getWorkflowByName(name: string): Promise<WorkflowRecord | null> {
    return this.storage.findFirst<WorkflowRecord>(WORKFLOWS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }

  async getWorkflowRevision(
    workflowName: string,
    revisionId: string
  ): Promise<WorkflowRevisionRecord | null> {
    return this.storage.findFirst<WorkflowRevisionRecord>(WORKFLOW_REVISIONS_TABLE, {
      filter: {
        conditions: [
          { field: 'workflowName', operator: 'eq', value: workflowName },
          { field: 'revisionId', operator: 'eq', value: revisionId },
        ],
        operator: 'and',
      },
    });
  }

  async listWorkflows(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListWorkflowsResult> {
    const prefix = `projects/${project}/locations/${location}/workflows/`;

    const offset = parseOffsetToken(pageToken);
    const limit = pageSize ?? DEFAULT_LIST_PAGE_SIZE;

    const result = await this.storage.find<WorkflowRecord>(WORKFLOWS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'like', value: `${prefix}%` }],
      },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    const nextPageToken = result.hasMore ? String(offset + limit) : undefined;

    return {
      workflows: result.data,
      nextPageToken,
    };
  }

  async countRevisions(workflowName: string): Promise<number> {
    return this.storage.count(WORKFLOW_REVISIONS_TABLE, {
      conditions: [{ field: 'workflowName', operator: 'eq', value: workflowName }],
    });
  }

  async listRevisions(
    workflowName: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListRevisionsResult> {
    const offset = parseOffsetToken(pageToken);
    const limit = pageSize ?? DEFAULT_LIST_PAGE_SIZE;

    const result = await this.storage.find<WorkflowRevisionRecord>(WORKFLOW_REVISIONS_TABLE, {
      filter: {
        conditions: [{ field: 'workflowName', operator: 'eq', value: workflowName }],
      },
      pagination: { limit, offset },
      sort: [{ field: 'revisionId', direction: 'desc' }],
    });

    const nextPageToken = result.hasMore ? String(offset + limit) : undefined;

    return {
      revisions: result.data,
      nextPageToken,
    };
  }

  async updateWorkflow(
    name: string,
    data: Partial<Omit<WorkflowRecord, keyof BaseRecord>>
  ): Promise<WorkflowRecord | null> {
    const existing = await this.getWorkflowByName(name);

    if (!existing) {
      return null;
    }

    return this.storage.updateById<WorkflowRecord>(WORKFLOWS_TABLE, existing.id, data);
  }

  async deleteWorkflow(name: string): Promise<boolean> {
    const existing = await this.getWorkflowByName(name);

    if (!existing) {
      return false;
    }

    // Delete all revisions for this workflow
    await this.storage.deleteMany(WORKFLOW_REVISIONS_TABLE, {
      conditions: [{ field: 'workflowName', operator: 'eq', value: name }],
    });

    return this.storage.deleteById(WORKFLOWS_TABLE, existing.id);
  }
}
