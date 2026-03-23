/**
 * Tests for SecretsHandlers - HTTP route handlers
 *
 * Uses mocked SecretService to test request-to-service mapping and response formatting.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RouteContext, RouteRequest } from '@/core/gateway/request-router.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { SecretsHandlers } from './handlers.ts';
import type { SecretService } from './service.ts';
import { SecretsError } from './service.ts';

function makeRouteRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/v1/projects/p/secrets',
    query: {},
    headers: {},
    params: {},
    body: undefined,
    originalRequest: new Request('http://localhost'),
    ...overrides,
  };
}

function makeRouteContext(): RouteContext {
  return {
    routeId: 'test',
    startTime: Date.now(),
    metadata: {},
    logger: new Logger('test', 'error'),
  };
}

const mockSecretResponse = {
  name: 'projects/p/secrets/s',
  replication: { automatic: {} },
  createTime: '2024-01-01T00:00:00Z',
  etag: 'etag123',
};

const mockVersionResponse = {
  name: 'projects/p/secrets/s/versions/1',
  createTime: '2024-01-01T00:00:00Z',
  state: 'ENABLED',
  etag: 'vetag123',
};

describe('SecretsHandlers', () => {
  let mockService: SecretService;
  let handlers: SecretsHandlers;
  const ctx = makeRouteContext();

  beforeEach(() => {
    mockService = {
      createSecret: mock(() => Promise.resolve(mockSecretResponse)),
      getSecret: mock(() => Promise.resolve(mockSecretResponse)),
      listSecrets: mock(() =>
        Promise.resolve({ secrets: [], nextPageToken: undefined, totalSize: 0 })
      ),
      patchSecret: mock(() => Promise.resolve(mockSecretResponse)),
      deleteSecret: mock(() => Promise.resolve()),
      addVersion: mock(() => Promise.resolve(mockVersionResponse)),
      getVersion: mock(() => Promise.resolve(mockVersionResponse)),
      accessVersion: mock(() =>
        Promise.resolve({
          name: 'projects/p/secrets/s/versions/1',
          payload: { data: btoa('secret') },
        })
      ),
      listVersions: mock(() =>
        Promise.resolve({ versions: [], nextPageToken: undefined, totalSize: 0 })
      ),
      disableVersion: mock(() => Promise.resolve({ ...mockVersionResponse, state: 'DISABLED' })),
      enableVersion: mock(() => Promise.resolve(mockVersionResponse)),
      destroyVersion: mock(() =>
        Promise.resolve({
          ...mockVersionResponse,
          state: 'DESTROYED',
          destroyTime: '2024-06-01T00:00:00Z',
        })
      ),
    } as unknown as SecretService;

    handlers = new SecretsHandlers(mockService, new Logger('test', 'error'));
  });

  describe('getRoutes', () => {
    test('should return 26 route definitions', () => {
      const routes = handlers.getRoutes();

      expect(routes.length).toBe(26);
    });

    test('should include global secret routes', () => {
      const routes = handlers.getRoutes();
      const routeSpecs = routes.map(r => `${r.method} ${r.path}`);

      expect(routeSpecs).toContain('POST /v1/projects/:project/secrets');
      expect(routeSpecs).toContain('GET /v1/projects/:project/secrets/:secretId');
      expect(routeSpecs).toContain('GET /v1/projects/:project/secrets');
      expect(routeSpecs).toContain('DELETE /v1/projects/:project/secrets/:secretId');
      expect(routeSpecs).toContain('PATCH /v1/projects/:project/secrets/:secretId');
      expect(routeSpecs).toContain('POST /v1/projects/:project/secrets/:secretId:addVersion');
    });

    test('should include global version routes', () => {
      const routes = handlers.getRoutes();
      const routeSpecs = routes.map(r => `${r.method} ${r.path}`);

      expect(routeSpecs).toContain(
        'GET /v1/projects/:project/secrets/:secretId/versions/:versionId'
      );
      expect(routeSpecs).toContain('GET /v1/projects/:project/secrets/:secretId/versions');
      expect(routeSpecs).toContain(
        'GET /v1/projects/:project/secrets/:secretId/versions/:versionId:access'
      );
      expect(routeSpecs).toContain(
        'POST /v1/projects/:project/secrets/:secretId/versions/:versionId:destroy'
      );
      expect(routeSpecs).toContain(
        'POST /v1/projects/:project/secrets/:secretId/versions/:versionId:disable'
      );
      expect(routeSpecs).toContain(
        'POST /v1/projects/:project/secrets/:secretId/versions/:versionId:enable'
      );
    });

    test('should include regional routes', () => {
      const routes = handlers.getRoutes();
      const routeSpecs = routes.map(r => `${r.method} ${r.path}`);

      expect(routeSpecs).toContain('POST /v1/projects/:project/locations/:location/secrets');
      expect(routeSpecs).toContain(
        'GET /v1/projects/:project/locations/:location/secrets/:secretId/versions/:versionId:access'
      );
    });

    test('should include location routes', () => {
      const routes = handlers.getRoutes();
      const routeSpecs = routes.map(r => `${r.method} ${r.path}`);

      expect(routeSpecs).toContain('GET /v1/projects/:project/locations');
      expect(routeSpecs).toContain('GET /v1/projects/:project/locations/:location');
    });
  });

  describe('createSecret handler', () => {
    test('should extract secretId from query param', async () => {
      const route = handlers.getRoutes().find(r => r.id === 'secrets.secrets.create');
      const request = makeRouteRequest({
        method: 'POST',
        params: { project: 'my-proj' },
        query: { secretId: 'my-secret' },
        body: { replication: { automatic: {} } },
      });

      const response = await route?.handler(request, ctx);

      expect(response?.status).toBe(200);
      expect(mockService.createSecret).toHaveBeenCalled();
    });
  });

  describe('deleteSecret handler', () => {
    test('should return empty body on success', async () => {
      const route = handlers.getRoutes().find(r => r.id === 'secrets.secrets.delete');
      const request = makeRouteRequest({
        method: 'DELETE',
        params: { project: 'p', secretId: 's' },
      });

      const response = await route?.handler(request, ctx);

      expect(response?.status).toBe(200);
      expect(response?.body).toEqual({});
    });
  });

  describe('addVersion handler', () => {
    test('should use :addVersion action suffix route', async () => {
      const route = handlers.getRoutes().find(r => r.id === 'secrets.secrets.addVersion');

      expect(route?.path).toBe('/v1/projects/:project/secrets/:secretId:addVersion');

      const request = makeRouteRequest({
        method: 'POST',
        params: { project: 'p', secretId: 's' },
        body: { payload: { data: btoa('data') } },
      });

      const response = await route?.handler(request, ctx);

      expect(response?.status).toBe(200);
      expect(mockService.addVersion).toHaveBeenCalled();
    });
  });

  describe('version handlers extract :versionId', () => {
    test('getVersion extracts versionId', async () => {
      const route = handlers.getRoutes().find(r => r.id === 'secrets.versions.get');
      const request = makeRouteRequest({
        params: { project: 'p', secretId: 's', versionId: '1' },
      });

      await route?.handler(request, ctx);

      expect(mockService.getVersion).toHaveBeenCalledWith('projects/p/secrets/s/versions/1');
    });
  });

  describe('error handling', () => {
    test('should return 404 for NOT_FOUND errors', async () => {
      (mockService.getSecret as ReturnType<typeof mock>).mockRejectedValue(
        new SecretsError('NOT_FOUND', 'Secret not found')
      );

      const route = handlers.getRoutes().find(r => r.id === 'secrets.secrets.get');
      const request = makeRouteRequest({
        params: { project: 'p', secretId: 's' },
      });

      const response = await route?.handler(request, ctx);

      expect(response?.status).toBe(404);
    });

    test('should return 409 for ALREADY_EXISTS errors', async () => {
      (mockService.createSecret as ReturnType<typeof mock>).mockRejectedValue(
        new SecretsError('ALREADY_EXISTS', 'Secret already exists')
      );

      const route = handlers.getRoutes().find(r => r.id === 'secrets.secrets.create');
      const request = makeRouteRequest({
        method: 'POST',
        params: { project: 'p' },
        query: { secretId: 's' },
        body: { replication: { automatic: {} } },
      });

      const response = await route?.handler(request, ctx);

      expect(response?.status).toBe(409);
    });

    test('should return 400 for INVALID_ARGUMENT errors', async () => {
      (mockService.createSecret as ReturnType<typeof mock>).mockRejectedValue(
        new SecretsError('INVALID_ARGUMENT', 'Invalid argument')
      );

      const route = handlers.getRoutes().find(r => r.id === 'secrets.secrets.create');
      const request = makeRouteRequest({
        method: 'POST',
        params: { project: 'p' },
        query: { secretId: 's' },
        body: {},
      });

      const response = await route?.handler(request, ctx);

      expect(response?.status).toBe(400);
    });

    test('should return 400 for FAILED_PRECONDITION errors', async () => {
      (mockService.destroyVersion as ReturnType<typeof mock>).mockRejectedValue(
        new SecretsError('FAILED_PRECONDITION', 'Already destroyed')
      );

      const route = handlers.getRoutes().find(r => r.id === 'secrets.versions.destroy');

      const request = makeRouteRequest({
        method: 'POST',
        params: { project: 'p', secretId: 's', versionId: '1' },
      });

      const response = await route?.handler(request, ctx);

      expect(response?.status).toBe(400);
    });
  });
});
