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
 *   8. ASN / region overrides match CEL attributes
 *   9. Invalid X-Kinglet-Origin-ASN → 400
 *  10. Kinglet ASN / region headers are stripped from CEL
 *  11. JA3 override matches origin.tls_ja3_fingerprint
 *  12. Invalid X-Kinglet-Origin-JA3 → 400
 *  13. Kinglet JA3 header is stripped from CEL
 *  14. SNI throttle is per X-Kinglet-Origin-SNI
 *  15. Invalid X-Kinglet-Origin-SNI → 400
 *  16. Kinglet SNI header is stripped from CEL
 *  17. WAF opt_out of the injected signature → default allow
 *  18. WAF other signature in the same set → 403
 *  19. Invalid X-Kinglet-Waf-Match → 400
 *  20. Kinglet WAF header is stripped from CEL
 *  21. X-Kinglet-Adaptive-Protection: true → 403
 *  22. Invalid X-Kinglet-Adaptive-Protection → 400
 *  23. Kinglet Adaptive Protection header is stripped from CEL
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
          priority: 51,
          action: 'deny(403)',
          match: {
            expr: { expression: "has(request.headers['x-kinglet-origin-asn'])" },
          },
          description: 'Must never match: the listener strips this header before CEL',
        },
        {
          priority: 52,
          action: 'deny(403)',
          match: {
            expr: { expression: "has(request.headers['x-kinglet-origin-region-code'])" },
          },
          description: 'Must never match: the listener strips this header before CEL',
        },
        {
          priority: 53,
          action: 'deny(403)',
          match: {
            expr: { expression: "has(request.headers['x-kinglet-origin-ja3'])" },
          },
          description: 'Must never match: the listener strips this header before CEL',
        },
        {
          priority: 54,
          action: 'deny(403)',
          match: {
            expr: { expression: "has(request.headers['x-kinglet-origin-sni'])" },
          },
          description: 'Must never match: the listener strips this header before CEL',
        },
        {
          priority: 55,
          action: 'deny(403)',
          match: {
            expr: { expression: "has(request.headers['x-kinglet-waf-match'])" },
          },
          description: 'Must never match: the listener strips this header before CEL',
        },
        {
          priority: 56,
          action: 'deny(403)',
          match: {
            expr: { expression: "has(request.headers['x-kinglet-adaptive-protection'])" },
          },
          description: 'Must never match: the listener strips this header before CEL',
        },
        {
          priority: 1000,
          action: 'deny(403)',
          match: { expr: { expression: "request.path.startsWith('/admin')" } },
          description: 'Block /admin',
        },
        {
          priority: 2000,
          action: 'deny(403)',
          match: {
            expr: { expression: "origin.asn == 15169 && origin.region_code == 'US'" },
          },
          description: 'Block advertised Google ASN from US',
        },
        {
          priority: 2100,
          action: 'deny(403)',
          match: {
            expr: {
              expression: "origin.tls_ja3_fingerprint == 'e7d705a3286e19ea42f587a344ee6862'",
            },
          },
          description: 'Block a known JA3 fingerprint',
        },
        {
          priority: 2200,
          action: 'throttle',
          match: { expr: { expression: "request.path.startsWith('/sni-limited')" } },
          description: 'Throttle /sni-limited per SNI',
          rateLimitOptions: {
            conformAction: 'allow',
            exceedAction: 'deny(429)',
            enforceOnKey: 'SNI',
            rateLimitThreshold: { count: 1, intervalSec: 60 },
          },
        },
        {
          priority: 2300,
          action: 'deny(403)',
          match: {
            expr: {
              expression:
                "evaluatePreconfiguredWaf('protocolattack-v33-stable', {'opt_out_rule_ids': ['owasp-crs-v030301-id921110-protocolattack']})",
            },
          },
          description: 'WAF protocolattack except the opted-out signature',
        },
        {
          priority: 2400,
          action: 'deny(403)',
          match: { expr: { expression: 'evaluateAdaptiveProtectionAutoDeploy()' } },
          description: 'Adaptive Protection auto-deploy declared hit',
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

  test('8. ASN and region overrides match origin.asn / origin.region_code', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: {
        'X-Kinglet-Origin-IP': '203.0.113.10',
        'X-Kinglet-Origin-ASN': '15169',
        'X-Kinglet-Origin-Region-Code': 'us',
      },
    });

    expect(res.status).toBe(403);
    expect(res.headers.get('x-kinglet-enforced-action')).toBe('deny(403)');
    expect(res.headers.get('x-kinglet-enforced-priority')).toBe('2000');
  });

  test('9. Invalid X-Kinglet-Origin-ASN → 400, no evaluate', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: {
        'X-Kinglet-Origin-IP': '203.0.113.10',
        'X-Kinglet-Origin-ASN': 'not-an-asn',
      },
    });

    expect(res.status).toBe(400);
  });

  test('10. Kinglet ASN and region headers are stripped from CEL', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: {
        'X-Kinglet-Origin-IP': '203.0.113.10',
        'X-Kinglet-Origin-ASN': '1',
        'X-Kinglet-Origin-Region-Code': 'AU',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-kinglet-enforced-action')).toBe('allow');
    expect(res.headers.get('x-kinglet-enforced-priority')).toBe('2147483647');
  });

  test('11. JA3 override matches origin.tls_ja3_fingerprint', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: {
        'X-Kinglet-Origin-IP': '203.0.113.10',
        'X-Kinglet-Origin-JA3': 'e7d705a3286e19ea42f587a344ee6862',
      },
    });

    expect(res.status).toBe(403);
    expect(res.headers.get('x-kinglet-enforced-action')).toBe('deny(403)');
    expect(res.headers.get('x-kinglet-enforced-priority')).toBe('2100');
  });

  test('12. Invalid X-Kinglet-Origin-JA3 → 400, no evaluate', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: {
        'X-Kinglet-Origin-IP': '203.0.113.10',
        'X-Kinglet-Origin-JA3': 'not-a-ja3',
      },
    });

    expect(res.status).toBe(400);
  });

  test('13. Kinglet JA3 header is stripped from CEL', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: {
        'X-Kinglet-Origin-IP': '203.0.113.10',
        'X-Kinglet-Origin-JA3': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-kinglet-enforced-action')).toBe('allow');
    expect(res.headers.get('x-kinglet-enforced-priority')).toBe('2147483647');
  });

  test('14. SNI throttle is sequential and per X-Kinglet-Origin-SNI', async () => {
    const first = await fetch(listenerUrl('/sni-limited'), {
      headers: {
        'X-Kinglet-Origin-IP': '203.0.113.50',
        'X-Kinglet-Origin-SNI': 'cdn.example.com',
      },
    });
    const second = await fetch(listenerUrl('/sni-limited'), {
      headers: {
        'X-Kinglet-Origin-IP': '203.0.113.50',
        'X-Kinglet-Origin-SNI': 'cdn.example.com',
      },
    });
    const other = await fetch(listenerUrl('/sni-limited'), {
      headers: {
        'X-Kinglet-Origin-IP': '203.0.113.51',
        'X-Kinglet-Origin-SNI': 'other.example.com',
      },
    });

    expect(first.status).toBe(200);
    expect(first.headers.get('x-kinglet-enforced-priority')).toBe('2200');
    expect(second.status).toBe(429);
    expect(second.headers.get('x-kinglet-enforced-action')).toBe('deny(429)');
    expect(other.status).toBe(200);
    expect(other.headers.get('x-kinglet-enforced-priority')).toBe('2200');
  });

  test('15. Invalid X-Kinglet-Origin-SNI → 400, no evaluate', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: {
        'X-Kinglet-Origin-IP': '203.0.113.10',
        'X-Kinglet-Origin-SNI': 'not a host',
      },
    });

    expect(res.status).toBe(400);
  });

  test('16. Kinglet SNI header is stripped from CEL', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: {
        'X-Kinglet-Origin-IP': '203.0.113.10',
        'X-Kinglet-Origin-SNI': 'cdn.example.com',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-kinglet-enforced-action')).toBe('allow');
    expect(res.headers.get('x-kinglet-enforced-priority')).toBe('2147483647');
  });

  test('17. WAF opted-out signature does not match', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: {
        'X-Kinglet-Origin-IP': '203.0.113.10',
        'X-Kinglet-Waf-Match':
          'protocolattack-v33-stable/owasp-crs-v030301-id921110-protocolattack',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-kinglet-enforced-action')).toBe('allow');
    expect(res.headers.get('x-kinglet-enforced-priority')).toBe('2147483647');
  });

  test('18. WAF other signature in the same set → 403', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: {
        'X-Kinglet-Origin-IP': '203.0.113.10',
        'X-Kinglet-Waf-Match':
          'protocolattack-v33-stable/owasp-crs-v030301-id921150-protocolattack',
      },
    });

    expect(res.status).toBe(403);
    expect(res.headers.get('x-kinglet-enforced-action')).toBe('deny(403)');
    expect(res.headers.get('x-kinglet-enforced-priority')).toBe('2300');
  });

  test('19. Invalid X-Kinglet-Waf-Match → 400, no evaluate', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: {
        'X-Kinglet-Origin-IP': '203.0.113.10',
        'X-Kinglet-Waf-Match': 'protocolattack-v33-stable',
      },
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('x-kinglet-enforced-action')).toBeNull();
  });

  test('20. Kinglet WAF header is stripped from CEL', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: {
        'X-Kinglet-Origin-IP': '203.0.113.10',
        'X-Kinglet-Waf-Match':
          'protocolattack-v33-stable/owasp-crs-v030301-id921110-protocolattack',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-kinglet-enforced-priority')).toBe('2147483647');
  });

  test('21. X-Kinglet-Adaptive-Protection: true → 403', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: {
        'X-Kinglet-Origin-IP': '203.0.113.10',
        'X-Kinglet-Adaptive-Protection': 'true',
      },
    });

    expect(res.status).toBe(403);
    expect(res.headers.get('x-kinglet-enforced-action')).toBe('deny(403)');
    expect(res.headers.get('x-kinglet-enforced-priority')).toBe('2400');
  });

  test('22. Invalid X-Kinglet-Adaptive-Protection → 400, no evaluate', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: {
        'X-Kinglet-Origin-IP': '203.0.113.10',
        'X-Kinglet-Adaptive-Protection': 'yes',
      },
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('x-kinglet-enforced-action')).toBeNull();
  });

  test('23. Kinglet Adaptive Protection header is stripped from CEL', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: {
        'X-Kinglet-Origin-IP': '203.0.113.10',
        'X-Kinglet-Adaptive-Protection': 'false',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-kinglet-enforced-action')).toBe('allow');
    expect(res.headers.get('x-kinglet-enforced-priority')).toBe('2147483647');
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
