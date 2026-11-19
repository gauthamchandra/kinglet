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
import { crc32cString } from '@/shared/utils/crc32c.ts';
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

  grpcServer.registerService(service.getGrpcService());

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

    const [version] = await client.addSecretVersion({
      parent: created.name,
      payload: { data: Buffer.from('s3cret') },
    });

    expect(version.name).toBe('projects/grpc-project/secrets/db-password/versions/1');
    expect(version.state).toBe('ENABLED');

    const [accessed] = await client.accessSecretVersion({
      name: `${created.name}/versions/latest`,
    });

    expect(Buffer.from(accessed.payload?.data ?? new Uint8Array()).toString()).toBe('s3cret');
    expect(accessed.payload?.dataCrc32c).toBeDefined();
    expect(version.clientSpecifiedPayloadChecksum).toBe(false);
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

  test('a matching checksum is recorded and a mismatch is INVALID_ARGUMENT', async () => {
    const [secret] = await client.createSecret({
      parent: 'projects/grpc-project',
      secretId: 'checksum',
      secret: { replication: { automatic: {} } },
    });
    const data = Buffer.from('s3cret');
    const checksum = crc32cString(new Uint8Array(data));

    const [version] = await client.addSecretVersion({
      parent: secret.name,
      payload: { data, dataCrc32c: checksum },
    });

    expect(version.clientSpecifiedPayloadChecksum).toBe(true);
    expect(version.name).toBe('projects/grpc-project/secrets/checksum/versions/1');

    const mismatch = client.addSecretVersion({
      parent: secret.name,
      payload: { data, dataCrc32c: '1' },
    });

    await expect(mismatch).rejects.toHaveProperty('code', grpc.status.INVALID_ARGUMENT);
  });
});
