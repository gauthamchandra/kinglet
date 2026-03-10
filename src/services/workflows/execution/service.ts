/**
 * Execution Service — business logic for creating, running, and managing workflow executions
 */

import type { BaseRecord } from '@/core/storage/types.ts';
import { WorkflowEngine } from './engine.ts';
import type { ExecutionRepository, ListExecutionsResult } from './repository.ts';
import type { ExecutionRecord } from './types.ts';
import { buildExecutionEnvVars, buildExecutionName, ExecutionState } from './types.ts';

export class ExecutionService {
  private repository: ExecutionRepository;

  constructor(repository: ExecutionRepository) {
    this.repository = repository;
  }

  async createExecution(
    project: string,
    location: string,
    workflowId: string,
    revisionId: string,
    sourceContents: string,
    args: Record<string, unknown>,
    userEnvVars?: Record<string, string>,
    callLogLevel?: string
  ): Promise<ExecutionRecord> {
    const executionId = crypto.randomUUID();
    const name = buildExecutionName(project, location, workflowId, executionId);
    const startTime = new Date();

    const envVars = buildExecutionEnvVars(
      project,
      location,
      workflowId,
      revisionId,
      executionId,
      userEnvVars
    );

    const engine = new WorkflowEngine(sourceContents, { envVars });
    const result = await engine.execute(args);
    const endTime = new Date();

    const durationMs = endTime.getTime() - startTime.getTime();
    const durationStr = `${(durationMs / 1000).toFixed(6)}s`;

    const executionData: Omit<ExecutionRecord, keyof BaseRecord> = {
      name,
      workflowName: `projects/${project}/locations/${location}/workflows/${workflowId}`,
      state: result.state,
      argument: JSON.stringify(args),
      result: result.state === ExecutionState.SUCCEEDED ? JSON.stringify(result.output) : null,
      error: result.error
        ? JSON.stringify({ payload: JSON.stringify(result.error), context: '' })
        : null,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      workflowRevisionId: revisionId,
      callLogLevel: callLogLevel ?? 'CALL_LOG_LEVEL_UNSPECIFIED',
      duration: durationStr,
    };

    return this.repository.createExecution(executionData);
  }

  async getExecution(name: string): Promise<ExecutionRecord | null> {
    return this.repository.getExecutionByName(name);
  }

  async listExecutions(
    workflowName: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListExecutionsResult> {
    return this.repository.listExecutions(workflowName, pageSize, pageToken);
  }

  async cancelExecution(
    name: string
  ): Promise<
    { record: ExecutionRecord } | { error: 'not_found' | 'not_cancellable'; state?: string }
  > {
    const execution = await this.repository.getExecutionByName(name);

    if (!execution) {
      return { error: 'not_found' };
    }

    if (execution.state !== ExecutionState.ACTIVE) {
      return { error: 'not_cancellable', state: execution.state };
    }

    const updated = await this.repository.updateExecution(name, {
      state: ExecutionState.CANCELLED,
      endTime: new Date().toISOString(),
    });

    if (!updated) {
      return { error: 'not_found' };
    }

    return { record: updated };
  }
}
