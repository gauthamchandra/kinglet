/**
 * Execution Handlers - Unit Tests — written BEFORE implementation (TDD)
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { WorkflowRepository } from '../repository.ts';
import { ExecutionHandlers } from './handlers.ts';
import { ExecutionRepository } from './repository.ts';
import { ExecutionService } from './service.ts';

let handlers: ExecutionHandlers;

const project = 'test-project';
const location = 'us-central1';
const workflowId = 'test-workflow';

const simpleWorkflowYaml = `
main:
  params: [input]
  steps:
    - done:
        return: \${input.message}
`;

function makeRequest(
  method: string,
  params: Record<string, string>,
  query: Record<string, string> = {},
  body?: unknown
) {
  return {
    method,
    params,
    query,
    body,
    headers: { 'content-type': 'application/json' },
    url: '',
    path: '',
    originalRequest: new Request('http://localhost/test'),
  };
}

const emptyCtx = {
  requestId: 'test-req',
  startTime: Date.now(),
  routeId: 'test',
  metadata: {},
  logger: new Logger('test-ctx', 'error'),
};

function findRoute(id: string): RouteDefinition {
  const route = handlers.getRoutes().find(r => r.id === id);

  if (!route) {
    throw new Error(`Route ${id} not found`);
  }

  return route;
}

let workflowRepo: WorkflowRepository;

beforeEach(async () => {
  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  workflowRepo = new WorkflowRepository(storage);
  await workflowRepo.initialize();

  const executionRepo = new ExecutionRepository(storage);
  await executionRepo.initialize();

  const executionService = new ExecutionService(executionRepo);
  const logger = new Logger('test-exec-handlers', 'error');

  handlers = new ExecutionHandlers(executionService, workflowRepo, logger);

  // Create a workflow for tests
  await workflowRepo.createWorkflow({
    name: `projects/${project}/locations/${location}/workflows/${workflowId}`,
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

describe('ExecutionHandlers', () => {
  describe('getRoutes', () => {
    test('returns all expected execution routes', () => {
      const routes = handlers.getRoutes();
      const ids = routes.map(r => r.id);

      expect(ids).toContain('executions.create');
      expect(ids).toContain('executions.get');
      expect(ids).toContain('executions.list');
      expect(ids).toContain('executions.cancel');
      expect(routes).toHaveLength(4);
    });
  });

  describe('create execution', () => {
    test('creates and runs an execution', async () => {
      const route = findRoute('executions.create');
      const req = makeRequest(
        'POST',
        { project, location, workflowId },
        {},
        { argument: '{"input":{"message":"hello"}}' }
      );

      const res = await route.handler(req, emptyCtx);
      expect(res.status).toBe(200);

      const body = res.body as Record<string, unknown>;
      expect(body.state).toBe('SUCCEEDED');
      expect(body.result).toBe('"hello"');
    });

    test('returns 404 for non-existent workflow', async () => {
      const route = findRoute('executions.create');
      const req = makeRequest(
        'POST',
        { project, location, workflowId: 'missing' },
        {},
        { argument: '{}' }
      );

      const res = await route.handler(req, emptyCtx);
      expect(res.status).toBe(404);
    });

    test('handles workflow execution failure', async () => {
      const failingYaml = `
main:
  steps:
    - fail:
        raise: "bad"
`;
      await workflowRepo.createWorkflow({
        name: `projects/${project}/locations/${location}/workflows/failing-wf`,
        description: '',
        state: 'ACTIVE',
        revisionId: '000001-abc',
        revisionCreateTime: new Date().toISOString(),
        labels: '{}',
        serviceAccount: '',
        sourceContents: failingYaml,
        cryptoKeyName: null,
        stateError: null,
        callLogLevel: 'CALL_LOG_LEVEL_UNSPECIFIED',
        userEnvVars: null,
        executionHistoryLevel: 'EXECUTION_HISTORY_LEVEL_UNSPECIFIED',
        tags: null,
      });

      const route = findRoute('executions.create');
      const req = makeRequest(
        'POST',
        { project, location, workflowId: 'failing-wf' },
        {},
        { argument: '{}' }
      );

      const res = await route.handler(req, emptyCtx);
      expect(res.status).toBe(200);

      const body = res.body as Record<string, unknown>;
      expect(body.state).toBe('FAILED');
    });
  });

  describe('get execution', () => {
    test('retrieves a created execution', async () => {
      // Create an execution first
      const createRoute = findRoute('executions.create');
      const createReq = makeRequest(
        'POST',
        { project, location, workflowId },
        {},
        { argument: '{"input":{"message":"get-test"}}' }
      );
      const createRes = await createRoute.handler(createReq, emptyCtx);
      const created = createRes.body as Record<string, unknown>;
      const executionName = created.name as string;
      const executionId = executionName.split('/').pop() as string;

      // Get it
      const getRoute = findRoute('executions.get');
      const getReq = makeRequest('GET', { project, location, workflowId, executionId });

      const res = await getRoute.handler(getReq, emptyCtx);
      expect(res.status).toBe(200);

      const body = res.body as Record<string, unknown>;
      expect(body.name).toBe(executionName);
    });

    test('returns 404 for non-existent execution', async () => {
      const route = findRoute('executions.get');
      const req = makeRequest('GET', {
        project,
        location,
        workflowId,
        executionId: 'missing',
      });

      const res = await route.handler(req, emptyCtx);
      expect(res.status).toBe(404);
    });
  });

  describe('list executions', () => {
    test('lists executions for a workflow', async () => {
      const createRoute = findRoute('executions.create');

      await createRoute.handler(
        makeRequest(
          'POST',
          { project, location, workflowId },
          {},
          { argument: '{"input":{"message":"a"}}' }
        ),
        emptyCtx
      );
      await createRoute.handler(
        makeRequest(
          'POST',
          { project, location, workflowId },
          {},
          { argument: '{"input":{"message":"b"}}' }
        ),
        emptyCtx
      );

      const listRoute = findRoute('executions.list');
      const res = await listRoute.handler(
        makeRequest('GET', { project, location, workflowId }),
        emptyCtx
      );

      expect(res.status).toBe(200);

      const body = res.body as Record<string, unknown>;
      expect(body.executions).toHaveLength(2);
    });
  });

  describe('cancel execution', () => {
    test('returns 404 for non-existent execution', async () => {
      const route = findRoute('executions.cancel');
      const req = makeRequest('POST', {
        project,
        location,
        workflowId,
        executionId: 'missing',
      });

      const res = await route.handler(req, emptyCtx);
      expect(res.status).toBe(404);
    });
  });
});
