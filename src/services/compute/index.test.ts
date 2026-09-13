/**
 * ComputeService initialization and wiring tests (TDD slice 4).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { AddressGroupRepository } from '@/services/networksecurity/repository.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { ComputeService } from './index.ts';

const logger = new Logger('test-compute-index', 'error');

let storage: StorageManager;
let service: ComputeService;

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });
  service = new ComputeService(storage, logger);
  await service.initialize();
});

afterEach(async () => {
  await service.stop();
  await storage.close();
});

describe('ComputeService', () => {
  test('initialize and getRoutes returns routes', () => {
    const routes = service.getRoutes();

    expect(routes.length).toBeGreaterThan(0);

    const ids = routes.map(r => r.id);

    expect(ids).toContain('compute.securityPolicies.insert');
    expect(ids).toContain('compute.securityPolicies.get');
    expect(ids).toContain('compute.securityPolicies.list');
    expect(ids).toContain('compute.securityPolicies.patch');
    expect(ids).toContain('compute.securityPolicies.delete');
    expect(ids).toContain('compute.securityPolicies.addRule');
    expect(ids).toContain('compute.securityPolicies.removeRule');
    expect(ids).toContain('compute.securityPolicies.getRule');
    expect(ids).toContain('compute.securityPolicies.patchRule');
    expect(ids).toContain('compute.globalOperations.get');
    expect(ids).toContain('compute.globalOperations.wait');
  });

  test('stop is idempotent', async () => {
    await expect(service.stop()).resolves.toBeUndefined();
    await expect(service.stop()).resolves.toBeUndefined();
    expect(service.getRoutes().length).toBeGreaterThan(0);
  });

  test('start leaves the control plane up when the listener port matches HTTP', async () => {
    const occupied = new ComputeService(storage, logger, { listenerPort: 8765 });

    await occupied.initialize();

    const started = occupied.start(8765);

    expect(started.listenerStarted).toBe(false);
    expect(started.listenerBind).toBe('127.0.0.1');
    expect(occupied.getRoutes().length).toBeGreaterThan(0);

    await occupied.stop();
  });

  test('start leaves the control plane up when the listener port is taken', async () => {
    const blocker = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(''),
    });

    const occupied = new ComputeService(storage, logger, { listenerPort: blocker.port });

    await occupied.initialize();

    const started = occupied.start();

    expect(started.listenerStarted).toBe(false);
    expect(occupied.getRoutes().length).toBeGreaterThan(0);

    await occupied.stop();
    blocker.stop();
  });

  test('listener evaluates a policy created under any project', async () => {
    const listening = new ComputeService(storage, logger, { listenerPort: 0 });

    await listening.initialize();

    const started = listening.start();

    expect(started.listenerStarted).toBe(true);
    expect(started.listenerPort).toBeTypeOf('number');

    await listening.getSecurityPolicyService().insert('other-project', 'only-policy', {});

    const res = await fetch(`http://127.0.0.1:${started.listenerPort}/public`);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-kinglet-enforced-action')).toBe('allow');
    expect(res.headers.get('x-kinglet-enforced-priority')).toBe('2147483647');

    await listening.stop();
  });

  test('listener returns 503 when defaultPolicy name is used in more than one project', async () => {
    const listening = new ComputeService(storage, logger, {
      listenerPort: 0,
      defaultPolicyName: 'shared',
    });

    await listening.initialize();

    const policies = listening.getSecurityPolicyService();

    await policies.insert('proj-a', 'shared', {});
    await policies.insert('proj-b', 'shared', {});

    const started = listening.start();

    expect(started.listenerStarted).toBe(true);
    expect(started.listenerPort).toBeTypeOf('number');

    const warn = spyOn(logger, 'warn');
    const res = await fetch(`http://127.0.0.1:${started.listenerPort}/public`);

    expect(res.status).toBe(503);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('matches more than one policy');

    warn.mockRestore();
    await listening.stop();
  });

  test('listener logs and returns 400 for an invalid origin IP', async () => {
    const listening = new ComputeService(storage, logger, { listenerPort: 0 });

    await listening.initialize();
    await listening.getSecurityPolicyService().insert('proj', 'only-policy', {});

    const started = listening.start();

    expect(started.listenerStarted).toBe(true);
    expect(started.listenerPort).toBeTypeOf('number');

    const warn = spyOn(logger, 'warn');
    const res = await fetch(`http://127.0.0.1:${started.listenerPort}/public`, {
      headers: { 'X-Kinglet-Origin-IP': 'not-an-ip' },
    });

    expect(res.status).toBe(400);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('Invalid X-Kinglet-Origin-IP');

    warn.mockRestore();
    await listening.stop();
  });

  test('listener uses a project-qualified defaultPolicy when names collide', async () => {
    const listening = new ComputeService(storage, logger, {
      listenerPort: 0,
      defaultPolicyName: 'projects/proj-b/global/securityPolicies/shared',
    });

    await listening.initialize();

    const policies = listening.getSecurityPolicyService();

    await policies.insert('proj-a', 'shared', {
      rules: [
        {
          priority: 1000,
          action: 'deny(403)',
          match: { expr: { expression: "request.path.startsWith('/public')" } },
        },
      ],
    });
    await policies.insert('proj-b', 'shared', {});

    const started = listening.start();

    expect(started.listenerStarted).toBe(true);
    expect(started.listenerPort).toBeTypeOf('number');

    const res = await fetch(`http://127.0.0.1:${started.listenerPort}/public`);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-kinglet-enforced-action')).toBe('allow');
    expect(res.headers.get('x-kinglet-security-policy')).toBe('shared');

    await listening.stop();
  });

  test('evaluation server binds 0.0.0.0 when listenerBind is set', async () => {
    const listening = new ComputeService(storage, logger, {
      listenerPort: 0,
      listenerBind: '0.0.0.0',
    });

    await listening.initialize();

    const started = listening.start();

    expect(started.listenerStarted).toBe(true);
    expect(started.listenerBind).toBe('0.0.0.0');
    expect(started.listenerPort).toBeTypeOf('number');

    await listening.getSecurityPolicyService().insert('proj', 'only-policy', {});

    const res = await fetch(`http://127.0.0.1:${started.listenerPort}/public`);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-kinglet-enforced-action')).toBe('allow');

    await listening.stop();
  });

  test('listener matches evaluateAddressGroup against stored address groups', async () => {
    const listening = new ComputeService(storage, logger, { listenerPort: 0 });

    await listening.initialize();

    const groups = new AddressGroupRepository(storage);

    await groups.create({
      name: 'projects/proj/locations/global/addressGroups/malicious-ips',
      type: 'IPV4',
      capacity: 10,
      items: JSON.stringify(['198.51.100.0/24']),
      purpose: JSON.stringify(['CLOUD_ARMOR']),
      labels: '{}',
      description: '',
      createTime: '2026-01-01T00:00:00.000Z',
      updateTime: '2026-01-01T00:00:00.000Z',
    });

    await listening.getSecurityPolicyService().insert('proj', 'ag-policy', {
      rules: [
        {
          priority: 1000,
          action: 'deny(403)',
          match: { expr: { expression: "evaluateAddressGroup('malicious-ips', origin.ip)" } },
        },
      ],
    });

    const started = listening.start();

    expect(started.listenerStarted).toBe(true);
    expect(started.listenerPort).toBeTypeOf('number');

    const hit = await fetch(`http://127.0.0.1:${started.listenerPort}/public`, {
      headers: { 'X-Kinglet-Origin-IP': '198.51.100.20' },
    });
    const miss = await fetch(`http://127.0.0.1:${started.listenerPort}/public`, {
      headers: { 'X-Kinglet-Origin-IP': '192.0.2.8' },
    });

    expect(hit.status).toBe(403);
    expect(hit.headers.get('x-kinglet-enforced-priority')).toBe('1000');
    expect(miss.status).toBe(200);
    expect(miss.headers.get('x-kinglet-enforced-priority')).toBe('2147483647');

    await listening.stop();
  });
});
