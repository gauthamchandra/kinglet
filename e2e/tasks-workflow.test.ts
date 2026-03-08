/**
 * End-to-End Test: Cloud Tasks Workflow
 *
 * True black-box tests — validates the full lifecycle through HTTP only.
 * Two test paths:
 *   1. Raw HTTP fetch against the emulator
 *   2. Official @google-cloud/tasks client library
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { Server } from 'bun';
import { CloudTasksClient } from '@google-cloud/tasks';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { CloudTasksService } from '@/services/tasks/index.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { buildRouter, waitForCallback, createFakeAuth } from './e2e-helpers.ts';
import type { CallbackRecord } from './e2e-helpers.ts';

// ── Test Infrastructure ──

let callbackServer: Server;
let emulatorServer: Server;
let callbackPort: number;
let emulatorPort: number;
let tasksService: CloudTasksService;
const callbackRequests: CallbackRecord[] = [];

function emulatorUrl(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

function callbackUrl(path: string = '/callback'): string {
  return `http://localhost:${callbackPort}${path}`;
}

// ── Setup / Teardown ──

beforeAll(async () => {
  // 1. Start callback server (records incoming requests from task dispatch)
  callbackPort = await getAvailablePort();

  callbackServer = Bun.serve({
    port: callbackPort,
    fetch: async request => {
      const record: CallbackRecord = {
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        body: await request.text(),
        receivedAt: Date.now(),
      };

      callbackRequests.push(record);

      return new Response('OK', { status: 200 });
    },
  });

  // 2. Start emulator server with Cloud Tasks service
  emulatorPort = await getAvailablePort();

  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const logger = new Logger('e2e-tasks', 'error');
  tasksService = new CloudTasksService(storage, logger);
  await tasksService.initialize();
  tasksService.start(500);

  const routes = tasksService.getRoutes();
  const router = buildRouter(routes);

  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: router,
  });
});

afterAll(async () => {
  await tasksService.stop();
  emulatorServer.stop();
  callbackServer.stop();
});

// ── Test Path 1: Raw HTTP Fetch ──

describe('Cloud Tasks E2E: Raw HTTP API', () => {
  const project = 'test-project';
  const location = 'us-central1';
  const queueId = 'e2e-test-queue';
  const queuesBasePath = `/v2/projects/${project}/locations/${location}/queues`;
  let createdTaskName: string;

  test('1. Create a queue', async () => {
    const response = await fetch(emulatorUrl(queuesBasePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `projects/${project}/locations/${location}/queues/${queueId}`,
      }),
    });

    expect(response.status).toBe(200);

    const queue = await response.json();

    expect(queue.name).toBe(`projects/${project}/locations/${location}/queues/${queueId}`);
    expect(queue.state).toBe('RUNNING');
    expect(queue.rateLimits).toBeDefined();
    expect(queue.retryConfig).toBeDefined();
  });

  test('2. Get the queue', async () => {
    const response = await fetch(emulatorUrl(`${queuesBasePath}/${queueId}`));

    expect(response.status).toBe(200);

    const queue = await response.json();

    expect(queue.name).toBe(`projects/${project}/locations/${location}/queues/${queueId}`);
    expect(queue.state).toBe('RUNNING');
  });

  test('3. List queues', async () => {
    const response = await fetch(emulatorUrl(queuesBasePath));

    expect(response.status).toBe(200);

    const result = await response.json();

    expect(result.queues).toBeDefined();
    expect(result.queues.length).toBeGreaterThanOrEqual(1);
  });

  test('4. Update the queue', async () => {
    const response = await fetch(emulatorUrl(`${queuesBasePath}/${queueId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rateLimits: {
          maxDispatchesPerSecond: 100,
          maxBurstSize: 50,
          maxConcurrentDispatches: 200,
        },
      }),
    });

    expect(response.status).toBe(200);

    const queue = await response.json();

    expect(queue.rateLimits.maxDispatchesPerSecond).toBe(100);
    expect(queue.rateLimits.maxBurstSize).toBe(50);
    expect(queue.rateLimits.maxConcurrentDispatches).toBe(200);
  });

  test('5. Pause the queue', async () => {
    const response = await fetch(emulatorUrl(`${queuesBasePath}/${queueId}:pause`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);

    const queue = await response.json();

    expect(queue.state).toBe('PAUSED');
  });

  test('6. Resume the queue', async () => {
    const response = await fetch(emulatorUrl(`${queuesBasePath}/${queueId}:resume`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);

    const queue = await response.json();

    expect(queue.state).toBe('RUNNING');
  });

  test('7. Create a task with HTTP target', async () => {
    const tasksPath = `${queuesBasePath}/${queueId}/tasks`;

    const response = await fetch(emulatorUrl(tasksPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: {
          httpRequest: {
            url: callbackUrl('/task-callback'),
            httpMethod: 'POST',
            headers: { 'X-E2E-Task': 'true', 'Content-Type': 'application/json' },
            body: Buffer.from(JSON.stringify({ message: 'hello from tasks' })).toString('base64'),
          },
        },
      }),
    });

    expect(response.status).toBe(200);

    const task = await response.json();

    expect(task.name).toBeTypeOf('string');
    expect(task.httpRequest.url).toBe(callbackUrl('/task-callback'));
    expect(task.httpRequest.httpMethod).toBe('POST');
    expect(task.scheduleTime).toBeTypeOf('string');

    createdTaskName = task.name;
  });

  test('8. Get the task', async () => {
    const taskId = createdTaskName.split('/').pop();
    const taskPath = `${queuesBasePath}/${queueId}/tasks/${taskId}`;

    const response = await fetch(emulatorUrl(taskPath));

    expect(response.status).toBe(200);

    const task = await response.json();

    expect(task.name).toBe(createdTaskName);
    expect(task.httpRequest).toBeDefined();
  });

  test('9. List tasks', async () => {
    const tasksPath = `${queuesBasePath}/${queueId}/tasks`;

    const response = await fetch(emulatorUrl(tasksPath));

    expect(response.status).toBe(200);

    const result = await response.json();

    expect(result.tasks).toBeDefined();
    expect(result.tasks.length).toBeGreaterThanOrEqual(1);
  });

  test('10. Force-run the task and verify callback', async () => {
    callbackRequests.length = 0;

    const taskId = createdTaskName.split('/').pop();
    const runPath = `${queuesBasePath}/${queueId}/tasks/${taskId}:run`;

    const runResponse = await fetch(emulatorUrl(runPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(runResponse.status).toBe(200);

    await waitForCallback(callbackRequests, 1, 5000);

    expect(callbackRequests.length).toBeGreaterThanOrEqual(1);

    const callback = callbackRequests.find(r => r.url.includes('/task-callback'));

    expect(callback).toBeDefined();
    expect(callback?.method).toBe('POST');
    expect(callback?.headers['x-e2e-task']).toBe('true');

    const body = JSON.parse(callback?.body ?? '{}');

    expect(body.message).toBe('hello from tasks');
  });

  test('11. Create another task, then delete it', async () => {
    const tasksPath = `${queuesBasePath}/${queueId}/tasks`;

    const createResponse = await fetch(emulatorUrl(tasksPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: {
          httpRequest: {
            url: callbackUrl('/delete-test'),
            httpMethod: 'GET',
          },
        },
      }),
    });

    expect(createResponse.status).toBe(200);

    const task = await createResponse.json();
    const taskId = task.name.split('/').pop();
    const taskPath = `${queuesBasePath}/${queueId}/tasks/${taskId}`;

    const deleteResponse = await fetch(emulatorUrl(taskPath), {
      method: 'DELETE',
    });

    expect(deleteResponse.status).toBe(200);

    const getResponse = await fetch(emulatorUrl(taskPath));

    expect(getResponse.status).toBe(404);
  });

  test('12. Purge the queue', async () => {
    const response = await fetch(emulatorUrl(`${queuesBasePath}/${queueId}:purge`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);

    const queue = await response.json();

    expect(queue.purgeTime).toBeTypeOf('string');
  });

  test('13. Delete the queue and verify 404', async () => {
    const deleteResponse = await fetch(emulatorUrl(`${queuesBasePath}/${queueId}`), {
      method: 'DELETE',
    });

    expect(deleteResponse.status).toBe(200);

    const getResponse = await fetch(emulatorUrl(`${queuesBasePath}/${queueId}`));

    expect(getResponse.status).toBe(404);
  });

  test('14. CamelCase queue ID with GCP-style query params round-trips correctly', async () => {
    const camelQueueId = 'myTestPaymentQueue';
    const camelQueueName = `projects/${project}/locations/${location}/queues/${camelQueueId}`;

    // Create queue with camelCase ID
    const createQueueResponse = await fetch(emulatorUrl(queuesBasePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: camelQueueName }),
    });

    expect(createQueueResponse.status).toBe(200);

    const queue = await createQueueResponse.json();

    expect(queue.name).toBe(camelQueueName);

    // Create a task using the $alt query param the GCP client library sends
    const tasksPath = `${queuesBasePath}/${camelQueueId}/tasks`;

    const createTaskResponse = await fetch(
      emulatorUrl(`${tasksPath}?$alt=json%3Benum-encoding%3Dint`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: {
            httpRequest: {
              url: callbackUrl('/camel-case-test'),
              httpMethod: 'POST',
            },
          },
        }),
      }
    );

    expect(createTaskResponse.status).toBe(200);

    const task = await createTaskResponse.json();

    expect(task.name).toContain(camelQueueName);
    expect(task.httpRequest.url).toBe(callbackUrl('/camel-case-test'));

    // Clean up
    await fetch(emulatorUrl(`${queuesBasePath}/${camelQueueId}`), { method: 'DELETE' });
  });

  test('15. Create queue with httpTarget and verify round-trip', async () => {
    const httpTargetQueueId = 'http-target-queue';

    const response = await fetch(emulatorUrl(queuesBasePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `projects/${project}/locations/${location}/queues/${httpTargetQueueId}`,
        httpTarget: {
          uriOverride: {
            host: 'localhost',
            port: callbackPort,
            pathOverride: { path: '/override' },
            queryOverride: { queryParams: 'key=val' },
            scheme: 'HTTP',
          },
          httpMethod: 'POST',
          headerOverrides: [{ header: { key: 'X-Custom', value: 'value1' } }],
        },
      }),
    });

    expect(response.status).toBe(200);

    const queue = await response.json();

    expect(queue.httpTarget).toBeDefined();
    expect(queue.httpTarget.uriOverride.host).toBe('localhost');
    expect(queue.httpTarget.uriOverride.port).toBe(callbackPort);
    expect(queue.httpTarget.httpMethod).toBe('POST');
    expect(queue.httpTarget.headerOverrides).toHaveLength(1);

    // Verify GET returns httpTarget
    const getResp = await fetch(emulatorUrl(`${queuesBasePath}/${httpTargetQueueId}`));
    const getQueue = await getResp.json();

    expect(getQueue.httpTarget.uriOverride.host).toBe('localhost');

    // Cleanup
    await fetch(emulatorUrl(`${queuesBasePath}/${httpTargetQueueId}`), { method: 'DELETE' });
  });

  test('16. Create queue with httpTarget including oauthToken', async () => {
    const qId = 'oauth-queue';

    const response = await fetch(emulatorUrl(queuesBasePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `projects/${project}/locations/${location}/queues/${qId}`,
        httpTarget: {
          uriOverride: { host: 'localhost', scheme: 'HTTP' },
          oauthToken: {
            serviceAccountEmail: 'sa@project.iam.gserviceaccount.com',
            scope: 'https://www.googleapis.com/auth/cloud-platform',
          },
        },
      }),
    });

    expect(response.status).toBe(200);

    const queue = await response.json();

    expect(queue.httpTarget.oauthToken.serviceAccountEmail).toBe(
      'sa@project.iam.gserviceaccount.com'
    );

    // Cleanup
    await fetch(emulatorUrl(`${queuesBasePath}/${qId}`), { method: 'DELETE' });
  });

  test('17. Queue httpTarget uriOverride supports uriOverrideEnforceMode', async () => {
    const qId = 'enforce-mode-queue';

    const response = await fetch(emulatorUrl(queuesBasePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `projects/${project}/locations/${location}/queues/${qId}`,
        httpTarget: {
          uriOverride: {
            host: 'localhost',
            scheme: 'HTTP',
            uriOverrideEnforceMode: 'ALWAYS',
          },
        },
      }),
    });

    expect(response.status).toBe(200);

    const queue = await response.json();

    expect(queue.httpTarget.uriOverride.uriOverrideEnforceMode).toBe('ALWAYS');

    // Cleanup
    await fetch(emulatorUrl(`${queuesBasePath}/${qId}`), { method: 'DELETE' });
  });

  test('18. Task attempt responseStatus is a Status object with code and message', async () => {
    const qId = 'attempt-status-queue';

    await fetch(emulatorUrl(queuesBasePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `projects/${project}/locations/${location}/queues/${qId}`,
      }),
    });

    const tasksPath = `${queuesBasePath}/${qId}/tasks`;

    const createResp = await fetch(emulatorUrl(tasksPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: {
          httpRequest: {
            url: callbackUrl('/attempt-check'),
            httpMethod: 'POST',
          },
        },
      }),
    });

    const task = await createResp.json();
    const taskId = task.name.split('/').pop();

    // Force run the task
    callbackRequests.length = 0;

    await fetch(emulatorUrl(`${tasksPath}/${taskId}:run`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    await waitForCallback(callbackRequests, 1, 5000);

    // Wait briefly for dispatch engine to update the task record
    await new Promise(resolve => setTimeout(resolve, 200));

    // Get the task with FULL view to check attempt data
    const getResp = await fetch(emulatorUrl(`${tasksPath}/${taskId}?responseView=FULL`));

    expect(getResp.status).toBe(200);
    const updatedTask = await getResp.json();

    expect(updatedTask.lastAttempt).toBeDefined();
    expect(updatedTask.lastAttempt.responseStatus).toHaveProperty('code');
    expect(updatedTask.lastAttempt.responseStatus).toHaveProperty('message');
    expect(updatedTask.lastAttempt.responseStatus.code).toBeTypeOf('number');
    expect(updatedTask.lastAttempt.responseStatus.message).toBeTypeOf('string');

    // Cleanup
    await fetch(emulatorUrl(`${queuesBasePath}/${qId}`), { method: 'DELETE' });
  });

  test('19. tasks.run respects responseView=BASIC (omits body from httpRequest)', async () => {
    const qId = 'run-view-queue';

    await fetch(emulatorUrl(queuesBasePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `projects/${project}/locations/${location}/queues/${qId}`,
      }),
    });

    const tasksPath = `${queuesBasePath}/${qId}/tasks`;

    const createResp = await fetch(emulatorUrl(tasksPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: {
          httpRequest: {
            url: callbackUrl('/run-view-test'),
            httpMethod: 'POST',
            body: Buffer.from('secret-payload').toString('base64'),
          },
        },
      }),
    });

    const task = await createResp.json();
    const taskId = task.name.split('/').pop();

    // Run with BASIC view -- body should be stripped from httpRequest in response
    const runResp = await fetch(emulatorUrl(`${tasksPath}/${taskId}:run`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responseView: 'BASIC' }),
    });

    expect(runResp.status).toBe(200);

    const runResult = await runResp.json();

    expect(runResult.httpRequest.body).toBeUndefined();
    expect(runResult.view).toBe('BASIC');

    // Cleanup
    await fetch(emulatorUrl(`${queuesBasePath}/${qId}`), { method: 'DELETE' });
  });

  test('20. queues.patch with updateMask only updates specified fields', async () => {
    const qId = 'mask-queue';

    await fetch(emulatorUrl(queuesBasePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `projects/${project}/locations/${location}/queues/${qId}`,
        rateLimits: { maxDispatchesPerSecond: 100, maxBurstSize: 50, maxConcurrentDispatches: 200 },
        retryConfig: {
          maxAttempts: 5,
          maxRetryDuration: '0s',
          minBackoff: '0.100s',
          maxBackoff: '3600s',
          maxDoublings: 16,
        },
      }),
    });

    // PATCH with updateMask=rateLimits -- only rateLimits should change
    const patchResp = await fetch(emulatorUrl(`${queuesBasePath}/${qId}?updateMask=rateLimits`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rateLimits: { maxDispatchesPerSecond: 10, maxBurstSize: 5, maxConcurrentDispatches: 20 },
        retryConfig: {
          maxAttempts: 99,
          maxRetryDuration: '0s',
          minBackoff: '1s',
          maxBackoff: '100s',
          maxDoublings: 4,
        },
      }),
    });

    expect(patchResp.status).toBe(200);

    const queue = await patchResp.json();

    // rateLimits should be updated
    expect(queue.rateLimits.maxDispatchesPerSecond).toBe(10);

    // retryConfig should be UNCHANGED because it was not in the updateMask
    expect(queue.retryConfig.maxAttempts).toBe(5);

    // Cleanup
    await fetch(emulatorUrl(`${queuesBasePath}/${qId}`), { method: 'DELETE' });
  });

  test('21. queues.list supports filter parameter', async () => {
    const qRunning = 'filter-running-q';
    const qPaused = 'filter-paused-q';

    await fetch(emulatorUrl(queuesBasePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `projects/${project}/locations/${location}/queues/${qRunning}`,
      }),
    });

    await fetch(emulatorUrl(queuesBasePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `projects/${project}/locations/${location}/queues/${qPaused}`,
      }),
    });

    await fetch(emulatorUrl(`${queuesBasePath}/${qPaused}:pause`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    // List with filter=state=PAUSED
    const resp = await fetch(emulatorUrl(`${queuesBasePath}?filter=state%3DPAUSED`));

    expect(resp.status).toBe(200);

    const result = await resp.json();
    const names = result.queues.map((q: { name: string }) => q.name);

    expect(names).toContain(`projects/${project}/locations/${location}/queues/${qPaused}`);
    expect(names).not.toContain(`projects/${project}/locations/${location}/queues/${qRunning}`);

    // Cleanup
    await fetch(emulatorUrl(`${queuesBasePath}/${qRunning}`), { method: 'DELETE' });
    await fetch(emulatorUrl(`${queuesBasePath}/${qPaused}`), { method: 'DELETE' });
  });

  test('22. locations.list returns available locations', async () => {
    const resp = await fetch(emulatorUrl(`/v2/projects/${project}/locations`));

    expect(resp.status).toBe(200);

    const result = await resp.json();

    expect(result.locations).toBeInstanceOf(Array);
    expect(result.locations.length).toBeGreaterThanOrEqual(1);
    expect(result.locations[0].locationId).toBeTypeOf('string');
    expect(result.locations[0].name).toMatch(/^projects\/[^/]+\/locations\/[^/]+$/);
  });

  test('23. locations.get returns a specific location', async () => {
    const resp = await fetch(emulatorUrl(`/v2/projects/${project}/locations/${location}`));

    expect(resp.status).toBe(200);

    const loc = await resp.json();

    expect(loc.locationId).toBe(location);
    expect(loc.name).toBe(`projects/${project}/locations/${location}`);
  });

  test('24. getCmekConfig returns default config', async () => {
    const resp = await fetch(
      emulatorUrl(`/v2/projects/${project}/locations/${location}/cmekConfig`)
    );

    expect(resp.status).toBe(200);

    const config = await resp.json();

    expect(config.name).toBe(`projects/${project}/locations/${location}/cmekConfig`);
  });

  test('25. updateCmekConfig stores and returns CMEK config', async () => {
    const resp = await fetch(
      emulatorUrl(`/v2/projects/${project}/locations/${location}/cmekConfig`),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kmsKey: 'projects/my-project/locations/us-central1/keyRings/my-kr/cryptoKeys/my-key',
        }),
      }
    );

    expect(resp.status).toBe(200);

    const config = await resp.json();

    expect(config.kmsKey).toBe(
      'projects/my-project/locations/us-central1/keyRings/my-kr/cryptoKeys/my-key'
    );
    expect(config.name).toBe(`projects/${project}/locations/${location}/cmekConfig`);
  });

  test('26. tasks.buffer creates a task from queue httpTarget and provided body', async () => {
    const qId = 'buffer-queue';

    // Create queue with httpTarget pointing to our callback server
    await fetch(emulatorUrl(queuesBasePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `projects/${project}/locations/${location}/queues/${qId}`,
        httpTarget: {
          uriOverride: {
            scheme: 'HTTP',
            host: `localhost:${callbackPort}`,
            pathOverride: { path: '/buffer-callback' },
          },
          httpMethod: 'POST',
          headerOverrides: [{ header: { key: 'X-Buffer-Source', value: 'test' } }],
        },
      }),
    });

    // Buffer a task
    const tasksPath = `${queuesBasePath}/${qId}/tasks`;

    const bufferResp = await fetch(emulatorUrl(`${tasksPath}/my-buffered-task:buffer`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: {
          contentType: 'application/json',
          data: Buffer.from(JSON.stringify({ msg: 'buffered' })).toString('base64'),
        },
      }),
    });

    expect(bufferResp.status).toBe(200);

    const result = await bufferResp.json();

    expect(result.task).toBeDefined();
    expect(result.task.name).toContain('my-buffered-task');
    expect(result.task.httpRequest).toBeDefined();
    expect(result.task.httpRequest.url).toContain('localhost');
    expect(result.task.httpRequest.url).toContain('/buffer-callback');
    expect(result.task.httpRequest.httpMethod).toBe('POST');

    // Cleanup
    await fetch(emulatorUrl(`${queuesBasePath}/${qId}`), { method: 'DELETE' });
  });

  test('27. Create task with appEngineHttpRequest (stub)', async () => {
    const qId = 'appengine-queue';

    await fetch(emulatorUrl(queuesBasePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `projects/${project}/locations/${location}/queues/${qId}`,
      }),
    });

    const tasksPath = `${queuesBasePath}/${qId}/tasks`;

    const resp = await fetch(emulatorUrl(tasksPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: {
          appEngineHttpRequest: {
            httpMethod: 'POST',
            relativeUri: '/worker',
            body: Buffer.from('ae-payload').toString('base64'),
          },
        },
      }),
    });

    expect(resp.status).toBe(200);

    const task = await resp.json();

    expect(task.appEngineHttpRequest).toBeDefined();
    expect(task.appEngineHttpRequest.relativeUri).toBe('/worker');
    expect(task.appEngineHttpRequest.httpMethod).toBe('POST');

    // Cleanup
    await fetch(emulatorUrl(`${queuesBasePath}/${qId}`), { method: 'DELETE' });
  });

  test('28. Create queue with appEngineRoutingOverride (stub)', async () => {
    const qId = 'ae-routing-queue';

    const resp = await fetch(emulatorUrl(queuesBasePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `projects/${project}/locations/${location}/queues/${qId}`,
        appEngineRoutingOverride: {
          service: 'worker-service',
          version: 'v2',
        },
      }),
    });

    expect(resp.status).toBe(200);

    const queue = await resp.json();

    expect(queue.appEngineRoutingOverride).toBeDefined();
    expect(queue.appEngineRoutingOverride.service).toBe('worker-service');

    // Verify round-trip via GET
    const getResp = await fetch(emulatorUrl(`${queuesBasePath}/${qId}`));
    const getQueue = await getResp.json();

    expect(getQueue.appEngineRoutingOverride.service).toBe('worker-service');
    expect(getQueue.appEngineRoutingOverride.version).toBe('v2');

    // Cleanup
    await fetch(emulatorUrl(`${queuesBasePath}/${qId}`), { method: 'DELETE' });
  });
});

// ── Test Path 2: Official @google-cloud/tasks Client Library ──

describe('Cloud Tasks E2E: Client Library', () => {
  const project = 'client-lib-project';
  const location = 'us-central1';
  const queueId = 'client-lib-queue';
  const queueName = `projects/${project}/locations/${location}/queues/${queueId}`;
  let createdTaskName: string;

  let client: InstanceType<typeof CloudTasksClient>;

  beforeAll(() => {
    const fakeAuth = createFakeAuth(project);

    client = new CloudTasksClient({
      fallback: 'rest',
      apiEndpoint: 'localhost',
      port: emulatorPort,
      protocol: 'http',
      auth: fakeAuth as never,
    });
  });

  test('1. Create queue via client library', async () => {
    const [queue] = await client.createQueue({
      parent: `projects/${project}/locations/${location}`,
      queue: {
        name: queueName,
      },
    });

    expect(queue.name).toBe(queueName);
    expect(queue.state).toBe('RUNNING');
  });

  test('2. Get queue via client library', async () => {
    const [queue] = await client.getQueue({ name: queueName });

    expect(queue.name).toBe(queueName);
  });

  test('3. List queues via client library', async () => {
    const [queues] = await client.listQueues({
      parent: `projects/${project}/locations/${location}`,
    });

    expect(queues.length).toBeGreaterThanOrEqual(1);

    const found = queues.find((q: Record<string, unknown>) => q.name === queueName);

    expect(found).toBeDefined();
  });

  test('4. Pause queue via client library', async () => {
    const [queue] = await client.pauseQueue({ name: queueName });

    expect(queue.state).toBe('PAUSED');
  });

  test('5. Resume queue via client library', async () => {
    const [queue] = await client.resumeQueue({ name: queueName });

    expect(queue.state).toBe('RUNNING');
  });

  test('6. Create task via client library', async () => {
    const [task] = await client.createTask({
      parent: queueName,
      task: {
        httpRequest: {
          url: callbackUrl('/client-task-callback'),
          httpMethod: 'POST',
          headers: { 'X-Client-Task': 'true' },
          body: Buffer.from(JSON.stringify({ source: 'client-lib' })),
        },
      },
    });

    expect(task.name).toBeTypeOf('string');
    expect(task.httpRequest).toBeDefined();

    createdTaskName = task.name as string;
  });

  test('7. Get task via client library', async () => {
    const [task] = await client.getTask({ name: createdTaskName });

    expect(task.name).toBe(createdTaskName);
  });

  test('8. List tasks via client library', async () => {
    const [tasks] = await client.listTasks({ parent: queueName });

    expect(tasks.length).toBeGreaterThanOrEqual(1);

    const found = tasks.find((t: Record<string, unknown>) => t.name === createdTaskName);

    expect(found).toBeDefined();
  });

  test('9. Run task and verify callback', async () => {
    callbackRequests.length = 0;

    const [task] = await client.runTask({ name: createdTaskName });

    expect(task.name).toBe(createdTaskName);

    await waitForCallback(callbackRequests, 1, 5000);

    expect(callbackRequests.length).toBeGreaterThanOrEqual(1);

    const callback = callbackRequests.find(r => r.url.includes('/client-task-callback'));

    expect(callback).toBeDefined();
    expect(callback?.method).toBe('POST');
    expect(callback?.headers['x-client-task']).toBe('true');
  });

  test('10. Delete task and verify not found', async () => {
    // Create a fresh task — the dispatch engine deletes tasks from storage
    // after successful HTTP dispatch, so the task from test 9 is already gone
    const [freshTask] = await client.createTask({
      parent: queueName,
      task: {
        httpRequest: {
          url: callbackUrl('/delete-test'),
          httpMethod: 'GET',
        },
      },
    });

    const freshTaskName = freshTask.name as string;

    await client.deleteTask({ name: freshTaskName });

    const getDeletedTask = client.getTask({ name: freshTaskName });

    await expect(getDeletedTask).rejects.toThrow(/not found/i);
  });

  test('11. Delete queue and verify not found', async () => {
    await client.deleteQueue({ name: queueName });

    const getDeletedQueue = client.getQueue({ name: queueName });

    await expect(getDeletedQueue).rejects.toThrow(/not found/i);
  });
});
