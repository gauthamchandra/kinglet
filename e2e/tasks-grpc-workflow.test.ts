/**
 * End-to-End Test: Cloud Tasks gRPC Workflow
 *
 * Validates the native gRPC surface of the Cloud Tasks emulator using the
 * official @google-cloud/tasks client library without fallback: 'rest'.
 * This exercises the real gRPC code path through google-gax.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { CloudTasksClient } from '@google-cloud/tasks';
import * as grpc from '@grpc/grpc-js';
import type { Server } from 'bun';
import { GrpcServer } from '@/core/gateway/grpc-server.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { CloudTasksService } from '@/services/tasks/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { createFakeAuth } from './e2e-helpers.ts';

// ── Test Infrastructure ──

let emulatorServer: Server;
let grpcServer: GrpcServer;
let tasksService: CloudTasksService;
let client: InstanceType<typeof CloudTasksClient>;

let emulatorPort: number;
let grpcPort: number;

// ── Setup / Teardown ──

beforeAll(async () => {
  emulatorPort = await getAvailablePort();
  grpcPort = await getAvailablePort();

  const storage = new StorageManager();

  await storage.initialize({ type: 'memory' });

  const logger = new Logger('e2e-tasks-grpc', 'error');

  tasksService = new CloudTasksService(storage, logger);
  await tasksService.initialize();
  tasksService.start(500);

  // Start a minimal HTTP server (needed for the REST routes, but gRPC goes elsewhere)
  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: () => new Response('not used in this suite', { status: 404 }),
  });

  // Start gRPC server
  const serverConfig = { httpPort: emulatorPort, grpcPort, maxConnections: 100 };

  grpcServer = new GrpcServer(serverConfig, logger);

  for (const def of tasksService.getGrpcServices()) {
    grpcServer.registerService(def);
  }

  await grpcServer.start();

  // Build gRPC client with insecure credentials (no fallback: 'rest')
  const fakeAuth = createFakeAuth('grpc-test-project');

  client = new CloudTasksClient({
    apiEndpoint: 'localhost',
    port: grpcPort,
    sslCreds: grpc.credentials.createInsecure(),
    auth: fakeAuth as never,
  });
});

afterAll(async () => {
  client.close();
  await grpcServer.stop();
  await tasksService.stop();
  emulatorServer.stop();
});

// ── Tests ──

describe('Cloud Tasks E2E: gRPC', () => {
  const project = 'grpc-test-project';
  const location = 'us-central1';
  const queueId = 'grpc-e2e-queue';
  const queueName = `projects/${project}/locations/${location}/queues/${queueId}`;
  const parent = `projects/${project}/locations/${location}`;

  let createdTaskName: string;

  test('createQueue creates a queue via gRPC', async () => {
    const [queue] = await client.createQueue({
      parent,
      queue: { name: queueName },
    });

    expect(queue.name).toBe(queueName);
    expect(queue.state).toBe('RUNNING');
    expect(queue.rateLimits).toBeDefined();
    expect(queue.retryConfig).toBeDefined();
  });

  test('getQueue returns the queue via gRPC', async () => {
    const [queue] = await client.getQueue({ name: queueName });

    expect(queue.name).toBe(queueName);
    expect(queue.state).toBe('RUNNING');
  });

  test('listQueues returns at least one queue via gRPC', async () => {
    const [queues] = await client.listQueues({ parent });

    expect(queues.length).toBeGreaterThanOrEqual(1);

    const found = queues.find(q => q.name === queueName);

    expect(found).toBeDefined();
  });

  test('createTask creates a task via gRPC', async () => {
    const [task] = await client.createTask({
      parent: queueName,
      task: {
        httpRequest: {
          url: 'http://localhost/grpc-task-callback',
          httpMethod: 'POST',
          headers: { 'X-Grpc-Task': 'true' },
        },
      },
    });

    expect(task.name).toBeTypeOf('string');
    expect(task.name).toContain(queueName);
    expect(task.httpRequest).toBeDefined();

    createdTaskName = task.name as string;
  });

  test('listTasks returns created task via gRPC', async () => {
    const [tasks] = await client.listTasks({ parent: queueName });

    expect(tasks.length).toBeGreaterThanOrEqual(1);

    const found = tasks.find(t => t.name === createdTaskName);

    expect(found).toBeDefined();
  });

  test('deleteTask deletes the task via gRPC', async () => {
    // Create a fresh task for deletion
    const [fresh] = await client.createTask({
      parent: queueName,
      task: {
        httpRequest: {
          url: 'http://localhost/delete-me',
          httpMethod: 'GET',
        },
      },
    });

    const freshName = fresh.name as string;

    await client.deleteTask({ name: freshName });

    const getDeleted = client.getTask({ name: freshName });

    await expect(getDeleted).rejects.toThrow();
  });

  test('getQueue returns NOT_FOUND for missing queue via gRPC', async () => {
    const getMissing = client.getQueue({
      name: `projects/${project}/locations/${location}/queues/does-not-exist`,
    });

    await expect(getMissing).rejects.toThrow();
  });
});
