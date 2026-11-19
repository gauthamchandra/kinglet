import { describe, expect, test } from 'bun:test';
import { getProtoPath } from 'google-proto-files';
import { pathsMatch } from './path-matching.ts';
import { parseServiceRpcs, protoHttpPathToRoutePath } from './proto-rpc.ts';

describe('parseServiceRpcs', () => {
  test('reads http verbs, additional bindings, and rpcs with no REST binding', () => {
    const source = `
      service Example {
        rpc ListThings(ListThingsRequest) returns (ListThingsResponse) {
          option (google.api.http) = {
            get: "/v1/{parent=projects/*}/things"
            additional_bindings {
              get: "/v1/{parent=projects/*/locations/*}/things"
            }
          };
        }
        rpc WatchThings(stream WatchRequest) returns (stream WatchResponse) {}
      }
    `;

    expect(parseServiceRpcs(source, 'Example')).toEqual([
      {
        name: 'ListThings',
        bindings: [
          { method: 'get', path: '/v1/{parent=projects/*}/things' },
          { method: 'get', path: '/v1/{parent=projects/*/locations/*}/things' },
        ],
      },
      { name: 'WatchThings', bindings: [] },
    ]);
  });

  test('the registered protos leave only Subscriber.StreamingPull without a REST binding', async () => {
    const services = [
      ['CloudTasks', getProtoPath('cloud/tasks/v2/cloudtasks.proto')],
      ['Publisher', getProtoPath('pubsub/v1/pubsub.proto')],
      ['Subscriber', getProtoPath('pubsub/v1/pubsub.proto')],
      ['SchemaService', getProtoPath('pubsub/v1/schema.proto')],
      ['SecretManagerService', getProtoPath('cloud/secretmanager/v1/service.proto')],
    ] as const;
    const unbound: string[] = [];

    for (const [serviceName, protoPath] of services) {
      const source = await Bun.file(protoPath).text();

      for (const rpc of parseServiceRpcs(source, serviceName)) {
        if (rpc.bindings.length === 0) {
          unbound.push(`${serviceName}.${rpc.name}`);
        }
      }
    }

    expect(unbound).toEqual(['Subscriber.StreamingPull']);
  });
});

describe('protoHttpPathToRoutePath', () => {
  test('matches a discovery list path', () => {
    const routePath = protoHttpPathToRoutePath('/v2/{parent=projects/*/locations/*}/queues');

    expect(routePath).toBe('/v2/projects/*/locations/*/queues');
    expect(
      pathsMatch(
        'v2/{+parent}/queues',
        { parent: { pattern: '^projects/[^/]+/locations/[^/]+$' } },
        routePath
      )
    ).toBe(true);
  });
});
