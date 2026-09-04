/**
 * ComputeService initialization and wiring tests (TDD slice 4).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
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
});
