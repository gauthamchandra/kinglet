/**
 * Tests for CloudSqlHandlers
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RouteContext, RouteRequest } from '@/core/gateway/request-router.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { CloudSqlHandlers } from './handlers.ts';
import type { SqlAdminService } from './service.ts';
import { SqlAdminError } from './service.ts';

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
    logger: new Logger('CloudSqlHandlersTest', 'error'),
  };
}

const DONE_OP = { kind: 'sql#operation', name: 'op-1', status: 'DONE' };

describe('CloudSqlHandlers', () => {
  let serviceMock: {
    createInstance: ReturnType<typeof mock>;
    listInstances: ReturnType<typeof mock>;
    getInstance: ReturnType<typeof mock>;
    listDatabases: ReturnType<typeof mock>;
    listUsers: ReturnType<typeof mock>;
    updateUser: ReturnType<typeof mock>;
    deleteUser: ReturnType<typeof mock>;
    listOperations: ReturnType<typeof mock>;
    updateInstance: ReturnType<typeof mock>;
  };
  let handlers: CloudSqlHandlers;

  beforeEach(() => {
    serviceMock = {
      createInstance: mock(async () => DONE_OP),
      listInstances: mock(async () => ({ items: [], nextPageToken: undefined })),
      getInstance: mock(async () => ({ kind: 'sql#instance', name: 'db-a' })),
      listDatabases: mock(async () => ({ items: [] })),
      listUsers: mock(async () => ({ items: [] })),
      updateUser: mock(async () => DONE_OP),
      deleteUser: mock(async () => DONE_OP),
      listOperations: mock(async () => ({ items: [], nextPageToken: '2' })),
      updateInstance: mock(async () => DONE_OP),
    };

    handlers = new CloudSqlHandlers(
      serviceMock as unknown as SqlAdminService,
      new Logger('CloudSqlHandlersTest', 'error')
    );
  });

  test('exposes exactly the 20 GCP routes with cloudsql.* ids', () => {
    const routes = handlers.getRoutes();

    expect(routes).toHaveLength(20);
    expect(routes.every(route => route.id.startsWith('cloudsql.'))).toBe(true);
    expect(routes.some(route => route.path.startsWith('/kinglet'))).toBe(false);
  });

  test('instances.insert passes project and body to the service', async () => {
    const route = handlers.getRoutes().find(r => r.id === 'cloudsql.instances.insert');
    const body = { name: 'db-a', databaseVersion: 'POSTGRES_16' };

    expect(route).toBeDefined();

    const response = await route?.handler(
      makeRequest({ method: 'POST', body, params: { project: 'p1' } }),
      makeContext()
    );

    expect(response?.status).toBe(200);
    expect(serviceMock.createInstance).toHaveBeenCalledWith('p1', body);
  });

  test('instances.list forwards maxResults and pageToken and shapes the response', async () => {
    const route = handlers.getRoutes().find(r => r.id === 'cloudsql.instances.list');

    const response = await route?.handler(
      makeRequest({ query: { maxResults: '2', pageToken: '4' } }),
      makeContext()
    );

    expect(serviceMock.listInstances).toHaveBeenCalledWith('p1', 2, '4');

    const responseBody = response?.body as Record<string, unknown>;

    expect(responseBody.kind).toBe('sql#instancesList');
    expect(responseBody.items).toEqual([]);
    expect(Object.keys(responseBody)).not.toContain('nextPageToken');
  });

  test('databases.list response has kind sql#databasesList and never a nextPageToken', async () => {
    const route = handlers.getRoutes().find(r => r.id === 'cloudsql.databases.list');

    const response = await route?.handler(
      makeRequest({ params: { project: 'p1', instance: 'db-a' } }),
      makeContext()
    );

    const responseBody = response?.body as Record<string, unknown>;

    expect(responseBody.kind).toBe('sql#databasesList');
    expect(Object.keys(responseBody)).not.toContain('nextPageToken');
  });

  test('users.update reads name and host from query parameters', async () => {
    const route = handlers.getRoutes().find(r => r.id === 'cloudsql.users.update');

    await route?.handler(
      makeRequest({
        method: 'PUT',
        params: { project: 'p1', instance: 'db-a' },
        query: { name: 'app', host: '%' },
        body: { password: 'x' },
      }),
      makeContext()
    );

    expect(serviceMock.updateUser).toHaveBeenCalledWith('p1', 'db-a', 'app', '%', {
      password: 'x',
    });
  });

  test('users.delete without query name still calls the service with undefined', async () => {
    const route = handlers.getRoutes().find(r => r.id === 'cloudsql.users.delete');

    await route?.handler(
      makeRequest({ method: 'DELETE', params: { project: 'p1', instance: 'db-a' } }),
      makeContext()
    );

    expect(serviceMock.deleteUser).toHaveBeenCalledWith('p1', 'db-a', undefined, undefined);
  });

  test('operations.list forwards the instance filter and emits nextPageToken', async () => {
    const route = handlers.getRoutes().find(r => r.id === 'cloudsql.operations.list');

    const response = await route?.handler(
      makeRequest({ query: { instance: 'db-a' } }),
      makeContext()
    );

    expect(serviceMock.listOperations).toHaveBeenCalledWith('p1', 'db-a', undefined, undefined);

    const responseBody = response?.body as Record<string, unknown>;

    expect(responseBody.kind).toBe('sql#operationsList');
    expect(responseBody.nextPageToken).toBe('2');
  });

  describe('error mapping', () => {
    test('NOT_FOUND maps to HTTP 404', async () => {
      serviceMock.getInstance.mockImplementation(async () => {
        throw new SqlAdminError('NOT_FOUND', 'missing');
      });

      const route = handlers.getRoutes().find(r => r.id === 'cloudsql.instances.get');

      const response = await route?.handler(
        makeRequest({ params: { project: 'p1', instance: 'nope' } }),
        makeContext()
      );

      expect(response?.status).toBe(404);
    });

    test('FAILED_PRECONDITION maps to HTTP 409 with status FAILED_PRECONDITION', async () => {
      serviceMock.updateInstance.mockImplementation(async () => {
        throw new SqlAdminError('FAILED_PRECONDITION', 'settingsVersion mismatch');
      });

      const route = handlers.getRoutes().find(r => r.id === 'cloudsql.instances.update');

      const response = await route?.handler(
        makeRequest({ method: 'PUT', params: { project: 'p1', instance: 'db-a' }, body: {} }),
        makeContext()
      );

      expect(response?.status).toBe(409);

      const responseBody = response?.body as { error: { status: string } };

      expect(responseBody.error.status).toBe('FAILED_PRECONDITION');
    });

    test('INVALID_ARGUMENT maps to HTTP 400', async () => {
      serviceMock.createInstance.mockImplementation(async () => {
        throw new SqlAdminError('INVALID_ARGUMENT', 'bad');
      });

      const route = handlers.getRoutes().find(r => r.id === 'cloudsql.instances.insert');

      const response = await route?.handler(
        makeRequest({ method: 'POST', body: {}, params: { project: 'p1' } }),
        makeContext()
      );

      expect(response?.status).toBe(400);
    });

    test('ALREADY_EXISTS maps to HTTP 409', async () => {
      serviceMock.createInstance.mockImplementation(async () => {
        throw new SqlAdminError('ALREADY_EXISTS', 'dupe');
      });

      const route = handlers.getRoutes().find(r => r.id === 'cloudsql.instances.insert');

      const response = await route?.handler(
        makeRequest({ method: 'POST', body: {}, params: { project: 'p1' } }),
        makeContext()
      );

      expect(response?.status).toBe(409);
    });

    test('INTERNAL maps to HTTP 500', async () => {
      serviceMock.createInstance.mockImplementation(async () => {
        throw new SqlAdminError('INTERNAL', 'storage failure');
      });

      const route = handlers.getRoutes().find(r => r.id === 'cloudsql.instances.insert');

      const response = await route?.handler(
        makeRequest({ method: 'POST', body: {}, params: { project: 'p1' } }),
        makeContext()
      );

      expect(response?.status).toBe(500);
    });
  });
});
