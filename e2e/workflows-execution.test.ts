/**
 * End-to-End Test: Workflow Execution Lifecycle
 *
 * True black-box tests — deploys a workflow, executes it via HTTP, and verifies results.
 * Two test paths:
 *   1. Raw HTTP fetch against the emulator
 *   2. Official @google-cloud/workflows ExecutionsClient library
 *
 * Uses the order-fulfillment fixture YAML with a mock HTTP server
 * for payment, inventory, and shipping endpoints.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { Server } from 'bun';
import { ExecutionsClient, WorkflowsClient } from '@google-cloud/workflows';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { CloudWorkflowsService } from '@/services/workflows/index.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { buildRouter, createFakeAuth } from './e2e-helpers.ts';

// ── Test Infrastructure ──

let emulatorServer: Server;
let emulatorPort: number;
let mockServer: Server;
let mockServerUrl: string;
let workflowsService: CloudWorkflowsService;

function emulatorUrl(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

// ── Setup / Teardown ──

beforeAll(async () => {
  // 1. Start mock HTTP server for the workflow's external HTTP calls
  const mockPort = await getAvailablePort();

  mockServer = Bun.serve({
    port: mockPort,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/payment' && req.method === 'POST') {
        return Response.json({ paymentId: 'PAY-001' });
      }

      if (url.pathname === '/inventory' && req.method === 'POST') {
        return Response.json({ reserved: true, sku: 'ITEM-1' });
      }

      if (url.pathname === '/shipping' && req.method === 'POST') {
        return Response.json({ trackingId: 'TRACK-XYZ', status: 'shipped' });
      }

      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });

  mockServerUrl = `http://localhost:${mockServer.port}`;

  // 2. Start emulator server with Cloud Workflows service
  emulatorPort = await getAvailablePort();

  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const logger = new Logger('e2e-execution', 'error');
  workflowsService = new CloudWorkflowsService(storage, logger);
  await workflowsService.initialize();

  const routes = workflowsService.getRoutes();
  const router = buildRouter(routes);

  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: router,
  });

  // 3. Deploy the order-fulfillment fixture workflow
  const fixtureYaml = await Bun.file(
    new URL('../src/services/workflows/fixtures/order-fulfillment.yml', import.meta.url).pathname
  ).text();

  const createResp = await fetch(
    emulatorUrl(`/v1/projects/e2e-project/locations/us-central1/workflows?workflowId=order-fulfillment`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceContents: fixtureYaml }),
    }
  );

  expect(createResp.status).toBe(200);
});

afterAll(async () => {
  await workflowsService.stop();
  emulatorServer.stop();
  mockServer.stop();
});

// ── Test Path 1: Raw HTTP Fetch ──

describe('Workflow Execution E2E: Raw HTTP API', () => {
  const project = 'e2e-project';
  const location = 'us-central1';
  const workflowId = 'order-fulfillment';
  const execBasePath = `/v1/projects/${project}/locations/${location}/workflows/${workflowId}/executions`;
  let createdExecutionName: string;

  function makeExecutionArgs(overrides: Record<string, unknown> = {}) {
    return {
      orderData: {
        type: 'ORDER',
        orderId: 'ORD-42',
        items: [
          { sku: 'WIDGET-A', quantity: 2 },
          { sku: 'WIDGET-B', quantity: 1 },
        ],
        customer: {
          name: 'Jane Doe',
          email: 'JANE@EXAMPLE.COM',
          address: '123 Main St',
        },
        shippingMethod: 'EXPRESS',
        amount: 59.99,
        paymentUrl: `${mockServerUrl}/payment`,
        inventoryUrl: `${mockServerUrl}/inventory`,
        shippingUrl: `${mockServerUrl}/shipping`,
        ...overrides,
      },
    };
  }

  test('1. Execute a successful order workflow', async () => {
    const response = await fetch(emulatorUrl(execBasePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ argument: JSON.stringify(makeExecutionArgs()) }),
    });

    expect(response.status).toBe(200);

    const execution = await response.json();

    expect(execution.state).toBe('SUCCEEDED');
    expect(execution.name).toBeTypeOf('string');
    expect(execution.workflowRevisionId).toBeTypeOf('string');
    expect(execution.startTime).toBeTypeOf('string');
    expect(execution.endTime).toBeTypeOf('string');

    const result = JSON.parse(execution.result);

    expect(result.orderId).toBe('ORD-42');
    expect(result.paymentId).toBe('PAY-001');
    expect(result.trackingId).toBe('TRACK-XYZ');
    expect(result.customerEmail).toBe('jane@example.com');
    expect(result.notificationCount).toBe(2);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toContain('Payment processed');
    expect(result.messages[1]).toContain('Express Shipping');

    createdExecutionName = execution.name;
  });

  test('2. Get the execution by ID', async () => {
    const executionId = createdExecutionName.split('/').pop();

    const response = await fetch(
      emulatorUrl(`${execBasePath}/${executionId}`)
    );

    expect(response.status).toBe(200);

    const execution = await response.json();

    expect(execution.name).toBe(createdExecutionName);
    expect(execution.state).toBe('SUCCEEDED');
  });

  test('3. List executions for the workflow', async () => {
    const response = await fetch(emulatorUrl(execBasePath));

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.executions).toBeInstanceOf(Array);
    expect(body.executions.length).toBeGreaterThanOrEqual(1);
  });

  test('4. Execute with STANDARD shipping (default path)', async () => {
    const response = await fetch(emulatorUrl(execBasePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        argument: JSON.stringify(makeExecutionArgs({ shippingMethod: 'STANDARD' })),
      }),
    });

    expect(response.status).toBe(200);

    const execution = await response.json();

    expect(execution.state).toBe('SUCCEEDED');

    const result = JSON.parse(execution.result);

    expect(result.messages[1]).toContain('Standard Shipping');
  });

  test('5. Execute with OVERNIGHT shipping (next jump path)', async () => {
    const response = await fetch(emulatorUrl(execBasePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        argument: JSON.stringify(makeExecutionArgs({ shippingMethod: 'OVERNIGHT' })),
      }),
    });

    expect(response.status).toBe(200);

    const execution = await response.json();

    expect(execution.state).toBe('SUCCEEDED');

    const result = JSON.parse(execution.result);

    expect(result.messages[1]).toContain('Overnight Shipping');
  });

  test('6. Fails on invalid order type (raise)', async () => {
    const response = await fetch(emulatorUrl(execBasePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        argument: JSON.stringify(makeExecutionArgs({ type: 'INVALID' })),
      }),
    });

    expect(response.status).toBe(200);

    const execution = await response.json();

    expect(execution.state).toBe('FAILED');
    expect(execution.error).toBeDefined();
  });

  test('7. sys.get_env returns correct emulator env vars', async () => {
    // Deploy a simple workflow that returns env vars
    const envYaml = `
main:
  steps:
    - getProject:
        call: sys.get_env
        args:
          name: "GOOGLE_CLOUD_PROJECT_ID"
        result: pid
    - getLoc:
        call: sys.get_env
        args:
          name: "GOOGLE_CLOUD_LOCATION"
        result: loc
    - getWf:
        call: sys.get_env
        args:
          name: "GOOGLE_CLOUD_WORKFLOW_ID"
        result: wfId
    - done:
        return:
          projectId: \${pid}
          location: \${loc}
          workflowId: \${wfId}
`;
    const envWorkflowId = 'env-test-workflow';

    await fetch(
      emulatorUrl(`/v1/projects/${project}/locations/${location}/workflows?workflowId=${envWorkflowId}`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceContents: envYaml }),
      }
    );

    const envExecPath = `/v1/projects/${project}/locations/${location}/workflows/${envWorkflowId}/executions`;

    const response = await fetch(emulatorUrl(envExecPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ argument: '{}' }),
    });

    expect(response.status).toBe(200);

    const execution = await response.json();

    expect(execution.state).toBe('SUCCEEDED');

    const result = JSON.parse(execution.result);

    expect(result.projectId).toBe(project);
    expect(result.location).toBe(location);
    expect(result.workflowId).toBe(envWorkflowId);
  });

  test('8. Get non-existent execution returns 404', async () => {
    const response = await fetch(
      emulatorUrl(`${execBasePath}/non-existent-id`)
    );

    expect(response.status).toBe(404);
  });
});

// ── Test Path 2: Official @google-cloud/workflows Client Library ──

describe('Workflow Execution E2E: Client Library', () => {
  const project = 'client-exec-project';
  const location = 'us-central1';
  const workflowId = 'client-exec-workflow';
  const parent = `projects/${project}/locations/${location}/workflows/${workflowId}`;

  let workflowsClient: InstanceType<typeof WorkflowsClient>;
  let executionsClient: InstanceType<typeof ExecutionsClient>;

  beforeAll(async () => {
    const fakeAuth = createFakeAuth(project);
    const clientOpts = {
      fallback: 'rest' as const,
      apiEndpoint: 'localhost',
      port: emulatorPort,
      protocol: 'http',
      auth: fakeAuth as never,
    };

    workflowsClient = new WorkflowsClient(clientOpts);
    executionsClient = new ExecutionsClient(clientOpts);

    // Deploy a simple workflow via client library
    const [operation] = await workflowsClient.createWorkflow({
      parent: `projects/${project}/locations/${location}`,
      workflowId,
      workflow: {
        name: parent,
        sourceContents: [
          'main:',
          '  params: [input]',
          '  steps:',
          '    - process:',
          '        assign:',
          '          - greeting: ${\"Hello, \" + input.name + \"!\"}',
          '    - done:',
          '        return:',
          '          message: ${greeting}',
          '          doubled: ${input.value * 2}',
        ].join('\n'),
      },
    });

    await operation.promise();
  });

  test('1. Create and run an execution via client library', async () => {
    const [execution] = await executionsClient.createExecution({
      parent,
      execution: {
        argument: JSON.stringify({ input: { name: 'World', value: 21 } }),
      },
    });

    expect(execution.name).toBeTypeOf('string');
    expect(execution.name).toContain(parent);
    // Execution runs synchronously in our emulator, so it's already done
    expect(execution.state).toBe('SUCCEEDED');
    expect(execution.result).toBeTypeOf('string');

    const result = JSON.parse(execution.result as string);

    expect(result.message).toBe('Hello, World!');
    expect(result.doubled).toBe(42);
  });

  test('2. Get execution via client library', async () => {
    // Create an execution first
    const [created] = await executionsClient.createExecution({
      parent,
      execution: {
        argument: JSON.stringify({ input: { name: 'Test', value: 5 } }),
      },
    });

    const [fetched] = await executionsClient.getExecution({
      name: created.name,
    });

    expect(fetched.name).toBe(created.name);
    expect(fetched.state).toBe('SUCCEEDED');
  });

  test('3. List executions via client library', async () => {
    const [executions] = await executionsClient.listExecutions({ parent });

    expect(executions.length).toBeGreaterThanOrEqual(2);

    const names = executions.map(e => e.name);

    expect(names.every(n => typeof n === 'string' && n.includes(parent))).toBe(true);
  });

  test('4. Failed execution via client library', async () => {
    // Deploy a workflow that always fails
    const failWorkflowId = 'client-fail-workflow';
    const failParent = `projects/${project}/locations/${location}/workflows/${failWorkflowId}`;

    const [failOp] = await workflowsClient.createWorkflow({
      parent: `projects/${project}/locations/${location}`,
      workflowId: failWorkflowId,
      workflow: {
        name: failParent,
        sourceContents: 'main:\n  steps:\n    - fail:\n        raise: "intentional failure"',
      },
    });

    await failOp.promise();

    const [execution] = await executionsClient.createExecution({
      parent: failParent,
      execution: { argument: '{}' },
    });

    expect(execution.state).toBe('FAILED');
    expect(execution.error).toBeDefined();
  });
});
