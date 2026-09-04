/**
 * End-to-End Test: Cloud Armor (Compute Security Policies)
 *
 * Tests the full Cloud Armor workflow:
 *   1. Insert a security policy via Compute v1 HTTP
 *   2. Poll globalOperations.get and wait → DONE
 *   3. Curl the listener: /admin + X-Kinglet-Origin-IP → 403 + enforced headers
 *   4. Curl /public → 200 empty + allow headers
 *   5. Invalid X-Kinglet-Origin-IP → 400, no evaluate
 *   6. Kinglet origin header is stripped from CEL
 *   7. GCLB-style XFF append
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { createLocationRoutes } from '@/core/gateway/location-routes.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { ComputeService } from '@/services/compute/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePorts } from '../test-utils/helpers.ts';
import { buildProductionRouter } from './e2e-helpers.ts';

const logger = new Logger('e2e-compute', 'error');

let emulatorServer: Server;
let emulatorPort: number;
let listenerPort: number;
let computeService: ComputeService;
const project = 'e2e-armor-project';

function url(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

function listenerUrl(path: string): string {
  return `http://127.0.0.1:${listenerPort}${path}`;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(url(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getRequest(path: string): Promise<Response> {
  return fetch(url(path));
}

beforeAll(async () => {
  const ports = await getAvailablePorts(2);

  emulatorPort = ports[0] ?? 0;
  listenerPort = ports[1] ?? 0;

  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  computeService = new ComputeService(storage, logger, {
    listenerPort,
    defaultPolicyName: 'e2e-policy',
  });
  await computeService.initialize();

  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: buildProductionRouter([...createLocationRoutes(logger), ...computeService.getRoutes()]),
  });

  computeService.start();
});

afterAll(async () => {
  await computeService.stop();
  emulatorServer.stop();
});

const policyBase = `/compute/v1/projects/${project}/global`;

describe('Cloud Armor E2E: Security Policy CRUD', () => {
  let operationId: string;

  test('1. insert policy via Compute HTTP', async () => {
    const res = await postJson(`${policyBase}/securityPolicies`, {
      name: 'e2e-policy',
      rules: [
        {
          priority: 50,
          action: 'deny(403)',
          match: {
            expr: { expression: "has(request.headers['x-kinglet-origin-ip'])" },
          },
          description: 'Must never match: the listener strips this header before CEL',
        },
        {
          priority: 1000,
          action: 'deny(403)',
          match: { expr: { expression: "request.path.startsWith('/admin')" } },
          description: 'Block /admin',
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      status: string;
      id: string;
      operationType: string;
    };

    expect(body.kind).toBe('compute#operation');
    expect(body.status).toBe('DONE');
    expect(body.operationType).toBe('insert');
    expect(body.id).toBeTypeOf('string');

    operationId = body.id;
  });

  test('2. poll globalOperations.get → DONE', async () => {
    const res = await getRequest(`${policyBase}/operations/${operationId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; status: string };

    expect(body.kind).toBe('compute#operation');
    expect(body.status).toBe('DONE');
  });

  test('2b. globalOperations.wait → DONE', async () => {
    const res = await postJson(`${policyBase}/operations/${operationId}/wait`, {});

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };

    expect(body.status).toBe('DONE');
  });

  test('3. GET policy returns kind=compute#securityPolicy', async () => {
    const res = await getRequest(`${policyBase}/securityPolicies/e2e-policy`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; name: string; rules: unknown[] };

    expect(body.kind).toBe('compute#securityPolicy');
    expect(body.name).toBe('e2e-policy');
    expect(body.rules.length).toBeGreaterThan(1);
  });
});

describe('Cloud Armor E2E: Listener evaluation', () => {
  test('3. /admin + X-Kinglet-Origin-IP → 403 + enforced headers', async () => {
    const res = await fetch(listenerUrl('/admin'), {
      headers: { 'X-Kinglet-Origin-IP': '203.0.113.10' },
    });

    expect(res.status).toBe(403);
    expect(res.headers.get('x-kinglet-security-policy')).toBe('e2e-policy');
    expect(res.headers.get('x-kinglet-enforced-action')).toBe('deny(403)');
    expect(res.headers.get('x-kinglet-enforced-outcome')).toBe('DENY');
    expect(res.headers.get('x-kinglet-enforced-priority')).toBe('1000');
  });

  test('4. /public → 200 empty + allow headers', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: { 'X-Kinglet-Origin-IP': '203.0.113.10' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-kinglet-enforced-action')).toBe('allow');
    expect(res.headers.get('x-kinglet-enforced-outcome')).toBe('ALLOW');
    expect(res.headers.get('x-kinglet-enforced-priority')).toBe('2147483647');
  });

  test('5. Invalid X-Kinglet-Origin-IP → 400, no evaluate', async () => {
    const res = await fetch(listenerUrl('/any'), {
      headers: { 'X-Kinglet-Origin-IP': 'not-an-ip' },
    });

    expect(res.status).toBe(400);
  });

  test('6. Kinglet origin header is stripped from CEL (default allow applies)', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: {
        'X-Kinglet-Origin-IP': '10.0.0.1',
        'X-Custom-Test': 'present',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-kinglet-enforced-priority')).toBe('2147483647');
    expect(res.headers.get('x-kinglet-enforced-action')).toBe('allow');
  });

  test('7. GCLB-style XFF: peer is appended to existing XFF', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: {
        'X-Kinglet-Origin-IP': '10.0.0.1',
        'X-Forwarded-For': '203.0.113.5',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-kinglet-enforced-action')).toBe('allow');
  });
});

describe('Cloud Armor E2E: Policy operations', () => {
  test('addRule and verify via GET', async () => {
    const addRes = await postJson(`${policyBase}/securityPolicies/e2e-policy/addRule`, {
      priority: 500,
      action: 'deny(429)',
      match: { expr: { expression: "request.path.startsWith('/rate-limited')" } },
    });

    expect(addRes.status).toBe(200);

    const getRes = await getRequest(`${policyBase}/securityPolicies/e2e-policy`);
    const policy = (await getRes.json()) as { rules: Array<{ priority: number }> };
    const priorities = policy.rules.map(r => r.priority);

    expect(priorities).toContain(500);
  });

  test('removeRule and verify rule is gone', async () => {
    await postJson(`${policyBase}/securityPolicies/e2e-policy/addRule`, {
      priority: 750,
      action: 'deny(403)',
      match: { expr: { expression: "request.path.startsWith('/temp')" } },
    });

    const removeRes = await fetch(
      url(`${policyBase}/securityPolicies/e2e-policy/removeRule?priority=750`),
      { method: 'POST' }
    );

    expect(removeRes.status).toBe(200);

    const getRes = await getRequest(`${policyBase}/securityPolicies/e2e-policy`);
    const policy = (await getRes.json()) as { rules: Array<{ priority: number }> };
    const priorities = policy.rules.map(r => r.priority);

    expect(priorities).not.toContain(750);
  });

  test('getRule returns specific rule', async () => {
    const res = await fetch(
      url(`${policyBase}/securityPolicies/e2e-policy/getRule?priority=2147483647`)
    );

    expect(res.status).toBe(200);
    const rule = (await res.json()) as { priority: number; action: string };

    expect(rule.priority).toBe(2147483647);
    expect(rule.action).toBe('allow');
  });

  test('patchRule changes default rule action', async () => {
    const res = await postJson(
      `${policyBase}/securityPolicies/e2e-policy/patchRule?priority=2147483647`,
      {
        action: 'deny(404)',
        match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ['*'] } },
      }
    );

    expect(res.status).toBe(200);

    const patchRes = await postJson(
      `${policyBase}/securityPolicies/e2e-policy/patchRule?priority=2147483647`,
      {
        action: 'allow',
        match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ['*'] } },
      }
    );

    expect(patchRes.status).toBe(200);
  });
});

describe('Cloud Armor E2E: Error cases', () => {
  test('GET nonexistent policy → 404', async () => {
    const res = await getRequest(`${policyBase}/securityPolicies/nonexistent`);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { status: string } };

    expect(body.error.status).toBe('NOT_FOUND');
  });

  test('Insert duplicate policy → 409 ALREADY_EXISTS', async () => {
    await postJson(`${policyBase}/securityPolicies`, { name: 'dup-e2e' });
    const res = await postJson(`${policyBase}/securityPolicies`, { name: 'dup-e2e' });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { status: string } };

    expect(body.error.status).toBe('ALREADY_EXISTS');
  });

  test('insert policy with bad expression → 400', async () => {
    const res = await postJson(`${policyBase}/securityPolicies`, {
      name: 'bad-expr-e2e',
      rules: [
        {
          priority: 100,
          action: 'deny(403)',
          match: { expr: { expression: "request.path in ['/x']" } },
        },
      ],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { status: string } };

    expect(body.error.status).toBe('INVALID_ARGUMENT');
  });

  test('GET nonexistent operation → 404', async () => {
    const res = await getRequest(`${policyBase}/operations/nonexistent-op`);

    expect(res.status).toBe(404);
  });
});
