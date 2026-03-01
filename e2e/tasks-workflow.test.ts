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
import {
  buildRouter,
  waitForCallback,
  createFakeAuth,
} from './e2e-helpers.ts';
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

    let caught = false;

    try {
      await client.getTask({ name: freshTaskName });
    } catch (err: unknown) {
      caught = true;
      expect((err as Error).message.toLowerCase()).toContain('not found');
    }

    expect(caught).toBe(true);
  });

  test('11. Delete queue and verify not found', async () => {
    await client.deleteQueue({ name: queueName });

    let caught = false;

    try {
      await client.getQueue({ name: queueName });
    } catch (err: unknown) {
      caught = true;
      expect((err as Error).message.toLowerCase()).toContain('not found');
    }

    expect(caught).toBe(true);
  });
});
