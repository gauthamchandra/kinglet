/**
 * Unit tests for LocationHandlers
 *
 * Pure handler with no service collaborator (locations are a hardcoded GCP
 * list, see src/services/workflows/handlers.ts for the precedent), so these
 * tests exercise the real class end to end without any mock() boundary.
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

  test('getRoutes_returnsAllThreeLocationRouteIds', () => {
    const ids = handlers.getRoutes().map(r => r.id);

    expect(ids).toContain('memorystore.locations.list');
    expect(ids).toContain('memorystore.locations.get');
    expect(ids).toContain('memorystore.locations.getSharedRegionalCertificateAuthority');
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('handleListLocations_returnsMultipleRealGcpLocationsScopedToTheRequestedProject', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.locations.list');

    const response = await route.handler(makeRequest({ params: { project: 'p' } }), makeContext());

    expect(response.status).toBe(200);
    const body = response.body as { locations: Array<{ name: string; locationId: string }> };

    expect(body.locations.length).toBeGreaterThan(1);
    expect(body.locations.every(loc => loc.name.startsWith('projects/p/locations/'))).toBe(true);
    expect(body.locations.some(loc => loc.locationId === 'us-central1')).toBe(true);
  });

  test('handleGetLocation_givenKnownLocationId_returnsItsResourceName', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.locations.get');

    const response = await route.handler(
      makeRequest({ params: { project: 'p', location: 'us-central1' } }),
      makeContext()
    );

    expect(response.status).toBe(200);
    const body = response.body as { name: string; locationId: string };

    expect(body.name).toBe('projects/p/locations/us-central1');
    expect(body.locationId).toBe('us-central1');
  });

  test('handleGetLocation_givenUnknownLocationId_returns404', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.locations.get');

    const response = await route.handler(
      makeRequest({ params: { project: 'p', location: 'not-a-real-location' } }),
      makeContext()
    );

    expect(response.status).toBe(404);
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
