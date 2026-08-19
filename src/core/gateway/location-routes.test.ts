import { describe, expect, test } from 'bun:test';
import { Logger } from '@/shared/utils/logger.ts';
import { createLocationRoutes, GCP_LOCATIONS } from './location-routes.ts';
import type { RouteContext, RouteRequest, RouteResponse } from './request-router.ts';

const PROJECT = 'my-project';

const routes = createLocationRoutes(new Logger('test', 'error'));

async function call(id: string, params: Record<string, string>): Promise<RouteResponse> {
  const route = routes.find(r => r.id === id);

  if (!route) {
    throw new Error(`No route with id ${id}`);
  }

  const req = {
    method: route.method,
    path: '',
    query: {},
    headers: {},
    params,
    originalRequest: new Request('http://localhost'),
  } as unknown as RouteRequest;

  const ctx = {
    routeId: route.id,
    startTime: 0,
    metadata: {},
    logger: new Logger('test', 'error'),
  } as unknown as RouteContext;

  return route.handler(req, ctx);
}

describe('route registration', () => {
  test('owns the v1 locations list and get paths', () => {
    expect(routes.map(r => [r.method, r.path])).toEqual([
      ['GET', '/v1/projects/:project/locations'],
      ['GET', '/v1/projects/:project/locations/:location'],
    ]);
  });

  test('registers under service-neutral ids so no service claims the path', () => {
    expect(routes.map(r => r.id)).toEqual(['locations.list', 'locations.get']);
  });
});

describe('list locations', () => {
  test('returns every supported location with a project-scoped resource name', async () => {
    const res = await call('locations.list', { project: PROJECT });

    expect(res.status).toBe(200);

    const { locations } = res.body as { locations: Array<Record<string, unknown>> };

    expect(locations).toHaveLength(GCP_LOCATIONS.length);
    expect(locations[0]?.name).toBe(`projects/${PROJECT}/locations/${locations[0]?.locationId}`);
    expect(locations[0]?.metadata).toEqual({
      '@type': 'type.googleapis.com/google.cloud.location.Location',
    });
  });

  test('includes global, the location Cloud KMS key rings are created in', async () => {
    const res = await call('locations.list', { project: PROJECT });

    const { locations } = res.body as { locations: Array<{ locationId: string }> };

    expect(locations.map(l => l.locationId)).toContain('global');
  });

  test('includes us-central1, the location Workflows are created in', async () => {
    const res = await call('locations.list', { project: PROJECT });

    const { locations } = res.body as { locations: Array<{ locationId: string }> };

    expect(locations.map(l => l.locationId)).toContain('us-central1');
  });
});

describe('get location', () => {
  test('returns the requested location', async () => {
    const res = await call('locations.get', { project: PROJECT, location: 'us-central1' });

    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;

    expect(body.name).toBe(`projects/${PROJECT}/locations/us-central1`);
    expect(body.locationId).toBe('us-central1');
    expect(body.displayName).toBe('Council Bluffs, Iowa, USA');
  });

  test('returns 404 for a location the emulator does not support', async () => {
    const res = await call('locations.get', { project: PROJECT, location: 'antarctica-south1' });

    expect(res.status).toBe(404);
  });
});
