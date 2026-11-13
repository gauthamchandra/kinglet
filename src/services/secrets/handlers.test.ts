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
      'projects.locations.secrets.delete',
      'projects.locations.secrets.get',
      'projects.locations.secrets.list',
      'projects.locations.secrets.versions.access',
      'projects.locations.secrets.versions.get',
      'projects.secrets.addVersion',
      'projects.secrets.create',
      'projects.secrets.delete',
      'projects.secrets.get',
      'projects.secrets.list',
      'projects.secrets.versions.access',
      'projects.secrets.versions.get',
    ]);
    expect(routes).toHaveLength(14);
  });

  test('deferred RPCs return gRPC UNIMPLEMENTED', async () => {
    const { implementation } = await harness();

    const error = await call(implementation, 'SetIamPolicy');

    expect(error.code).toBe(grpc.status.UNIMPLEMENTED);
    expect(error.message).toContain('SetIamPolicy');
  });

  test('a list filter is UNIMPLEMENTED on REST and gRPC', async () => {
    const { routes, implementation } = await harness();
    const router = routerFor(routes);

    const response = await router.route(
      new Request('http://localhost/v1/projects/p/locations/l/secrets?filter=name:a')
    );
    const body = (await response.json()) as { error: { status: string } };
    const error = await call(implementation, 'ListSecrets', {
      parent: 'projects/p',
      pageSize: 0,
      pageToken: '',
      filter: 'name:a',
    });

    expect(response.status).toBe(501);
    expect(body.error.status).toBe('UNIMPLEMENTED');
    expect(error.code).toBe(grpc.status.UNIMPLEMENTED);
  });

  test('REST delete returns an empty body and maps etag and missing errors', async () => {
    const { routes } = await harness();
    const router = routerFor(routes);

    const created = await router.route(
      new Request('http://localhost/v1/projects/p/secrets?secretId=doomed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ replication: { automatic: {} } }),
      })
    );

    expect(created.status).toBe(200);

    const stale = await router.route(
      new Request('http://localhost/v1/projects/p/secrets/doomed?etag=9', { method: 'DELETE' })
    );
    const staleBody = (await stale.json()) as { error: { status: string } };

    expect(stale.status).toBe(409);
    expect(staleBody.error.status).toBe('ABORTED');

    const deleted = await router.route(
      new Request('http://localhost/v1/projects/p/secrets/doomed?etag=1', { method: 'DELETE' })
    );

    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({});

    const missing = await router.route(
      new Request('http://localhost/v1/projects/p/secrets/doomed', { method: 'DELETE' })
    );
    const missingBody = (await missing.json()) as {
      error: { status: string; details: Array<{ resourceType: string; resourceName: string }> };
    };

    expect(missing.status).toBe(404);
    expect(missingBody.error.status).toBe('NOT_FOUND');
    expect(missingBody.error.details[0]?.resourceType).toBe('Secret');
    expect(missingBody.error.details[0]?.resourceName).toBe('projects/p/secrets/doomed');
  });

  test('gRPC delete returns an empty message and a stale etag is ABORTED', async () => {
    const { implementation } = await harness();

    await respond(implementation, 'CreateSecret', {
      parent: 'projects/p',
      secretId: 'doomed',
      secret: { replication: { automatic: {} } },
    });

    const stale = await call(implementation, 'DeleteSecret', {
      name: 'projects/p/secrets/doomed',
      etag: '9',
    });
    const deleted = await respond(implementation, 'DeleteSecret', {
      name: 'projects/p/secrets/doomed',
      etag: '',
    });
    const missing = await call(implementation, 'DeleteSecret', {
      name: 'projects/p/secrets/doomed',
      etag: '',
    });

    expect(stale.code).toBe(grpc.status.ABORTED);
    expect(deleted).toEqual({});
    expect(missing.code).toBe(grpc.status.NOT_FOUND);
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

function routerFor(routes: ReturnType<typeof buildRestRoutes>): RequestRouter {
  const router = new RequestRouter(new Logger('test', 'error'));

  for (const route of routes) {
    router.addRoute(route);
  }

  return router;
}

type UnaryHandler = (
  call: { request: unknown },
  callback: (err: { code?: number; message: string } | null, value?: unknown) => void
) => void;

function handlerFor(implementation: grpc.UntypedServiceImplementation, method: string) {
  const handler = implementation[method] as UnaryHandler | undefined;

  if (handler == null) {
    throw new Error(`missing ${method}`);
  }

  return handler;
}

function call(
  implementation: grpc.UntypedServiceImplementation,
  method: string,
  request: unknown = {}
): Promise<{ code: number; message: string }> {
  const handler = handlerFor(implementation, method);

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

function respond(
  implementation: grpc.UntypedServiceImplementation,
  method: string,
  request: unknown
): Promise<unknown> {
  const handler = handlerFor(implementation, method);

  return new Promise((resolve, reject) => {
    handler({ request }, (err, value) => {
      if (err != null) {
        reject(new Error(err.message));

        return;
      }

      resolve(value);
    });
  });
}
