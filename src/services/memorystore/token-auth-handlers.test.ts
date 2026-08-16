/**
 * Unit tests for TokenAuthHandlers
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RouteContext, RouteDefinition, RouteRequest } from '@/core/gateway/request-router.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { TokenAuthHandlers } from './token-auth-handlers.ts';
import type { TokenAuthService } from './token-auth-service.ts';
import { MemoryStoreError } from './types.ts';

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/v1/projects/p/locations/us-central1/instances/i/tokenAuthUsers',
    query: {},
    headers: {},
    params: {},
    body: undefined,
    originalRequest: new Request('http://localhost'),
    ...overrides,
  };
}

function makeContext(): RouteContext {
  return {
    routeId: 'test',
    startTime: Date.now(),
    metadata: {},
    logger: new Logger('test', 'error'),
  };
}

function findRoute(routes: RouteDefinition[], id: string) {
  const route = routes.find(r => r.id === id);

  if (!route) throw new Error(`Route ${id} not found`);

  return route;
}

function makeOperationResponse(verb: string) {
  return {
    name: 'projects/p/locations/us-central1/operations/op-1',
    metadata: {
      '@type': 'type.googleapis.com/google.cloud.memorystore.v1.OperationMetadata',
      createTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:00:00.000Z',
      target: 'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u',
      verb,
      apiVersion: 'v1',
    },
    done: true,
  };
}

describe('TokenAuthHandlers', () => {
  let mockService: TokenAuthService;
  let handlers: TokenAuthHandlers;

  beforeEach(() => {
    mockService = {
      listTokenAuthUsers: mock(() => Promise.resolve({ tokenAuthUsers: [] })),
      getTokenAuthUser: mock(() =>
        Promise.resolve({ name: 'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u' })
      ),
      deleteTokenAuthUser: mock(() => Promise.resolve(makeOperationResponse('delete'))),
      addAuthToken: mock(() => Promise.resolve(makeOperationResponse('addAuthToken'))),
      listAuthTokens: mock(() => Promise.resolve({ authTokens: [] })),
      getAuthToken: mock(() =>
        Promise.resolve({
          name: 'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/t',
        })
      ),
      deleteAuthToken: mock(() => Promise.resolve(makeOperationResponse('delete'))),
    } as unknown as TokenAuthService;

    handlers = new TokenAuthHandlers(mockService, new Logger('test', 'error'));
  });

  test('getRoutes_returnsAllSevenTokenAuthUserAndAuthTokenRouteIds', () => {
    const ids = handlers.getRoutes().map(r => r.id);

    expect(ids).toContain('memorystore.tokenAuthUsers.list');
    expect(ids).toContain('memorystore.tokenAuthUsers.get');
    expect(ids).toContain('memorystore.tokenAuthUsers.delete');
    expect(ids).toContain('memorystore.tokenAuthUsers.addAuthToken');
    expect(ids).toContain('memorystore.tokenAuthUsers.authTokens.list');
    expect(ids).toContain('memorystore.tokenAuthUsers.authTokens.get');
    expect(ids).toContain('memorystore.tokenAuthUsers.authTokens.delete');
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('handleListTokenAuthUsers_usesTheTokenAuthUsersEnvelopeKey', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.tokenAuthUsers.list');

    const response = await route.handler(
      makeRequest({ params: { project: 'p', location: 'us-central1', instance: 'i' } }),
      makeContext()
    );

    const body = response.body as Record<string, unknown>;

    expect('tokenAuthUsers' in body).toBe(true);
  });

  test('handleGetTokenAuthUser_givenNotFoundError_mapsTo404', async () => {
    (mockService.getTokenAuthUser as ReturnType<typeof mock>).mockImplementation(() => {
      throw new MemoryStoreError('NOT_FOUND', 'Token auth user not found');
    });

    const route = findRoute(handlers.getRoutes(), 'memorystore.tokenAuthUsers.get');

    const response = await route.handler(
      makeRequest({
        params: { project: 'p', location: 'us-central1', instance: 'i', tokenAuthUser: 'missing' },
      }),
      makeContext()
    );

    expect(response.status).toBe(404);
  });

  test('handleDeleteTokenAuthUser_passesForceAndRequestIdQueryParamsThroughToTheService', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.tokenAuthUsers.delete');

    await route.handler(
      makeRequest({
        method: 'DELETE',
        params: { project: 'p', location: 'us-central1', instance: 'i', tokenAuthUser: 'u' },
        query: { force: 'true', requestId: 'req-1' },
      }),
      makeContext()
    );

    const call = (mockService.deleteTokenAuthUser as ReturnType<typeof mock>).mock
      .calls[0] as unknown[];

    expect(call).toEqual([
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u',
      true,
      'req-1',
    ]);
  });

  test('handleAddAuthToken_returnsADoneOperationWithAddAuthTokenVerb', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.tokenAuthUsers.addAuthToken');

    const response = await route.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', location: 'us-central1', instance: 'i', tokenAuthUser: 'u' },
        body: { authToken: { name: 't' } },
      }),
      makeContext()
    );

    const body = response.body as { metadata: { verb: string } };

    expect(body.metadata.verb).toBe('addAuthToken');
  });

  test('handleListAuthTokens_usesTheAuthTokensEnvelopeKey', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.tokenAuthUsers.authTokens.list');

    const response = await route.handler(
      makeRequest({
        params: { project: 'p', location: 'us-central1', instance: 'i', tokenAuthUser: 'u' },
      }),
      makeContext()
    );

    const body = response.body as Record<string, unknown>;

    expect('authTokens' in body).toBe(true);
  });

  test('handleListTokenAuthUsers_givenAnInvalidPageSize_passesUndefinedToTheService', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.tokenAuthUsers.list');

    await route.handler(
      makeRequest({
        params: { project: 'p', location: 'us-central1', instance: 'i' },
        query: { pageSize: 'abc' },
      }),
      makeContext()
    );

    const call = (mockService.listTokenAuthUsers as ReturnType<typeof mock>).mock
      .calls[0] as unknown[];

    expect(call[1]).toBeUndefined();
  });

  test('handleListAuthTokens_givenAnInvalidPageSize_passesUndefinedToTheService', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.tokenAuthUsers.authTokens.list');

    await route.handler(
      makeRequest({
        params: { project: 'p', location: 'us-central1', instance: 'i', tokenAuthUser: 'u' },
        query: { pageSize: '0' },
      }),
      makeContext()
    );

    const call = (mockService.listAuthTokens as ReturnType<typeof mock>).mock.calls[0] as unknown[];

    expect(call[1]).toBeUndefined();
  });

  test('handleDeleteAuthToken_returnsADoneOperation', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.tokenAuthUsers.authTokens.delete');

    const response = await route.handler(
      makeRequest({
        method: 'DELETE',
        params: {
          project: 'p',
          location: 'us-central1',
          instance: 'i',
          tokenAuthUser: 'u',
          authToken: 't',
        },
      }),
      makeContext()
    );

    const body = response.body as { done: boolean };

    expect(body.done).toBe(true);
    expect(mockService.deleteAuthToken).toHaveBeenCalledWith(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/t'
    );
  });
});
