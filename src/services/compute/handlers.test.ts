/**
 * Compute HTTP handler tests (TDD slice 2).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { RequestRouter } from '@/core/gateway/request-router.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { ComputeHandlers } from './handlers.ts';
import { SecurityPolicyService } from './service.ts';

const PROJECT = 'test-project';
const logger = new Logger('test-handlers', 'error');
const BASE = `/compute/v1/projects/${PROJECT}/global`;

let storage: StorageManager;
let service: SecurityPolicyService;
let handlers: ComputeHandlers;
let router: RequestRouter;

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });
  service = new SecurityPolicyService(storage, logger);
  await service.initialize();
  handlers = new ComputeHandlers(service, logger);
  router = new RequestRouter(logger);

  for (const route of handlers.getRoutes()) {
    router.addRoute(route);
  }
});

afterEach(async () => {
  await storage.close();
});

async function request(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>
): Promise<Response> {
  const url = new URL(`http://localhost${path}`);

  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }

  const init: RequestInit = { method };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }

  return router.route(new Request(url.toString(), init));
}

describe('securityPolicies.insert', () => {
  test('POST returns 200 with operation body', async () => {
    const res = await request('POST', `${BASE}/securityPolicies`, {
      name: 'my-policy',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.kind).toBe('compute#operation');
    expect(body.status).toBe('DONE');
    expect(body.operationType).toBe('insert');
    expect(body.targetLink).toContain('my-policy');
  });

  test('POST with rules returns 200', async () => {
    const res = await request('POST', `${BASE}/securityPolicies`, {
      name: 'pol',
      rules: [
        {
          priority: 1000,
          action: 'deny(403)',
          match: { expr: { expression: "request.path.startsWith('/admin')" } },
        },
      ],
    });

    expect(res.status).toBe(200);
  });

  test('POST duplicate policy returns 409', async () => {
    await request('POST', `${BASE}/securityPolicies`, { name: 'pol' });
    const res = await request('POST', `${BASE}/securityPolicies`, { name: 'pol' });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { status: string } };

    expect(body.error.status).toBe('ALREADY_EXISTS');
  });

  test('POST bad expression returns 400', async () => {
    const res = await request('POST', `${BASE}/securityPolicies`, {
      name: 'pol',
      rules: [
        {
          priority: 100,
          action: 'deny(403)',
          match: { expr: { expression: "request.path in ['/a']" } },
        },
      ],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { status: string } };

    expect(body.error.status).toBe('INVALID_ARGUMENT');
  });
});

describe('securityPolicies.get', () => {
  test('GET existing policy returns 200', async () => {
    await request('POST', `${BASE}/securityPolicies`, { name: 'pol' });

    const res = await request('GET', `${BASE}/securityPolicies/pol`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; kind: string };

    expect(body.kind).toBe('compute#securityPolicy');
    expect(body.name).toBe('pol');
  });

  test('GET non-existent policy returns 404', async () => {
    const res = await request('GET', `${BASE}/securityPolicies/nonexistent`);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { status: string } };

    expect(body.error.status).toBe('NOT_FOUND');
  });
});

describe('securityPolicies.list', () => {
  test('GET returns 200 with list', async () => {
    await request('POST', `${BASE}/securityPolicies`, { name: 'pol1' });
    await request('POST', `${BASE}/securityPolicies`, { name: 'pol2' });

    const res = await request('GET', `${BASE}/securityPolicies`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; items?: unknown[] };

    expect(body.kind).toBe('compute#securityPolicyList');
    expect(body.items).toHaveLength(2);
  });

  test('GET empty list returns 200 without items', async () => {
    const res = await request('GET', `${BASE}/securityPolicies`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items?: unknown[] };

    expect(body.items).toBeUndefined();
  });
});

describe('securityPolicies.patch', () => {
  test('PATCH returns 200 with operation', async () => {
    await request('POST', `${BASE}/securityPolicies`, { name: 'pol' });

    const res = await request('PATCH', `${BASE}/securityPolicies/pol`, { description: 'updated' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; status: string };

    expect(body.kind).toBe('compute#operation');
    expect(body.status).toBe('DONE');
  });

  test('PATCH non-existent policy returns 404', async () => {
    const res = await request('PATCH', `${BASE}/securityPolicies/nonexistent`, {
      description: 'x',
    });

    expect(res.status).toBe(404);
  });
});

describe('securityPolicies.delete', () => {
  test('DELETE returns 200 with operation', async () => {
    await request('POST', `${BASE}/securityPolicies`, { name: 'pol' });

    const res = await request('DELETE', `${BASE}/securityPolicies/pol`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; operationType: string };

    expect(body.kind).toBe('compute#operation');
    expect(body.operationType).toBe('delete');
  });

  test('DELETE non-existent returns 404', async () => {
    const res = await request('DELETE', `${BASE}/securityPolicies/nonexistent`);

    expect(res.status).toBe(404);
  });
});

describe('securityPolicies rule RPCs', () => {
  test('addRule POST returns 200', async () => {
    await request('POST', `${BASE}/securityPolicies`, { name: 'pol' });

    const res = await request('POST', `${BASE}/securityPolicies/pol/addRule`, {
      priority: 500,
      action: 'deny(403)',
      match: { expr: { expression: "request.path.startsWith('/x')" } },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };

    expect(body.kind).toBe('compute#operation');
  });

  test('getRule GET returns 200', async () => {
    await request('POST', `${BASE}/securityPolicies`, { name: 'pol' });

    const res = await request('GET', `${BASE}/securityPolicies/pol/getRule`, undefined, {
      priority: '2147483647',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { priority: number };

    expect(body.priority).toBe(2147483647);
  });

  test('removeRule POST returns 200', async () => {
    await request('POST', `${BASE}/securityPolicies`, {
      name: 'pol',
      rules: [
        {
          priority: 500,
          action: 'deny(403)',
          match: { expr: { expression: "request.path.startsWith('/x')" } },
        },
      ],
    });

    const res = await request('POST', `${BASE}/securityPolicies/pol/removeRule`, undefined, {
      priority: '500',
    });

    expect(res.status).toBe(200);
  });

  test('patchRule POST returns 200', async () => {
    await request('POST', `${BASE}/securityPolicies`, { name: 'pol' });

    const res = await request(
      'POST',
      `${BASE}/securityPolicies/pol/patchRule`,
      {
        action: 'deny(403)',
        match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ['*'] } },
      },
      { priority: '2147483647' }
    );

    expect(res.status).toBe(200);
  });
});

describe('globalOperations', () => {
  test('GET operation returns 200', async () => {
    const insertRes = await request('POST', `${BASE}/securityPolicies`, { name: 'pol' });
    const op = (await insertRes.json()) as { id: string };

    const res = await request('GET', `${BASE}/operations/${op.id}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; status: string; id: string };

    expect(body.kind).toBe('compute#operation');
    expect(body.status).toBe('DONE');
    expect(body.id).toBe(op.id);
  });

  test('GET non-existent operation returns 404', async () => {
    const res = await request('GET', `${BASE}/operations/nonexistent`);

    expect(res.status).toBe(404);
  });

  test('POST wait returns 200 with operation', async () => {
    const insertRes = await request('POST', `${BASE}/securityPolicies`, { name: 'pol' });
    const op = (await insertRes.json()) as { id: string };

    const res = await request('POST', `${BASE}/operations/${op.id}/wait`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; status: string };

    expect(body.kind).toBe('compute#operation');
    expect(body.status).toBe('DONE');
  });
});

describe('error envelope shape', () => {
  test('error has code, message, status', async () => {
    const res = await request('GET', `${BASE}/securityPolicies/nonexistent`);

    const body = (await res.json()) as { error: { code: number; message: string; status: string } };

    expect(body.error.code).toBe(404);
    expect(body.error.message).toBeTypeOf('string');
    expect(body.error.status).toBe('NOT_FOUND');
  });
});
