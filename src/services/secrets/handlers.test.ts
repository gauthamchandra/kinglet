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
      'projects.locations.secrets.versions.get',
      'projects.secrets.addVersion',
      'projects.secrets.create',
      'projects.secrets.get',
      'projects.secrets.versions.access',
      'projects.secrets.versions.get',
    ]);
    expect(routes).toHaveLength(10);
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
