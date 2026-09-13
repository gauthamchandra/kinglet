/**
 * End-to-End Test: Cloud Armor evaluateAddressGroup
 *
 * Creates a Network Security address group and a Compute security policy
 * that names it, then hits the evaluation server.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { createLocationRoutes } from '@/core/gateway/location-routes.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { ComputeService } from '@/services/compute/index.ts';
import { NetworkSecurityService } from '@/services/networksecurity/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePorts } from '../test-utils/helpers.ts';
import { buildProductionRouter } from './e2e-helpers.ts';

const logger = new Logger('e2e-armor-address-group', 'error');

let emulatorServer: Server;
let emulatorPort: number;
let listenerPort: number;
let computeService: ComputeService;
let networkSecurityService: NetworkSecurityService;

const project = 'e2e-ag-project';
const groupId = 'malicious-ips';
const policyName = 'e2e-ag-policy';
const collection = `/v1/projects/${project}/locations/global/addressGroups`;
const policyBase = `/compute/v1/projects/${project}/global`;

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

beforeAll(async () => {
  const ports = await getAvailablePorts(2);

  emulatorPort = ports[0] ?? 0;
  listenerPort = ports[1] ?? 0;

  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  computeService = new ComputeService(storage, logger, {
    listenerPort,
    defaultPolicyName: policyName,
  });
  networkSecurityService = new NetworkSecurityService(storage, logger);

  await computeService.initialize();
  await networkSecurityService.initialize();

  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: buildProductionRouter([
      ...createLocationRoutes(logger),
      ...computeService.getRoutes(),
      ...networkSecurityService.getRoutes(),
    ]),
  });

  computeService.start();
  networkSecurityService.start();
});

afterAll(async () => {
  await computeService.stop();
  await networkSecurityService.stop();
  emulatorServer.stop();
});

describe('Cloud Armor E2E: evaluateAddressGroup', () => {
  test('1. create an address group and a policy that names it', async () => {
    const groupRes = await postJson(`${collection}?addressGroupId=${groupId}`, {
      type: 'IPV4',
      capacity: 100,
      items: ['198.51.100.0/24', '203.0.113.10'],
      purpose: ['CLOUD_ARMOR'],
    });

    expect(groupRes.status).toBe(200);

    const groupOp = (await groupRes.json()) as { done: boolean };

    expect(groupOp.done).toBe(true);

    const policyRes = await postJson(`${policyBase}/securityPolicies`, {
      name: policyName,
      rules: [
        {
          priority: 500,
          action: 'deny(403)',
          match: {
            expr: {
              expression: `evaluateAddressGroup('${groupId}', origin.ip, ['198.51.100.20'])`,
            },
          },
        },
        {
          priority: 1000,
          action: 'deny(403)',
          match: {
            expr: { expression: `evaluateAddressGroup('${groupId}', origin.ip)` },
          },
        },
      ],
    });

    expect(policyRes.status).toBe(200);

    const policyOp = (await policyRes.json()) as { status: string };

    expect(policyOp.status).toBe('DONE');
  });

  test('2. a group hit that is not excluded is denied at priority 500', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: { 'X-Kinglet-Origin-IP': '198.51.100.21' },
    });

    expect(res.status).toBe(403);
    expect(res.headers.get('x-kinglet-enforced-action')).toBe('deny(403)');
    expect(res.headers.get('x-kinglet-enforced-priority')).toBe('500');
  });

  test('3. a group hit that is also excluded falls through to the next rule', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: { 'X-Kinglet-Origin-IP': '198.51.100.20' },
    });

    expect(res.status).toBe(403);
    expect(res.headers.get('x-kinglet-enforced-priority')).toBe('1000');
  });

  test('4. an IP outside the group uses the default allow', async () => {
    const res = await fetch(listenerUrl('/public'), {
      headers: { 'X-Kinglet-Origin-IP': '192.0.2.8' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-kinglet-enforced-action')).toBe('allow');
    expect(res.headers.get('x-kinglet-enforced-priority')).toBe('2147483647');
  });
});
