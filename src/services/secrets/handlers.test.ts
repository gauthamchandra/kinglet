import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import { getProtoPath } from 'google-proto-files';
import { RequestRouter } from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import {
  buildGrpcImplementation,
  buildRestRoutes,
  protoRpcNames,
  SECRET_MANAGER_RPCS,
} from './handlers.ts';
import { SecretsService } from './index.ts';
import { SecretRepository } from './repository.ts';
import { SecretManager } from './service.ts';

describe('secret manager RPC table', () => {
  test('names every rpc in service.proto', () => {
    const source = readFileSync(getProtoPath('cloud/secretmanager/v1/service.proto'), 'utf8');

    expect(protoRpcNames(source)).toEqual([...SECRET_MANAGER_RPCS]);
  });

  test('derives two routes per bound rpc and nothing else', async () => {
    const { routes } = await harness();
    const ids = routes.map(route => route.id).sort();

    expect(ids).toEqual([
      'projects.locations.secrets.addVersion',
      'projects.locations.secrets.create',
      'projects.locations.secrets.get',
      'projects.locations.secrets.patch',
      'projects.locations.secrets.versions.access',
      'projects.locations.secrets.versions.get',
      'projects.secrets.addVersion',
      'projects.secrets.create',
      'projects.secrets.get',
      'projects.secrets.patch',
      'projects.secrets.versions.access',
      'projects.secrets.versions.get',
    ]);
    expect(routes).toHaveLength(12);
  });

  test('PATCH applies a snake_case mask from the query and ignores the body name', async () => {
    const { routes } = await harness();
    const router = new RequestRouter(new Logger('test', 'error'));

    for (const route of routes) {
      router.addRoute(route);
    }

    const created = await router.route(
      new Request('http://localhost/v1/projects/p/locations/us-east1/secrets?secretId=a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ labels: { team: 'core' } }),
      })
    );

    expect(created.status).toBe(200);

    const patched = await router.route(
      new Request(
        'http://localhost/v1/projects/p/locations/us-east1/secrets/a?updateMask=labels,version_aliases',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'projects/p/secrets/other',
            versionAliases: { current: '1' },
          }),
        }
      )
    );
    const body = (await patched.json()) as {
      name: string;
      etag: string;
      labels?: unknown;
      versionAliases: Record<string, string>;
    };

    expect(patched.status).toBe(200);
    expect(body.name).toBe('projects/p/locations/us-east1/secrets/a');
    expect(body.etag).toBe('2');
    expect(body.labels).toBeUndefined();
    expect(body.versionAliases).toEqual({ current: '1' });
  });

  test.each([
    ['malformed JSON (undefined body)', 'not-json', 'application/json'],
    ['array body', JSON.stringify([{ labels: { team: 'edge' } }]), 'application/json'],
    ['string body', JSON.stringify('labels'), 'application/json'],
  ])('PATCH with %s and a mask is INVALID_ARGUMENT and does not clear stored labels', async (_label, rawBody, contentType) => {
    const { routes } = await harness();
    const router = new RequestRouter(new Logger('test', 'error'));

    for (const route of routes) {
      router.addRoute(route);
    }

    const created = await router.route(
      new Request(
        'http://localhost/v1/projects/p/locations/us-east1/secrets?secretId=label-guard',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ labels: { team: 'original' } }),
        }
      )
    );

    expect(created.status).toBe(200);

    const patched = await router.route(
      new Request(
        'http://localhost/v1/projects/p/locations/us-east1/secrets/label-guard?updateMask=labels',
        {
          method: 'PATCH',
          headers: { 'content-type': contentType },
          body: rawBody,
        }
      )
    );
    const patchBody = (await patched.json()) as { error: { status: string } };

    expect(patched.status).toBe(400);
    expect(patchBody.error.status).toBe('INVALID_ARGUMENT');

    const got = await router.route(
      new Request('http://localhost/v1/projects/p/locations/us-east1/secrets/label-guard')
    );
    const gotBody = (await got.json()) as { labels: Record<string, string> };

    expect(got.status).toBe(200);
    expect(gotBody.labels).toEqual({ team: 'original' });
  });

  test('PATCH with an empty object body and a mask clears the masked field', async () => {
    const { routes } = await harness();
    const router = new RequestRouter(new Logger('test', 'error'));

    for (const route of routes) {
      router.addRoute(route);
    }

    const created = await router.route(
      new Request(
        'http://localhost/v1/projects/p/locations/us-east1/secrets?secretId=empty-body-clear',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ labels: { team: 'core' } }),
        }
      )
    );

    expect(created.status).toBe(200);

    const patched = await router.route(
      new Request(
        'http://localhost/v1/projects/p/locations/us-east1/secrets/empty-body-clear?updateMask=labels',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      )
    );
    const patchBody = (await patched.json()) as { labels?: Record<string, string> };

    expect(patched.status).toBe(200);
    expect(patchBody.labels).toBeUndefined();
  });

  test('gRPC UpdateSecret without a mask is INVALID_ARGUMENT', async () => {
    const { implementation } = await harness();

    const error = await call(implementation, 'UpdateSecret', {
      secret: { name: 'projects/p/secrets/a' },
      updateMask: null,
    });

    expect(error.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(error.message).toBe('update_mask is required');
  });

  test('deferred RPCs return gRPC UNIMPLEMENTED', async () => {
    const { implementation } = await harness();

    const error = await call(implementation, 'ListSecrets');

    expect(error.code).toBe(grpc.status.UNIMPLEMENTED);
    expect(error.message).toContain('ListSecrets');
  });

  test('GET with a custom verb does not read the secret', async () => {
    const { routes } = await harness();
    const router = new RequestRouter(new Logger('test', 'error'));

    for (const route of routes) {
      router.addRoute(route);
    }

    const response = await router.route(
      new Request('http://localhost/v1/projects/demo/secrets/db-password:getIamPolicy')
    );
    const body = (await response.json()) as { error: { status: string } };

    expect(response.status).toBe(501);
    expect(body.error.status).toBe('UNIMPLEMENTED');
  });

  test('an oversized ttl is INVALID_ARGUMENT rather than a server error', async () => {
    const { routes } = await harness();
    const router = new RequestRouter(new Logger('test', 'error'));

    for (const route of routes) {
      router.addRoute(route);
    }

    const response = await router.route(
      new Request('http://localhost/v1/projects/demo/secrets?secretId=huge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          replication: { automatic: {} },
          ttl: '100000000000000000000s',
        }),
      })
    );
    const body = (await response.json()) as { error: { status: string } };

    expect(response.status).toBe(400);
    expect(body.error.status).toBe('INVALID_ARGUMENT');
  });

  test('addVersion uses the secret in the URL when the body names another parent', async () => {
    const { routes } = await harness();
    const router = new RequestRouter(new Logger('test', 'error'));

    for (const route of routes) {
      router.addRoute(route);
    }

    const created = await router.route(
      new Request('http://localhost/v1/projects/p/secrets?secretId=a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ replication: { automatic: {} } }),
      })
    );

    expect(created.status).toBe(200);

    const added = await router.route(
      new Request('http://localhost/v1/projects/p/secrets/a:addVersion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          parent: 'projects/p/secrets/b',
          payload: { data: Buffer.from('s3cret').toString('base64') },
        }),
      })
    );
    const version = (await added.json()) as { name: string };

    expect(added.status).toBe(200);
    expect(version.name).toBe('projects/p/secrets/a/versions/1');
  });

  test('a missing version is reported as SecretVersion', async () => {
    const { routes } = await harness();
    const router = new RequestRouter(new Logger('test', 'error'));

    for (const route of routes) {
      router.addRoute(route);
    }

    const created = await router.route(
      new Request('http://localhost/v1/projects/p/secrets?secretId=missing-version', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ replication: { automatic: {} } }),
      })
    );

    expect(created.status).toBe(200);

    const response = await router.route(
      new Request('http://localhost/v1/projects/p/secrets/missing-version/versions/9')
    );
    const body = (await response.json()) as {
      error: { message: string; details: Array<{ resourceType: string }> };
    };

    expect(response.status).toBe(404);
    expect(body.error.message).toBe(
      'SecretVersion projects/p/secrets/missing-version/versions/9 not found'
    );
    expect(body.error.details[0]?.resourceType).toBe('SecretVersion');
  });
});

describe('SecretsService lifecycle', () => {
  test('getRoutes throws before initialize and start creates no work', async () => {
    const storage = new StorageManager();

    await storage.initialize({ type: 'memory' });

    const service = new SecretsService(storage, new Logger('secrets', 'error'));

    expect(() => service.getRoutes()).toThrow('initialize');

    await service.initialize();
    service.start();
    await service.stop();

    expect(service.getRoutes().length).toBeGreaterThan(0);
  });
});

async function harness(): Promise<{
  routes: ReturnType<typeof buildRestRoutes>;
  implementation: grpc.UntypedServiceImplementation;
}> {
  const storage = new StorageManager();

  await storage.initialize({ type: 'memory' });

  const repository = new SecretRepository(storage);

  await repository.initialize();

  const manager = new SecretManager(repository);
  const logger = new Logger('secrets', 'error');
  const formatter = new StandardResponseFormatter(logger);

  return {
    routes: buildRestRoutes(manager, new ResponseUtils(formatter), formatter),
    implementation: buildGrpcImplementation(manager),
  };
}

function call(
  implementation: grpc.UntypedServiceImplementation,
  method: string,
  request: unknown = {}
): Promise<{ code: number; message: string }> {
  const handler = implementation[method] as
    | ((
        call: { request: unknown },
        callback: (err: { code?: number; message: string } | null) => void
      ) => void)
    | undefined;

  if (handler == null) {
    throw new Error(`missing ${method}`);
  }

  return new Promise((resolve, reject) => {
    handler({ request }, err => {
      if (err == null || err.code == null) {
        reject(new Error('expected an error'));

        return;
      }

      resolve({ code: err.code, message: err.message });
    });
  });
}
