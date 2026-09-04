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
    await service.stop();
    await service.stop();
  });
});
