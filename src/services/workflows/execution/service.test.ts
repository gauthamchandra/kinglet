/**
 * Execution service tests — written BEFORE implementation (TDD)
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { WorkflowRepository } from '../repository.ts';
import { ExecutionRepository } from './repository.ts';
import { ExecutionService } from './service.ts';
import { ExecutionState } from './types.ts';

let storage: StorageManager;
let workflowRepo: WorkflowRepository;
let executionRepo: ExecutionRepository;
let service: ExecutionService;

const project = 'my-project';
const location = 'us-central1';
const workflowId = 'my-workflow';
const workflowName = `projects/${project}/locations/${location}/workflows/${workflowId}`;

const simpleWorkflowYaml = `
main:
  params: [input]
  steps:
    - done:
        return: \${input.message}
`;

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  workflowRepo = new WorkflowRepository(storage);
  await workflowRepo.initialize();

  executionRepo = new ExecutionRepository(storage);
  await executionRepo.initialize();

  service = new ExecutionService(executionRepo);

  // Create a workflow in storage for tests
  await workflowRepo.createWorkflow({
    name: workflowName,
    description: 'Test workflow',
    state: 'ACTIVE',
    revisionId: '000001-abc',
    revisionCreateTime: new Date().toISOString(),
    labels: '{}',
    serviceAccount: '',
    sourceContents: simpleWorkflowYaml,
    cryptoKeyName: null,
    stateError: null,
    callLogLevel: 'CALL_LOG_LEVEL_UNSPECIFIED',
    userEnvVars: null,
    executionHistoryLevel: 'EXECUTION_HISTORY_LEVEL_UNSPECIFIED',
    tags: null,
  });
});

describe('ExecutionService', () => {
  test('creates and runs an execution successfully', async () => {
    const execution = await service.createExecution(
      project,
      location,
      workflowId,
      '000001-abc',
      simpleWorkflowYaml,
      { input: { message: 'hello' } }
    );

    expect(execution.state).toBe(ExecutionState.SUCCEEDED);
    expect(execution.result).toBe('"hello"');
    expect(execution.name).toContain(`${workflowName}/executions/`);
    expect(execution.workflowRevisionId).toBe('000001-abc');
    expect(execution.startTime).toBeTruthy();
    expect(execution.endTime).toBeTruthy();
  });

  test('creates a failed execution when workflow raises', async () => {
    const failingYaml = `
main:
  steps:
    - fail:
        raise: "bad input"
`;

    const execution = await service.createExecution(
      project,
      location,
      workflowId,
      '000001-abc',
      failingYaml,
      {}
    );

    expect(execution.state).toBe(ExecutionState.FAILED);
    expect(execution.error).not.toBeNull();
    expect(execution.result).toBeNull();
  });

  test('gets an execution by name', async () => {
    const created = await service.createExecution(
      project,
      location,
      workflowId,
      '000001-abc',
      simpleWorkflowYaml,
      { input: { message: 'test' } }
    );

    const fetched = await service.getExecution(created.name);
    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe(created.name);
    expect(fetched?.state).toBe(ExecutionState.SUCCEEDED);
  });

  test('returns null for non-existent execution', async () => {
    const result = await service.getExecution(`${workflowName}/executions/missing`);
    expect(result).toBeNull();
  });

  test('lists executions for a workflow', async () => {
    await service.createExecution(project, location, workflowId, '000001-abc', simpleWorkflowYaml, {
      input: { message: 'a' },
    });
    await service.createExecution(project, location, workflowId, '000001-abc', simpleWorkflowYaml, {
      input: { message: 'b' },
    });

    const result = await service.listExecutions(workflowName);
    expect(result.executions).toHaveLength(2);
  });

  test('cancels an active execution', async () => {
    // Create a SUCCEEDED execution (we can't truly test active since execution is sync)
    const created = await service.createExecution(
      project,
      location,
      workflowId,
      '000001-abc',
      simpleWorkflowYaml,
      { input: { message: 'x' } }
    );

    // Since execution is synchronous, the execution is already complete.
    // Cancel should fail for completed executions.
    const result = await service.cancelExecution(created.name);
    // Already completed — cannot cancel
    expect(result).toBeNull();
  });

  test('execution includes duration', async () => {
    const execution = await service.createExecution(
      project,
      location,
      workflowId,
      '000001-abc',
      simpleWorkflowYaml,
      { input: { message: 'test' } }
    );

    expect(execution.duration).toBeTruthy();
    expect(execution.duration).toMatch(/^\d+\.\d+s$/);
  });

  test('provides correct env vars to workflow', async () => {
    const envYaml = `
main:
  steps:
    - getEnv:
        call: sys.get_env
        args:
          name: "GOOGLE_CLOUD_PROJECT_ID"
        result: projectId
    - done:
        return: \${projectId}
`;

    const execution = await service.createExecution(
      project,
      location,
      workflowId,
      '000001-abc',
      envYaml,
      {}
    );

    expect(execution.state).toBe(ExecutionState.SUCCEEDED);
    expect(execution.result).toBe('"my-project"');
  });
});
