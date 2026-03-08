/**
 * Workflow Handlers - Unit Tests
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { WorkflowHandlers } from './handlers.ts';
import { OperationsStore } from './operations.ts';
import { WorkflowRepository } from './repository.ts';
import { WorkflowService } from './service.ts';

let handlers: WorkflowHandlers;

const project = 'test-project';
const location = 'us-central1';
const workflowId = 'test-workflow';

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

beforeEach(async () => {
  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const repo = new WorkflowRepository(storage);
  await repo.initialize();

  const opsStore = new OperationsStore(storage);
  await opsStore.initialize();

  const service = new WorkflowService(repo, opsStore);
  const logger = new Logger('test-handlers', 'error');

  handlers = new WorkflowHandlers(service, opsStore, logger);
});

describe('getRoutes', () => {
  test('returns all expected route definitions', () => {
    const routes = handlers.getRoutes();
    const ids = routes.map(r => r.id);

    expect(ids).toContain('workflows.create');
    expect(ids).toContain('workflows.get');
    expect(ids).toContain('workflows.list');
    expect(ids).toContain('workflows.update');
    expect(ids).toContain('workflows.delete');
    expect(ids).toContain('workflows.revisions.list');
    expect(ids).toContain('workflows.operations.list');
    expect(ids).toContain('workflows.operations.get');
    expect(ids).toContain('workflows.operations.delete');
    expect(ids).toContain('workflows.locations.list');
    expect(ids).toContain('workflows.locations.get');
    expect(routes).toHaveLength(11);
  });
});

describe('workflow CRUD handlers', () => {
  test('create workflow returns Operation with done:true', async () => {
    const route = findRoute('workflows.create');

    const req = makeRequest(
      'POST',
      { project, location },
      { workflowId },
      { sourceContents: 'main:\n  steps: []' }
    );

    const res = await route.handler(req, emptyCtx);

    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;

    expect(body.done).toBe(true);
    expect(body.metadata).toBeDefined();

    const response = body.response as Record<string, unknown>;

    expect(response.name).toBe(`projects/${project}/locations/${location}/workflows/${workflowId}`);
    expect(response.state).toBe('ACTIVE');
  });

  test('create workflow extracts workflowId from body.name', async () => {
    const route = findRoute('workflows.create');

    const req = makeRequest(
      'POST',
      { project, location },
      {},
      {
        name: `projects/${project}/locations/${location}/workflows/from-name`,
        sourceContents: 'main: {}',
      }
    );

    const res = await route.handler(req, emptyCtx);

    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;
    const response = body.response as Record<string, unknown>;

    expect(response.name).toContain('from-name');
  });

  test('get workflow returns 200', async () => {
    const createRoute = findRoute('workflows.create');
    const getRoute = findRoute('workflows.get');

    await createRoute.handler(
      makeRequest('POST', { project, location }, { workflowId }, { sourceContents: 'main: {}' }),
      emptyCtx
    );

    const res = await getRoute.handler(
      makeRequest('GET', { project, location, workflowId }),
      emptyCtx
    );

    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;

    expect(body.name).toBe(`projects/${project}/locations/${location}/workflows/${workflowId}`);
  });

  test('get nonexistent workflow returns 404', async () => {
    const route = findRoute('workflows.get');

    const res = await route.handler(
      makeRequest('GET', { project, location, workflowId: 'nonexistent' }),
      emptyCtx
    );

    expect(res.status).toBe(404);
  });

  test('list workflows returns array', async () => {
    const createRoute = findRoute('workflows.create');
    const listRoute = findRoute('workflows.list');

    await createRoute.handler(
      makeRequest('POST', { project, location }, { workflowId: 'wf-1' }, { sourceContents: 'a' }),
      emptyCtx
    );

    const res = await listRoute.handler(makeRequest('GET', { project, location }), emptyCtx);

    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;
    const workflows = body.workflows as unknown[];

    expect(workflows).toHaveLength(1);
  });

  test('update workflow returns Operation', async () => {
    const createRoute = findRoute('workflows.create');
    const updateRoute = findRoute('workflows.update');

    await createRoute.handler(
      makeRequest('POST', { project, location }, { workflowId }, { sourceContents: 'main: {}' }),
      emptyCtx
    );

    const res = await updateRoute.handler(
      makeRequest('PATCH', { project, location, workflowId }, {}, { description: 'Updated' }),
      emptyCtx
    );

    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;

    expect(body.done).toBe(true);
    expect(body.metadata).toBeDefined();
  });

  test('delete workflow returns Operation', async () => {
    const createRoute = findRoute('workflows.create');
    const deleteRoute = findRoute('workflows.delete');

    await createRoute.handler(
      makeRequest('POST', { project, location }, { workflowId }, { sourceContents: 'main: {}' }),
      emptyCtx
    );

    const res = await deleteRoute.handler(
      makeRequest('DELETE', { project, location, workflowId }),
      emptyCtx
    );

    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;

    expect(body.done).toBe(true);
    expect(body.metadata).toBeDefined();
  });
});

describe('operations handlers', () => {
  test('list operations returns operations created by workflow CRUD', async () => {
    const createRoute = findRoute('workflows.create');
    const listOpsRoute = findRoute('workflows.operations.list');

    await createRoute.handler(
      makeRequest('POST', { project, location }, { workflowId }, { sourceContents: 'main: {}' }),
      emptyCtx
    );

    const res = await listOpsRoute.handler(makeRequest('GET', { project, location }), emptyCtx);

    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;
    const operations = body.operations as unknown[];

    expect(operations.length).toBeGreaterThanOrEqual(1);
  });

  test('get operation returns 404 for nonexistent', async () => {
    const route = findRoute('workflows.operations.get');

    const res = await route.handler(
      makeRequest('GET', { project, location, operationId: 'nonexistent' }),
      emptyCtx
    );

    expect(res.status).toBe(404);
  });

  test('delete operation returns 404 for nonexistent', async () => {
    const route = findRoute('workflows.operations.delete');

    const res = await route.handler(
      makeRequest('DELETE', { project, location, operationId: 'nonexistent' }),
      emptyCtx
    );

    expect(res.status).toBe(404);
  });
});

describe('locations handlers', () => {
  test('list locations returns all GCP regions', async () => {
    const route = findRoute('workflows.locations.list');

    const res = await route.handler(makeRequest('GET', { project }), emptyCtx);

    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;
    const locations = body.locations as unknown[];

    expect(locations.length).toBeGreaterThan(0);
  });

  test('get location returns known location', async () => {
    const route = findRoute('workflows.locations.get');

    const res = await route.handler(
      makeRequest('GET', { project, location: 'us-central1' }),
      emptyCtx
    );

    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;

    expect(body.locationId).toBe('us-central1');
    expect(body.displayName).toBe('Council Bluffs, Iowa, USA');
  });

  test('get unknown location returns 404', async () => {
    const route = findRoute('workflows.locations.get');

    const res = await route.handler(
      makeRequest('GET', { project, location: 'antarctica-south1' }),
      emptyCtx
    );

    expect(res.status).toBe(404);
  });
});

describe('revisions handler', () => {
  test('list revisions returns revisions after create and update', async () => {
    const createRoute = findRoute('workflows.create');
    const updateRoute = findRoute('workflows.update');
    const revisionsRoute = findRoute('workflows.revisions.list');

    await createRoute.handler(
      makeRequest('POST', { project, location }, { workflowId }, { sourceContents: 'v1' }),
      emptyCtx
    );

    await updateRoute.handler(
      makeRequest('PATCH', { project, location, workflowId }, {}, { sourceContents: 'v2' }),
      emptyCtx
    );

    const res = await revisionsRoute.handler(
      makeRequest('GET', { project, location, workflowId }),
      emptyCtx
    );

    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;
    const workflows = body.workflows as Array<Record<string, unknown>>;

    expect(workflows).toHaveLength(2);
    expect((workflows[0]?.revisionId as string).startsWith('000002')).toBe(true);
    expect((workflows[1]?.revisionId as string).startsWith('000001')).toBe(true);
  });
});
