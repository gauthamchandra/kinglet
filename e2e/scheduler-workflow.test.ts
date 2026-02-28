/**
 * End-to-End Test: Cloud Scheduler Workflow
 *
 * True black-box tests — validates the full lifecycle through HTTP only.
 * Two test paths:
 *   1. Raw HTTP fetch against the emulator
 *   2. Official @google-cloud/scheduler client library
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { Server } from 'bun';
import { CloudSchedulerClient } from '@google-cloud/scheduler';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { SchedulerService } from '@/services/scheduler/index.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import type { RouteDefinition } from '@/core/gateway/request-router.ts';

// ── Test Infrastructure ──

interface CallbackRecord {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  receivedAt: number;
}

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

/**
 * Build a simple request router from RouteDefinition[] for use with Bun.serve
 */
function buildRouter(routes: RouteDefinition[]) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;

    for (const route of routes) {
      if (route.method !== method) continue;

      const params = matchRoute(route.path, pathname);

      if (params) {
        const query: Record<string, string> = {};

        for (const [key, value] of url.searchParams.entries()) {
          query[key] = value;
        }

        let body: unknown;
        const contentType = request.headers.get('content-type') ?? '';

        if (contentType.includes('application/json')) {
          try {
            body = await request.json();
          } catch {
            body = undefined;
          }
        }

        const routeRequest = {
          method,
          path: pathname,
          query,
          headers: Object.fromEntries(request.headers.entries()),
          params,
          body,
          originalRequest: request,
        };

        const context = {
          routeId: route.id,
          startTime: Date.now(),
          metadata: {},
          logger: new Logger('e2e', 'error'),
        };

        const result = await route.handler(routeRequest, context);

        return new Response(result.body !== undefined ? JSON.stringify(result.body) : null, {
          status: result.status,
          headers: {
            'content-type': 'application/json',
            ...(result.headers ?? {}),
          },
        });
      }
    }

    return new Response(
      JSON.stringify({ error: { code: 404, message: 'Not Found', status: 'NOT_FOUND' } }),
      {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }
    );
  };
}

/**
 * Simple route pattern matcher: converts :param patterns to extracted values.
 * Handles GCP action suffixes like :pause, :resume, :run on the last segment.
 * E.g., pattern "/jobs/:jobId:pause" matches path "/jobs/my-job:pause"
 */
function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i] ?? '';
    const pathPart = pathParts[i] ?? '';

    // Check for action suffix pattern like :jobId:pause
    const actionMatch = pp.match(/^:([^:]+)(:[a-z]+)$/);

    if (actionMatch) {
      const paramName = actionMatch[1] as string;
      const actionSuffix = actionMatch[2] as string;

      if (!pathPart.endsWith(actionSuffix)) return null;

      params[paramName] = pathPart.substring(0, pathPart.length - actionSuffix.length);
    } else if (pp.startsWith(':')) {
      params[pp.substring(1)] = pathPart;
    } else if (pp !== pathPart) {
      return null;
    }
  }

  return params;
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

// ── Helpers ──

async function waitForCallback(expectedCount: number = 1, timeoutMs: number = 5000): Promise<void> {
  const start = Date.now();

  while (callbackRequests.length < expectedCount) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timeout waiting for ${expectedCount} callback(s). Got ${callbackRequests.length}.`
      );
    }

    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

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
    await waitForCallback(1, 3000);

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;

  beforeAll(() => {
    // Create a fake auth that passes requests through without real GCP credentials.
    // google-gax's generateServiceStub calls auth.fetch() directly (not auth.getClient().fetch())
    const fakeAuth = {
      fetch: (url: string, opts: RequestInit) => fetch(url, opts),
      getClient: () =>
        Promise.resolve({
          fetch: (url: string, opts: RequestInit) => fetch(url, opts),
        }),
      getProjectId: () => Promise.resolve(project),
    };

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

    await waitForCallback(1, 3000);

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

    try {
      await client.getJob({ name: jobName });
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect((err as Error).message.toLowerCase()).toContain('not found');
    }
  });
});
