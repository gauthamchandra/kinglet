/**
 * Secret Manager gRPC through the official client, with no REST fallback.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import * as grpc from '@grpc/grpc-js';
import type { Server } from 'bun';
import { GrpcServer } from '@/core/gateway/grpc-server.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { SecretsService } from '@/services/secrets/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { createFakeAuth } from './e2e-helpers.ts';

let emulatorServer: Server;
let grpcServer: GrpcServer;
let service: SecretsService;
let client: InstanceType<typeof SecretManagerServiceClient>;

beforeAll(async () => {
  const httpPort = await getAvailablePort();
  const grpcPort = await getAvailablePort();
  const storage = new StorageManager();

  await storage.initialize({ type: 'memory' });

  const logger = new Logger('e2e-secrets-grpc', 'error');

  service = new SecretsService(storage, logger);
  await service.initialize();
  service.start();

  emulatorServer = Bun.serve({
    port: httpPort,
    fetch: () => new Response('not used', { status: 404 }),
  });

  grpcServer = new GrpcServer({ httpPort, grpcPort, maxConnections: 100 }, logger);

  for (const definition of service.getGrpcServices()) {
    grpcServer.registerService(definition);
  }

  await grpcServer.start();

  client = new SecretManagerServiceClient({
    apiEndpoint: 'localhost',
    port: grpcPort,
    sslCreds: grpc.credentials.createInsecure(),
    auth: createFakeAuth('grpc-project') as never,
  });
});

afterAll(async () => {
  client.close();
  await grpcServer.stop();
  await service.stop();
  emulatorServer.stop();
});

describe('Secret Manager E2E: gRPC', () => {
  test('creates and gets a global secret and a regional secret', async () => {
    const [created] = await client.createSecret({
      parent: 'projects/grpc-project',
      secretId: 'db-password',
      secret: { replication: { automatic: {} }, labels: { team: 'core' } },
    });

    expect(created.name).toBe('projects/grpc-project/secrets/db-password');
    expect(created.etag).toBe('1');

    const [got] = await client.getSecret({ name: created.name });

    expect(got.labels).toEqual({ team: 'core' });

    const [regional] = await client.createSecret({
      parent: 'projects/grpc-project/locations/us-central1',
      secretId: 'db-password',
      secret: {},
    });

    expect(regional.name).toBe('projects/grpc-project/locations/us-central1/secrets/db-password');
  });

  test('duplicate create is ALREADY_EXISTS and list is UNIMPLEMENTED', async () => {
    const duplicate = client.createSecret({
      parent: 'projects/grpc-project',
      secretId: 'db-password',
      secret: { replication: { automatic: {} } },
    });

    await expect(duplicate).rejects.toHaveProperty('code', grpc.status.ALREADY_EXISTS);

    const listed = client.listSecrets({ parent: 'projects/grpc-project' });

    await expect(listed).rejects.toHaveProperty('code', grpc.status.UNIMPLEMENTED);
  });
});
