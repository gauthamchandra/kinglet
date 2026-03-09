/**
 * Execution repository tests — written BEFORE implementation (TDD)
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { ExecutionRepository } from './repository.ts';
import { ExecutionState } from './types.ts';

let storage: StorageManager;
let repo: ExecutionRepository;

const workflowName = 'projects/my-project/locations/us-central1/workflows/my-workflow';

function makeExecution(executionId: string, overrides?: Record<string, unknown>) {
  return {
    name: `${workflowName}/executions/${executionId}`,
    workflowName,
    state: ExecutionState.SUCCEEDED,
    argument: '{}',
    result: '"ok"',
    error: null,
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    workflowRevisionId: '000001-abc',
    callLogLevel: 'CALL_LOG_LEVEL_UNSPECIFIED',
    duration: '0.5s',
    ...overrides,
  };
}

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  repo = new ExecutionRepository(storage);
  await repo.initialize();
});

describe('ExecutionRepository', () => {
  test('creates and retrieves an execution', async () => {
    const data = makeExecution('exec-1');
    const created = await repo.createExecution(data);
    expect(created.name).toBe(data.name);
    expect(created.state).toBe(ExecutionState.SUCCEEDED);

    const fetched = await repo.getExecutionByName(data.name);
    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe(data.name);
  });

  test('returns null for non-existent execution', async () => {
    const result = await repo.getExecutionByName(`${workflowName}/executions/missing`);
    expect(result).toBeNull();
  });

  test('lists executions for a workflow', async () => {
    await repo.createExecution(makeExecution('exec-1'));
    await repo.createExecution(makeExecution('exec-2'));
    await repo.createExecution(makeExecution('exec-3'));

    const result = await repo.listExecutions(workflowName);
    expect(result.executions).toHaveLength(3);
  });

  test('lists executions with pagination', async () => {
    await repo.createExecution(makeExecution('exec-1'));
    await repo.createExecution(makeExecution('exec-2'));
    await repo.createExecution(makeExecution('exec-3'));

    const page1 = await repo.listExecutions(workflowName, 2);
    expect(page1.executions).toHaveLength(2);
    expect(page1.nextPageToken).toBeDefined();

    const page2 = await repo.listExecutions(workflowName, 2, page1.nextPageToken);
    expect(page2.executions).toHaveLength(1);
    expect(page2.nextPageToken).toBeUndefined();
  });

  test('updates an execution', async () => {
    await repo.createExecution(makeExecution('exec-1', { state: ExecutionState.ACTIVE }));

    const updated = await repo.updateExecution(`${workflowName}/executions/exec-1`, {
      state: ExecutionState.CANCELLED,
      endTime: new Date().toISOString(),
    });

    expect(updated).not.toBeNull();
    expect(updated?.state).toBe(ExecutionState.CANCELLED);
  });

  test('update returns null for non-existent execution', async () => {
    const result = await repo.updateExecution(`${workflowName}/executions/missing`, {
      state: ExecutionState.CANCELLED,
    });
    expect(result).toBeNull();
  });
});
