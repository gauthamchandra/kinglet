/**
 * Unit tests for LocationHandlers
 *
 * Pure handler with no service collaborator, so these tests exercise the real
 * class end to end without any mock() boundary. The generic locations.list/get
 * pair lives in src/core/gateway/location-routes.ts and is tested there.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { RouteContext, RouteDefinition, RouteRequest } from '@/core/gateway/request-router.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { LocationHandlers } from './location-handlers.ts';

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/v1/projects/p/locations',
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

describe('LocationHandlers', () => {
  let handlers: LocationHandlers;

  beforeEach(() => {
    handlers = new LocationHandlers(new Logger('test', 'error'));
  });

  test('getRoutes_ownsOnlyTheMemorystoreSpecificLocationRoute', () => {
    const routes = handlers.getRoutes();

    expect(routes.map(r => r.id)).toEqual([
      'memorystore.locations.getSharedRegionalCertificateAuthority',
    ]);
  });

  test('getRoutes_leavesTheSharedLocationPathsToTheServiceNeutralHandler', () => {
    const paths = handlers.getRoutes().map(r => r.path);

    expect(paths).not.toContain('/v1/projects/:project/locations');
    expect(paths).not.toContain('/v1/projects/:project/locations/:location');
  });

  test('handleGetSharedRegionalCertificateAuthority_returnsAResourceNamedAfterTheRequestedLocation', async () => {
    const route = findRoute(
      handlers.getRoutes(),
      'memorystore.locations.getSharedRegionalCertificateAuthority'
    );

    const response = await route.handler(
      makeRequest({ params: { project: 'p', location: 'us-central1' } }),
      makeContext()
    );

    expect(response.status).toBe(200);
    const body = response.body as { name: string };

    expect(body.name).toBe('projects/p/locations/us-central1/sharedRegionalCertificateAuthority');
  });
});
