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

  for (const parent of ['projects/grpc-project', 'projects/grpc-project/locations/us-east1']) {
    test(`lists and changes version state under ${parent}`, async () => {
      const [secret] = await client.createSecret({
        parent,
        secretId: 'stateful',
        secret: parent.includes('/locations/') ? {} : { replication: { automatic: {} } },
      });

      for (const value of ['one', 'two', 'three']) {
        await client.addSecretVersion({
          parent: secret.name,
          payload: { data: Buffer.from(value) },
        });
      }

      const [page, nextRequest, raw] = await client.listSecretVersions(
        { parent: secret.name, pageSize: 2 },
        { autoPaginate: false }
      );

      expect(page.map(version => version.name)).toEqual([
        `${secret.name}/versions/3`,
        `${secret.name}/versions/2`,
      ]);
      expect(raw?.totalSize).toBe(3);
      expect(nextRequest?.pageToken).toBeTypeOf('string');

      const [rest, lastRequest, lastRaw] = await client.listSecretVersions(
        { parent: secret.name, pageSize: 2, pageToken: nextRequest?.pageToken ?? '' },
        { autoPaginate: false }
      );

      expect(rest.map(version => version.name)).toEqual([`${secret.name}/versions/1`]);
      expect(lastRequest).toBeNull();
      expect(lastRaw?.nextPageToken).toBe('');

      const [disabled] = await client.disableSecretVersion({
        name: `${secret.name}/versions/2`,
        etag: '1',
      });

      expect(disabled.state).toBe('DISABLED');
      expect(disabled.etag).toBe('2');

      const blocked = client.accessSecretVersion({ name: `${secret.name}/versions/2` });

      await expect(blocked).rejects.toHaveProperty('code', grpc.status.FAILED_PRECONDITION);

      const [meta] = await client.getSecretVersion({ name: `${secret.name}/versions/2` });

      expect(meta.state).toBe('DISABLED');

      const stale = client.enableSecretVersion({
        name: `${secret.name}/versions/2`,
        etag: '1',
      });

      await expect(stale).rejects.toHaveProperty('code', grpc.status.ABORTED);

      const [noop] = await client.disableSecretVersion({ name: `${secret.name}/versions/2` });

      expect(noop.etag).toBe('2');

      const [destroyed] = await client.destroySecretVersion({
        name: `${secret.name}/versions/3`,
      });

      expect(destroyed.state).toBe('DESTROYED');
      expect(Number(destroyed.destroyTime?.seconds ?? 0)).toBeGreaterThan(0);

      const [latest] = await client.getSecretVersion({ name: `${secret.name}/versions/latest` });

      expect(latest.name).toBe(`${secret.name}/versions/3`);
      expect(latest.state).toBe('DESTROYED');

      for (const method of ['enableSecretVersion', 'disableSecretVersion'] as const) {
        const refused = client[method]({ name: `${secret.name}/versions/3` });

        await expect(refused).rejects.toHaveProperty('code', grpc.status.FAILED_PRECONDITION);
      }

      const again = client.destroySecretVersion({ name: `${secret.name}/versions/3` });

      await expect(again).rejects.toHaveProperty('code', grpc.status.FAILED_PRECONDITION);

      const missing = client.destroySecretVersion({ name: `${secret.name}/versions/42` });

      await expect(missing).rejects.toHaveProperty('code', grpc.status.NOT_FOUND);
    });
  }
});
