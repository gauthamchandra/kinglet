import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  classifyDiscoveryMethods,
  parseDiscoveryDocument,
  partitionDiscoveryMethods,
  selectRegistryMethods,
} from './discovery-document.ts';

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

  test('groups a resource own methods before its child resources', () => {
    const doc = parseDiscoveryDocument(
      JSON.stringify({
        resources: {
          projects: {
            resources: {
              locations: {
                methods: {
                  updateCmekConfig: { httpMethod: 'PATCH', path: 'v2/{+name}' },
                  get: { httpMethod: 'GET', path: 'v2/{+name}' },
                },
                resources: {
                  queues: {
                    methods: { create: { httpMethod: 'POST', path: 'v2/{+parent}/queues' } },
                    resources: {
                      tasks: {
                        methods: { run: { httpMethod: 'POST', path: 'v2/{+name}:run' } },
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

    expect(doc.methods.map(method => method.id)).toEqual([
      'projects.locations.get',
      'projects.locations.updateCmekConfig',
      'projects.locations.queues.create',
      'projects.locations.queues.tasks.run',
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

describe('classifyDiscoveryMethods', () => {
  const routes = [
    { method: 'GET', path: '/storage/v1/b/:bucket/iam' },
    { method: 'POST', path: '/storage/v1/projects/:projectId/hmacKeys' },
  ];

  test('lists a matching IAM route separately from IAM methods that have no route', () => {
    const classified = classifyDiscoveryMethods(
      [
        {
          id: 'buckets.getIamPolicy',
          httpMethod: 'GET',
          path: 'b/{bucket}/iam',
          parameters: {},
        },
        {
          id: 'objects.getIamPolicy',
          httpMethod: 'GET',
          path: 'b/{bucket}/o/{object}/iam',
          parameters: {},
        },
        {
          id: 'projects.hmacKeys.create',
          httpMethod: 'POST',
          path: 'projects/{projectId}/hmacKeys',
          parameters: {},
        },
        {
          id: 'projects.hmacKeys.delete',
          httpMethod: 'DELETE',
          path: 'projects/{projectId}/hmacKeys/{accessId}',
          parameters: {},
        },
      ],
      routes
    );

    expect(classified.iamImplemented.map(method => method.id)).toEqual(['buckets.getIamPolicy']);
    expect(classified.iamDeferred.map(method => method.id)).toEqual(['objects.getIamPolicy']);
    expect(classified.implemented.map(method => method.id)).toEqual(['projects.hmacKeys.create']);
    expect(classified.missing.map(method => method.id)).toEqual(['projects.hmacKeys.delete']);
  });
});

describe('selectRegistryMethods', () => {
  test('networksecurity prefixes match project discovery ids and skip organization ids', async () => {
    const registry = JSON.parse(
      await Bun.file(join(import.meta.dir, '../../discovery-document-registry.json')).text()
    ) as {
      services: { name: string; resources?: string[] }[];
    };
    const resources = registry.services.find(
      service => service.name === 'networksecurity'
    )?.resources;

    expect(
      selectRegistryMethods(
        [
          { id: 'projects.locations.addressGroups.list' },
          { id: 'projects.locations.operations.get' },
          { id: 'organizations.locations.addressGroups.list' },
        ],
        resources
      ).map(method => method.id)
    ).toEqual(['projects.locations.addressGroups.list', 'projects.locations.operations.get']);
  });
});
