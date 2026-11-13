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
      'projects.locations.secrets.versions.access',
      'projects.locations.secrets.versions.destroy',
      'projects.locations.secrets.versions.disable',
      'projects.locations.secrets.versions.enable',
      'projects.locations.secrets.versions.get',
      'projects.locations.secrets.versions.list',
      'projects.secrets.addVersion',
      'projects.secrets.create',
      'projects.secrets.get',
      'projects.secrets.versions.access',
      'projects.secrets.versions.destroy',
      'projects.secrets.versions.disable',
      'projects.secrets.versions.enable',
      'projects.secrets.versions.get',
      'projects.secrets.versions.list',
    ]);
    expect(routes).toHaveLength(18);
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

  test('state changes on a missing version are reported as SecretVersion', async () => {
    const router = await routerWithSecret('projects/p/locations/us-east1', 'state');

    for (const verb of ['enable', 'disable', 'destroy']) {
      const response = await router.route(
        new Request(
          `http://localhost/v1/projects/p/locations/us-east1/secrets/state/versions/4:${verb}`,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
        )
      );
      const body = (await response.json()) as {
        error: { status: string; details: Array<{ resourceType: string }> };
      };

      expect(response.status).toBe(404);
      expect(body.error.status).toBe('NOT_FOUND');
      expect(body.error.details[0]?.resourceType).toBe('SecretVersion');
    }
  });

  test('a wrong etag is 409 ABORTED and a destroyed version is 400 FAILED_PRECONDITION', async () => {
    const router = await routerWithSecret('projects/p', 'etag');
    const base = 'http://localhost/v1/projects/p/secrets/etag';

    await post(router, `${base}:addVersion`, {
      payload: { data: Buffer.from('x').toString('base64') },
    });

    const aborted = await post(router, `${base}/versions/1:disable`, { etag: 'stale' });
    const abortedBody = (await aborted.json()) as { error: { status: string } };

    expect(aborted.status).toBe(409);
    expect(abortedBody.error.status).toBe('ABORTED');

    const destroyed = await post(router, `${base}/versions/1:destroy`, { etag: '1' });
    const destroyedBody = (await destroyed.json()) as { state: string; destroyTime: string };

    expect(destroyed.status).toBe(200);
    expect(destroyedBody.state).toBe('DESTROYED');
    expect(destroyedBody.destroyTime).toBeTypeOf('string');

    const again = await post(router, `${base}/versions/1:destroy`, {});
    const againBody = (await again.json()) as { error: { status: string } };

    expect(again.status).toBe(400);
    expect(againBody.error.status).toBe('FAILED_PRECONDITION');
  });

  test('lists versions with versions, totalSize, and no token on the last page', async () => {
    const router = await routerWithSecret('projects/p', 'listed');
    const base = 'http://localhost/v1/projects/p/secrets/listed';

    await post(router, `${base}:addVersion`, {
      payload: { data: Buffer.from('x').toString('base64') },
    });

    const response = await router.route(new Request(`${base}/versions?pageSize=5`));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.totalSize).toBe(1);
    expect(body.versions).toHaveLength(1);
    expect(body).not.toHaveProperty('nextPageToken');

    const negative = await router.route(new Request(`${base}/versions?pageSize=-1`));

    expect(negative.status).toBe(400);
  });
});

async function routerWithSecret(parent: string, secretId: string): Promise<RequestRouter> {
  const { routes } = await harness();
  const router = new RequestRouter(new Logger('test', 'error'));

  for (const route of routes) {
    router.addRoute(route);
  }

  const created = await post(
    router,
    `http://localhost/v1/${parent}/secrets?secretId=${secretId}`,
    parent.includes('/locations/') ? {} : { replication: { automatic: {} } }
  );

  if (created.status !== 200) {
    throw new Error(`setup failed: ${created.status}`);
  }

  return router;
}

function post(router: RequestRouter, url: string, body: unknown): Promise<Response> {
  return router.route(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

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
  method: string
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
    handler({ request: {} }, err => {
      if (err == null || err.code == null) {
        reject(new Error('expected an error'));

        return;
      }

      resolve({ code: err.code, message: err.message });
    });
  });
}
