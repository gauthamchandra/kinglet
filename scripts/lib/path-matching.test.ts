import { describe, expect, test } from 'bun:test';
import { discoveryPathToSegments, kingletPathToSegments, pathsMatch } from './path-matching.ts';

describe('path matching', () => {
  test('matches scheduler job list paths', () => {
    const discoverySegments = discoveryPathToSegments(
      'v1/projects/{projectId}/locations/{locationId}/jobs'
    );
    const kingletSegments = kingletPathToSegments('/v1/projects/:project/locations/:location/jobs');

    expect(discoverySegments).toEqual(kingletSegments);
    expect(
      pathsMatch(
        'v1/projects/{projectId}/locations/{locationId}/jobs',
        {},
        '/v1/projects/:project/locations/:location/jobs'
      )
    ).toBe(true);
  });

  test('expands discovery name patterns', () => {
    expect(
      pathsMatch(
        'v2/{name=projects/*/locations/*/queues/*}',
        {},
        '/v2/projects/:project/locations/:location/queues/:queueId'
      )
    ).toBe(true);
  });

  test('matches cloud storage paths without the storage/v1 prefix', () => {
    expect(pathsMatch('b/{bucket}/o', {}, '/storage/v1/b/:bucket/o')).toBe(true);
  });

  test('expands discovery path parameters with regex patterns', () => {
    expect(
      pathsMatch(
        'v1/{+name}',
        {
          name: {
            pattern: '^projects/[^/]+/locations/[^/]+$',
          },
        },
        '/v1/projects/:project/locations/:location'
      )
    ).toBe(true);
  });
});
