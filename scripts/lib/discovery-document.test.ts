import { describe, expect, test } from 'bun:test';
import { parseDiscoveryDocument, partitionDiscoveryMethods } from './discovery-document.ts';

describe('parseDiscoveryDocument', () => {
  test('walks nested resources and extracts methods', () => {
    const doc = parseDiscoveryDocument(
      JSON.stringify({
        title: 'Example API',
        version: 'v1',
        resources: {
          projects: {
            resources: {
              locations: {
                methods: {
                  list: {
                    httpMethod: 'GET',
                    path: 'v1/projects/{projectId}/locations',
                  },
                },
                resources: {
                  jobs: {
                    methods: {
                      run: {
                        httpMethod: 'POST',
                        path: 'v1/{+name}:run',
                        parameters: {
                          name: {
                            pattern: '^projects/[^/]+/locations/[^/]+/jobs/[^/]+$',
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      })
    );

    expect(doc.title).toBe('Example API');
    expect(doc.version).toBe('v1');
    expect(doc.methods).toHaveLength(2);
    expect(doc.methods.map(method => method.id)).toEqual([
      'projects.locations.jobs.run',
      'projects.locations.list',
    ]);
  });

  test('orders methods independently of discovery key order', () => {
    const build = (reversed: boolean) => {
      const jobs = {
        methods: {
          run: { httpMethod: 'POST', path: 'v1/{+name}:run' },
          create: { httpMethod: 'POST', path: 'v1/{+parent}/jobs' },
        },
      };
      const locations = {
        methods: { list: { httpMethod: 'GET', path: 'v1/{+parent}/locations' } },
        resources: { jobs },
      };
      const queues = {
        methods: { get: { httpMethod: 'GET', path: 'v1/{+name}' } },
      };

      return JSON.stringify({
        title: 'Example API',
        version: 'v1',
        resources: reversed
          ? { projects: { resources: { queues, locations } } }
          : { projects: { resources: { locations, queues } } },
      });
    };

    expect(parseDiscoveryDocument(build(false)).methods).toEqual(
      parseDiscoveryDocument(build(true)).methods
    );
  });
});

describe('partitionDiscoveryMethods', () => {
  test('separates IAM methods from comparable methods', () => {
    const { comparable, iamDeferred } = partitionDiscoveryMethods([
      {
        id: 'projects.locations.jobs.getIamPolicy',
        httpMethod: 'GET',
        path: 'v1/{+name}',
        parameters: {},
      },
      {
        id: 'projects.locations.jobs.get',
        httpMethod: 'GET',
        path: 'v1/{+name}',
        parameters: {},
      },
    ]);

    expect(comparable).toHaveLength(1);
    expect(iamDeferred).toHaveLength(1);
    expect(iamDeferred[0]?.id).toBe('projects.locations.jobs.getIamPolicy');
  });
});
