import { describe, expect, test } from 'bun:test';
import { extractRoutesForService } from './extract-service-routes.ts';

describe('extractRoutesForService', () => {
  test('extracts scheduler routes including shared v1 locations', async () => {
    const routes = await extractRoutesForService('cloud-scheduler');

    expect(routes.length).toBeGreaterThan(5);
    expect(routes.some(route => route.id === 'scheduler.jobs.create')).toBe(true);
    expect(routes.some(route => route.path === '/v1/projects/:project/locations')).toBe(true);
  });

  test('returns an empty route list for services without an implementation', async () => {
    const routes = await extractRoutesForService('secret-manager');

    expect(routes).toEqual([]);
  });
});
