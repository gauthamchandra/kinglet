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
      'projects.locations.list',
      'projects.locations.jobs.run',
    ]);
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
