/**
 * Tests for CloudSqlService wiring
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { RouteContext, RouteRequest } from '@/core/gateway/request-router.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { CloudSqlService } from './index.ts';

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/v1/projects/p1/instances',
    query: {},
    headers: {},
    params: { project: 'p1' },
    body: undefined,
    originalRequest: new Request('http://localhost/'),
    ...overrides,
  };
}

function makeContext(): RouteContext {
  return {
    routeId: 'test',
    startTime: Date.now(),
    metadata: {},
    logger: new Logger('CloudSqlTest', 'error'),
  };
}

describe('CloudSqlService', () => {
  let storage: StorageManager;
  let service: CloudSqlService;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    // Control-plane wiring only: booting a PGlite per instance would make
    // these tests bind real ports and build wasm Postgres they never connect
    // to. The data plane has its own tests below and in e2e/.
    service = new CloudSqlService(storage, new Logger('CloudSqlTest', 'error'), {
      enabled: false,
    });
  });

  test('getRoutes throws before initialize', () => {
    expect(() => service.getRoutes()).toThrow('not initialized');
  });

  test('initialize wires the 20 GCP routes', async () => {
    await service.initialize();

    expect(service.getRoutes()).toHaveLength(20);
  });

  test('a created instance is retrievable through the routes', async () => {
    await service.initialize();

    const routes = service.getRoutes();
    const insertRoute = routes.find(route => route.id === 'cloudsql.instances.insert');
    const getRoute = routes.find(route => route.id === 'cloudsql.instances.get');

    expect(insertRoute).toBeDefined();
    expect(getRoute).toBeDefined();

    const insertResponse = await insertRoute?.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p1' },
        body: { name: 'db-a', databaseVersion: 'POSTGRES_16' },
      }),
      makeContext()
    );

    expect(insertResponse?.status).toBe(200);

    const getResponse = await getRoute?.handler(
      makeRequest({ params: { project: 'p1', instance: 'db-a' } }),
      makeContext()
    );

    expect(getResponse?.status).toBe(200);

    const instance = getResponse?.body as { kind: string; state: string };

    expect(instance.kind).toBe('sql#instance');
    expect(instance.state).toBe('RUNNABLE');
  });

  test('control-plane records persist across service instances over the same storage', async () => {
    await service.initialize();

    const insertRoute = service.getRoutes().find(route => route.id === 'cloudsql.instances.insert');

    await insertRoute?.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p1' },
        body: { name: 'db-a', databaseVersion: 'POSTGRES_16' },
      }),
      makeContext()
    );

    await service.stop();

    const revived = new CloudSqlService(storage, new Logger('CloudSqlTest', 'error'), {
      enabled: false,
    });

    await revived.initialize();

    const getRoute = revived.getRoutes().find(route => route.id === 'cloudsql.instances.get');

    const response = await getRoute?.handler(
      makeRequest({ params: { project: 'p1', instance: 'db-a' } }),
      makeContext()
    );

    expect(response?.status).toBe(200);

    await revived.stop();
  });

  describe('data plane', () => {
    const PORT_RANGE_START = 46700;

    async function startService(): Promise<CloudSqlService> {
      const dataPlaneService = new CloudSqlService(storage, new Logger('CloudSqlTest', 'error'), {
        enabled: true,
        portRangeStart: PORT_RANGE_START,
        portRangeEnd: PORT_RANGE_START + 4,
        storageType: 'memory',
        sqlitePath: './data/emulator.db',
      });

      await dataPlaneService.initialize();

      return dataPlaneService;
    }

    async function createInstance(target: CloudSqlService, name: string): Promise<void> {
      const insertRoute = target
        .getRoutes()
        .find(route => route.id === 'cloudsql.instances.insert');

      const response = await insertRoute?.handler(
        makeRequest({
          method: 'POST',
          params: { project: 'p1' },
          body: { name, databaseVersion: 'POSTGRES_16', rootPassword: 's3cret' },
        }),
        makeContext()
      );

      expect(response?.status).toBe(200);
    }

    test('a created instance is reachable with the root password', async () => {
      const dataPlaneService = await startService();

      await createInstance(dataPlaneService, 'db-a');

      const client = new Bun.SQL({
        url: `postgres://postgres:s3cret@127.0.0.1:${PORT_RANGE_START}/postgres`,
        tls: false,
        max: 1,
      });

      const rows: Record<string, unknown>[] = await client.unsafe('SELECT 1 AS one');

      expect(rows.map(row => ({ ...row }))).toEqual([{ one: 1 }]);

      await client.end();
      await dataPlaneService.stop();
    });

    test('stop closes the endpoint so its port can be bound again', async () => {
      const dataPlaneService = await startService();

      await createInstance(dataPlaneService, 'db-a');
      await dataPlaneService.stop();

      const rebound = Bun.listen({
        hostname: '127.0.0.1',
        port: PORT_RANGE_START,
        socket: { data() {}, open() {}, close() {}, error() {} },
      });

      expect(rebound.port).toBe(PORT_RANGE_START);

      rebound.stop(true);
    });

    test('brings persisted instances back up on a fresh service over the same storage', async () => {
      const first = await startService();

      await createInstance(first, 'db-a');
      await first.stop();

      const revived = await startService();

      const client = new Bun.SQL({
        url: `postgres://postgres:s3cret@127.0.0.1:${PORT_RANGE_START}/postgres`,
        tls: false,
        max: 1,
      });

      const rows: Record<string, unknown>[] = await client.unsafe('SELECT 1 AS one');

      expect(rows.map(row => ({ ...row }))).toEqual([{ one: 1 }]);

      await client.end();
      await revived.stop();
    });
  });
});
