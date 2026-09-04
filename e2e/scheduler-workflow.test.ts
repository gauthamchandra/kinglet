/**
 * End-to-End Test: Cloud Scheduler Workflow
 *
 * True black-box tests — validates the full lifecycle through HTTP only.
 * Two test paths:
 *   1. Raw HTTP fetch against the emulator
 *   2. Official @google-cloud/scheduler client library
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { CloudSchedulerClient } from '@google-cloud/scheduler';
import type { Server } from 'bun';
import { StorageManager } from '@/core/storage/manager.ts';
import { SchedulerService } from '@/services/scheduler/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import type { CallbackRecord } from './e2e-helpers.ts';
import { buildRouter, createFakeAuth, waitForCallback } from './e2e-helpers.ts';

// ── Test Infrastructure ──

let callbackServer: Server;
let emulatorServer: Server;
let callbackPort: number;
let emulatorPort: number;
let schedulerService: SchedulerService;
const callbackRequests: CallbackRecord[] = [];

function emulatorUrl(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

function callbackUrl(path: string = '/callback'): string {
  return `http://localhost:${callbackPort}${path}`;
}

// ── Setup / Teardown ──

beforeAll(async () => {
  // 1. Start callback server (records incoming requests)
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

  // 2. Start emulator server with scheduler service
  emulatorPort = await getAvailablePort();

  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const logger = new Logger('e2e-scheduler', 'error');
  schedulerService = new SchedulerService(storage, logger);
  await schedulerService.initialize();

  const routes = schedulerService.getRoutes();
  const router = buildRouter(routes);

  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: router,
  });
});

afterAll(async () => {
  await schedulerService.stop();
  emulatorServer.stop();
  callbackServer.stop();
});

// ── Test Path 1: Raw HTTP Fetch ──

describe('Cloud Scheduler E2E: Raw HTTP API', () => {
  const project = 'test-project';
  const location = 'us-central1';
  const jobId = 'e2e-test-job';
  const jobsBasePath = `/v1/projects/${project}/locations/${location}/jobs`;

  test('1. Create a job targeting the callback server', async () => {
    const response = await fetch(emulatorUrl(jobsBasePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId,
        schedule: '* * * * *',
        timeZone: 'UTC',
        description: 'E2E test job',
        httpTarget: {
          uri: callbackUrl('/callback'),
          httpMethod: 'POST',
          headers: { 'X-E2E-Test': 'true', 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify({ message: 'hello from scheduler' })).toString('base64'),
        },
      }),
    });

    expect(response.status).toBe(200);

    const job = await response.json();

    expect(job.name).toBe(`projects/${project}/locations/${location}/jobs/${jobId}`);
    expect(job.state).toBe('ENABLED');
    expect(job.schedule).toBe('* * * * *');
    expect(job.httpTarget.uri).toBe(callbackUrl('/callback'));
    expect(job.scheduleTime).toBeDefined();
  });

  test('2. Get the job and verify it exists', async () => {
    const response = await fetch(emulatorUrl(`${jobsBasePath}/${jobId}`));

    expect(response.status).toBe(200);

    const job = await response.json();

    expect(job.name).toBe(`projects/${project}/locations/${location}/jobs/${jobId}`);
    expect(job.state).toBe('ENABLED');
  });

  test('3. List jobs', async () => {
    const response = await fetch(emulatorUrl(jobsBasePath));

    expect(response.status).toBe(200);

    const result = await response.json();

    expect(result.jobs).toBeDefined();
    expect(result.jobs.length).toBeGreaterThanOrEqual(1);
  });

  test('4. Trigger manual run and verify callback fires', async () => {
    callbackRequests.length = 0;

    const runResponse = await fetch(emulatorUrl(`${jobsBasePath}/${jobId}:run`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(runResponse.status).toBe(200);

    // runJob now actually executes the HTTP target via the execution engine callback
    await waitForCallback(callbackRequests, 1, 3000);

    expect(callbackRequests.length).toBeGreaterThanOrEqual(1);

    const callback = callbackRequests[0];

    expect(callback?.method).toBe('POST');
    expect(callback?.headers['x-e2e-test']).toBe('true');

    const body = JSON.parse(callback?.body ?? '{}');

    expect(body.message).toBe('hello from scheduler');
  });

  test('5. Pause the job', async () => {
    const response = await fetch(emulatorUrl(`${jobsBasePath}/${jobId}:pause`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);

    const job = await response.json();

    expect(job.state).toBe('PAUSED');
  });

  test('6. Resume the job', async () => {
    const response = await fetch(emulatorUrl(`${jobsBasePath}/${jobId}:resume`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);

    const job = await response.json();

    expect(job.state).toBe('ENABLED');
    expect(job.scheduleTime).toBeDefined();
  });

  test('7. Update the job', async () => {
    const response = await fetch(emulatorUrl(`${jobsBasePath}/${jobId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'Updated E2E job',
      }),
    });

    expect(response.status).toBe(200);

    const job = await response.json();

    expect(job.description).toBe('Updated E2E job');
  });

  test('8. Delete the job and verify 404', async () => {
    const deleteResponse = await fetch(emulatorUrl(`${jobsBasePath}/${jobId}`), {
      method: 'DELETE',
    });

    expect(deleteResponse.status).toBe(200);

    const getResponse = await fetch(emulatorUrl(`${jobsBasePath}/${jobId}`));

    expect(getResponse.status).toBe(404);
  });
});

// ── Test Path 2: Official @google-cloud/scheduler Client Library ──

describe('Cloud Scheduler E2E: Client Library', () => {
  const project = 'client-lib-project';
  const location = 'us-central1';
  const jobId = 'client-lib-job';
  const jobName = `projects/${project}/locations/${location}/jobs/${jobId}`;

  let client: InstanceType<typeof CloudSchedulerClient>;

  beforeAll(() => {
    const fakeAuth = createFakeAuth(project);

    client = new CloudSchedulerClient({
      fallback: 'rest',
      apiEndpoint: 'localhost',
      port: emulatorPort,
      protocol: 'http',
      auth: fakeAuth as never,
    });
  });

  test('1. Create a job via client library', async () => {
    const [job] = await client.createJob({
      parent: `projects/${project}/locations/${location}`,
      job: {
        name: jobName,
        schedule: '*/5 * * * *',
        timeZone: 'UTC',
        description: 'Client library E2E job',
        httpTarget: {
          uri: callbackUrl('/client-callback'),
          httpMethod: 'POST',
          headers: { 'X-Client-Test': 'true' },
          body: Buffer.from(JSON.stringify({ source: 'client-lib' })),
        },
      },
    });

    expect(job.name).toBe(jobName);
    expect(job.state).toBe('ENABLED');
    expect(job.schedule).toBe('*/5 * * * *');
  });

  test('2. Get the job via client library', async () => {
    const [job] = await client.getJob({ name: jobName });

    expect(job.name).toBe(jobName);
    expect(job.description).toBe('Client library E2E job');
  });

  test('3. List jobs via client library', async () => {
    const [jobs] = await client.listJobs({
      parent: `projects/${project}/locations/${location}`,
    });

    expect(jobs.length).toBeGreaterThanOrEqual(1);

    const found = jobs.find((j: Record<string, unknown>) => j.name === jobName);

    expect(found).toBeDefined();
  });

  test('4. Run job via client library and verify callback', async () => {
    callbackRequests.length = 0;

    const [job] = await client.runJob({ name: jobName });

    expect(job.name).toBe(jobName);

    await waitForCallback(callbackRequests, 1, 3000);

    expect(callbackRequests.length).toBeGreaterThanOrEqual(1);

    const callback = callbackRequests.find(r => r.url.includes('/client-callback'));

    expect(callback).toBeDefined();
    expect(callback?.method).toBe('POST');
    expect(callback?.headers['x-client-test']).toBe('true');
  });

  test('5. Pause job via client library', async () => {
    const [job] = await client.pauseJob({ name: jobName });

    expect(job.state).toBe('PAUSED');
  });

  test('6. Resume job via client library', async () => {
    const [job] = await client.resumeJob({ name: jobName });

    expect(job.state).toBe('ENABLED');
  });

  test('7. Update job via client library', async () => {
    const [job] = await client.updateJob({
      job: {
        name: jobName,
        description: 'Updated via client lib',
      },
      updateMask: { paths: ['description'] },
    });

    expect(job.description).toBe('Updated via client lib');
  });

  test('8. Delete job via client library and verify not found', async () => {
    await client.deleteJob({ name: jobName });

    const promise = client.getJob({ name: jobName });

    await expect(promise).rejects.toThrow(/not found/i);
  });
});
