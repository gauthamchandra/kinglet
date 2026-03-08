/**
 * End-to-End Test: Cloud Workflows Lifecycle
 *
 * Black-box tests validating the full workflow lifecycle through HTTP.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { Server } from 'bun';
import { WorkflowsClient } from '@google-cloud/workflows';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { CloudWorkflowsService } from '@/services/workflows/index.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { buildRouter, createFakeAuth } from './e2e-helpers.ts';

// ── Test Infrastructure ──

let emulatorServer: Server;
let emulatorPort: number;
let workflowsService: CloudWorkflowsService;

function emulatorUrl(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

// ── Setup / Teardown ──

beforeAll(async () => {
  emulatorPort = await getAvailablePort();

  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const logger = new Logger('e2e-workflows', 'error');
  workflowsService = new CloudWorkflowsService(storage, logger);
  await workflowsService.initialize();

  const routes = workflowsService.getRoutes();
  const router = buildRouter(routes);

  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: router,
  });
});

afterAll(async () => {
  await workflowsService.stop();
  emulatorServer.stop();
});

// ── Test: Full Workflow Lifecycle ──

describe('Cloud Workflows E2E: Raw HTTP API', () => {
  const project = 'test-project';
  const location = 'us-central1';
  const workflowId = 'e2e-test-workflow';
  const basePath = `/v1/projects/${project}/locations/${location}/workflows`;
  const opsBasePath = `/v1/projects/${project}/locations/${location}/operations`;

  let firstRevisionId: string;

  test('1. Create a workflow - returns Operation with done:true', async () => {
    const response = await fetch(emulatorUrl(`${basePath}?workflowId=${workflowId}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceContents: 'main:\n  steps:\n    - step1:\n        return: "hello"',
        description: 'E2E test workflow',
        labels: { env: 'test' },
      }),
    });

    expect(response.status).toBe(200);

    const op = await response.json();

    expect(op.done).toBe(true);
    expect(op.metadata['@type']).toBe(
      'type.googleapis.com/google.cloud.workflows.v1.OperationMetadata'
    );
    expect(op.metadata.verb).toBe('create');
    expect(op.metadata.apiVersion).toBe('v1');

    const workflow = op.response;

    expect(workflow['@type']).toBe('type.googleapis.com/google.cloud.workflows.v1.Workflow');

    expect(workflow.name).toBe(`projects/${project}/locations/${location}/workflows/${workflowId}`);
    expect(workflow.state).toBe('ACTIVE');
    expect(workflow.revisionId).toMatch(/^000001-[0-9a-f]{3}$/);
    expect(workflow.description).toBe('E2E test workflow');
    expect(workflow.labels).toEqual({ env: 'test' });

    firstRevisionId = workflow.revisionId;
  });

  test('2. Get the workflow - verify ACTIVE state and revisionId', async () => {
    const response = await fetch(emulatorUrl(`${basePath}/${workflowId}`));

    expect(response.status).toBe(200);

    const workflow = await response.json();

    expect(workflow.name).toBe(`projects/${project}/locations/${location}/workflows/${workflowId}`);
    expect(workflow.state).toBe('ACTIVE');
    expect(workflow.revisionId).toBe(firstRevisionId);
    expect(workflow.sourceContents).toContain('hello');
  });

  test('3. List workflows - verify workflow appears', async () => {
    const response = await fetch(emulatorUrl(basePath));

    expect(response.status).toBe(200);

    const result = await response.json();

    expect(result.workflows).toBeDefined();
    expect(result.workflows.length).toBeGreaterThanOrEqual(1);

    const found = result.workflows.find((w: Record<string, unknown>) =>
      w.name?.toString().includes(workflowId)
    );

    expect(found).toBeDefined();
  });

  test('4. Update workflow (change sourceContents) - verify new revisionId', async () => {
    const response = await fetch(emulatorUrl(`${basePath}/${workflowId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceContents: 'main:\n  steps:\n    - step1:\n        return: "updated"',
      }),
    });

    expect(response.status).toBe(200);

    const op = await response.json();

    expect(op.done).toBe(true);
    expect(op.metadata.verb).toBe('update');

    const workflow = op.response;

    expect(workflow.revisionId).toMatch(/^000002-[0-9a-f]{3}$/);
    expect(workflow.sourceContents).toContain('updated');
  });

  test('5. List revisions - verify 2 revisions in reverse chronological order', async () => {
    const response = await fetch(emulatorUrl(`${basePath}/${workflowId}:listRevisions`));

    expect(response.status).toBe(200);

    const result = await response.json();

    expect(result.workflows).toHaveLength(2);
    expect(result.workflows[0].revisionId).toMatch(/^000002-/);
    expect(result.workflows[1].revisionId).toMatch(/^000001-/);
  });

  test('6. Get specific revision by revisionId', async () => {
    const response = await fetch(
      emulatorUrl(`${basePath}/${workflowId}?revisionId=${firstRevisionId}`)
    );

    expect(response.status).toBe(200);

    const workflow = await response.json();

    expect(workflow.revisionId).toBe(firstRevisionId);
    expect(workflow.sourceContents).toContain('hello');
  });

  test('7. List operations - verify create + update operations present', async () => {
    const response = await fetch(emulatorUrl(opsBasePath));

    expect(response.status).toBe(200);

    const result = await response.json();

    expect(result.operations.length).toBeGreaterThanOrEqual(2);

    const verbs = result.operations.map((op: Record<string, unknown>) => {
      const metadata = op.metadata as Record<string, unknown>;

      return metadata.verb;
    });

    expect(verbs).toContain('create');
    expect(verbs).toContain('update');
  });

  test('8. Delete workflow - returns Operation', async () => {
    const response = await fetch(emulatorUrl(`${basePath}/${workflowId}`), {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);

    const op = await response.json();

    expect(op.done).toBe(true);
    expect(op.metadata.verb).toBe('delete');
  });

  test('9. Get deleted workflow - verify 404', async () => {
    const response = await fetch(emulatorUrl(`${basePath}/${workflowId}`));

    expect(response.status).toBe(404);
  });
});

describe('Cloud Workflows E2E: Locations', () => {
  const project = 'test-project';

  test('list locations returns GCP regions', async () => {
    const response = await fetch(emulatorUrl(`/v1/projects/${project}/locations`));

    expect(response.status).toBe(200);

    const result = await response.json();

    expect(result.locations.length).toBeGreaterThan(0);

    const ids = result.locations.map((l: Record<string, unknown>) => l.locationId);

    expect(ids).toContain('us-central1');
    expect(ids).toContain('europe-west1');
  });

  test('get specific location', async () => {
    const response = await fetch(emulatorUrl(`/v1/projects/${project}/locations/us-central1`));

    expect(response.status).toBe(200);

    const loc = await response.json();

    expect(loc.locationId).toBe('us-central1');
    expect(loc.displayName).toContain('Iowa');
  });
});

// ── Test Path 2: Official @google-cloud/workflows Client Library ──

describe('Cloud Workflows E2E: Client Library', () => {
  const project = 'client-lib-project';
  const location = 'us-central1';
  const workflowId = 'client-lib-workflow';
  const workflowName = `projects/${project}/locations/${location}/workflows/${workflowId}`;

  let client: InstanceType<typeof WorkflowsClient>;
  let firstRevisionId: string;

  beforeAll(() => {
    const fakeAuth = createFakeAuth(project);

    client = new WorkflowsClient({
      fallback: 'rest',
      apiEndpoint: 'localhost',
      port: emulatorPort,
      protocol: 'http',
      auth: fakeAuth as never,
    });
  });

  test('1. Create workflow via client library', async () => {
    const [operation] = await client.createWorkflow({
      parent: `projects/${project}/locations/${location}`,
      workflowId,
      workflow: {
        name: workflowName,
        sourceContents: 'main:\n  steps:\n    - step1:\n        return: "hello"',
        description: 'Client library E2E workflow',
      },
    });

    const [workflow] = await operation.promise();

    expect(workflow.name).toBe(workflowName);
    // Proto deserialization converts enum strings to integers (ACTIVE = 1)
    expect(workflow.state).toBe(1);
    expect(workflow.revisionId).toMatch(/^000001-[0-9a-f]{3}$/);
    expect(workflow.description).toBe('Client library E2E workflow');

    firstRevisionId = workflow.revisionId as string;
  });

  test('2. Get workflow via client library', async () => {
    const [workflow] = await client.getWorkflow({ name: workflowName });

    expect(workflow.name).toBe(workflowName);
    expect(workflow.state).toBe('ACTIVE');
    expect(workflow.revisionId).toBe(firstRevisionId);
    expect(workflow.sourceContents).toContain('hello');
  });

  test('3. List workflows via client library', async () => {
    const [workflows] = await client.listWorkflows({
      parent: `projects/${project}/locations/${location}`,
    });

    expect(workflows.length).toBeGreaterThanOrEqual(1);

    const found = workflows.find((w: Record<string, unknown>) => w.name === workflowName);

    expect(found).toBeDefined();
  });

  test('4. Update workflow via client library', async () => {
    const [operation] = await client.updateWorkflow({
      workflow: {
        name: workflowName,
        sourceContents: 'main:\n  steps:\n    - step1:\n        return: "updated"',
      },
      updateMask: { paths: ['source_contents'] },
    });

    const [workflow] = await operation.promise();

    expect(workflow.revisionId).toMatch(/^000002-[0-9a-f]{3}$/);
    expect(workflow.sourceContents).toContain('updated');
  });

  test('5. List revisions via client library', async () => {
    const [revisions] = await client.listWorkflowRevisions({
      name: workflowName,
    });

    expect(revisions).toHaveLength(2);
    expect((revisions[0]?.revisionId as string).startsWith('000002')).toBe(true);
    expect((revisions[1]?.revisionId as string).startsWith('000001')).toBe(true);
  });

  test('6. Delete workflow via client library', async () => {
    const [operation] = await client.deleteWorkflow({ name: workflowName });

    await operation.promise();

    const promise = client.getWorkflow({ name: workflowName });

    await expect(promise).rejects.toThrow();
  });
});
