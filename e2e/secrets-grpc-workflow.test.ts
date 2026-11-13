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

  test.each([
    ['projects/grpc-project'],
    ['projects/grpc-project/locations/us-central1'],
  ])('updates labels and an alias under %s, then gets and accesses by alias', async parent => {
    const [created] = await client.createSecret({
      parent,
      secretId: 'aliased',
      secret: parent.includes('/locations/') ? {} : { replication: { automatic: {} } },
    });

    await client.addSecretVersion({ parent: created.name, payload: { data: Buffer.from('one') } });
    await client.addSecretVersion({ parent: created.name, payload: { data: Buffer.from('two') } });

    const before = client.accessSecretVersion({ name: `${created.name}/versions/current` });

    await expect(before).rejects.toHaveProperty('code', grpc.status.NOT_FOUND);

    const [updated] = await client.updateSecret({
      secret: {
        name: created.name,
        etag: created.etag,
        labels: { env: 'prod' },
        versionAliases: { current: 1 },
      },
      updateMask: { paths: ['labels', 'version_aliases'] },
    });

    expect(updated.etag).toBe('2');
    expect(updated.labels).toEqual({ env: 'prod' });
    expect(updated.versionAliases).toEqual({ current: '1' });

    const [version] = await client.getSecretVersion({ name: `${created.name}/versions/current` });

    expect(version.name).toBe(`${created.name}/versions/1`);

    const [accessed] = await client.accessSecretVersion({
      name: `${created.name}/versions/current`,
    });

    expect(accessed.name).toBe(`${created.name}/versions/1`);
    expect(Buffer.from(accessed.payload?.data ?? new Uint8Array()).toString()).toBe('one');
  });

  test('update rejects bad masks and stale etags, and ttl becomes expireTime', async () => {
    const [secret] = await client.createSecret({
      parent: 'projects/grpc-project',
      secretId: 'update-rules',
      secret: { replication: { automatic: {} }, labels: { team: 'core' } },
    });

    for (const paths of [[], ['*'], ['labels.team'], ['replication'], ['secret_type'], ['bogus']]) {
      const rejected = client.updateSecret({
        secret: { name: secret.name, labels: {} },
        updateMask: { paths },
      });

      await expect(rejected).rejects.toHaveProperty('code', grpc.status.INVALID_ARGUMENT);
    }

    const stale = client.updateSecret({
      secret: { name: secret.name, etag: '5', labels: {} },
      updateMask: { paths: ['labels'] },
    });

    await expect(stale).rejects.toHaveProperty('code', grpc.status.ABORTED);

    const [noop] = await client.updateSecret({
      secret: { name: secret.name, labels: { team: 'core' } },
      updateMask: { paths: ['labels'] },
    });

    expect(noop.etag).toBe('1');

    const [expiring] = await client.updateSecret({
      secret: { name: secret.name, ttl: { seconds: 3600 } },
      updateMask: { paths: ['ttl'] },
    });

    expect(expiring.etag).toBe('2');
    expect(expiring.ttl).toBeUndefined();
    expect(Number(expiring.expireTime?.seconds) * 1000 - Date.now()).toBeGreaterThan(3500 * 1000);
    expect(expiring.labels).toEqual({ team: 'core' });

    const [got] = await client.getSecret({ name: secret.name });

    expect(got.expireTime?.seconds).toBe(expiring.expireTime?.seconds);
    expect(got.ttl).toBeUndefined();

    const [pinned] = await client.updateSecret({
      secret: {
        name: secret.name,
        expireTime: { seconds: 1893456000 },
        ttl: { seconds: 60 },
      },
      updateMask: { paths: ['expire_time'] },
    });

    expect(Number(pinned.expireTime?.seconds)).toBe(1893456000);

    const [cleared] = await client.updateSecret({
      secret: { name: secret.name, expireTime: pinned.expireTime },
      updateMask: { paths: ['ttl'] },
    });

    expect(cleared.expireTime).toBeUndefined();
  });
});
