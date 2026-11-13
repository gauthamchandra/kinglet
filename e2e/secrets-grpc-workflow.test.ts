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

  test('duplicate create is ALREADY_EXISTS and a list filter is UNIMPLEMENTED', async () => {
    const duplicate = client.createSecret({
      parent: 'projects/grpc-project',
      secretId: 'db-password',
      secret: { replication: { automatic: {} } },
    });

    await expect(duplicate).rejects.toHaveProperty('code', grpc.status.ALREADY_EXISTS);

    const listed = client.listSecrets({ parent: 'projects/grpc-project', filter: 'name:db' });

    await expect(listed).rejects.toHaveProperty('code', grpc.status.UNIMPLEMENTED);
  });

  test('lists global and regional parents separately, newest first, in pages', async () => {
    for (const parent of ['projects/grpc-list', 'projects/grpc-list/locations/eu']) {
      const secret = parent.includes('/locations/') ? {} : { replication: { automatic: {} } };

      for (const secretId of ['a', 'b', 'c']) {
        await client.createSecret({ parent, secretId, secret });
      }

      const [page, nextRequest, response] = await client.listSecrets(
        { parent, pageSize: 2 },
        { autoPaginate: false }
      );

      expect(page).toHaveLength(2);
      expect(response?.totalSize).toBe(3);
      expect(nextRequest?.pageToken).toBeTypeOf('string');

      const [rest, lastRequest, lastResponse] = await client.listSecrets(
        { parent, pageSize: 2, pageToken: nextRequest?.pageToken ?? '' },
        { autoPaginate: false }
      );
      const listed = [...page, ...rest];
      const times = listed.map(item => Number(item.createTime?.seconds ?? 0));

      expect(lastRequest).toBeNull();
      expect(lastResponse?.nextPageToken).toBe('');
      expect(listed.map(item => item.name).sort()).toEqual([
        `${parent}/secrets/a`,
        `${parent}/secrets/b`,
        `${parent}/secrets/c`,
      ]);
      expect(times.every((time, index) => index === 0 || time <= (times[index - 1] ?? time))).toBe(
        true
      );
    }
  });

  test('deletes global and regional secrets, honours etag, and recreates from version 1', async () => {
    for (const parent of ['projects/grpc-delete', 'projects/grpc-delete/locations/eu']) {
      const secret = parent.includes('/locations/') ? {} : { replication: { automatic: {} } };
      const name = `${parent}/secrets/doomed`;

      await client.createSecret({ parent, secretId: 'doomed', secret });
      await client.addSecretVersion({ parent: name, payload: { data: Buffer.from('old') } });

      const stale = client.deleteSecret({ name, etag: '99' });

      await expect(stale).rejects.toHaveProperty('code', grpc.status.ABORTED);

      const [deleted] = await client.deleteSecret({ name, etag: '1' });

      expect(deleted).toEqual({});

      const missing = client.deleteSecret({ name });

      await expect(missing).rejects.toHaveProperty('code', grpc.status.NOT_FOUND);

      const [listed] = await client.listSecrets({ parent });

      expect(listed).toEqual([]);

      await client.createSecret({ parent, secretId: 'doomed', secret });

      const oldPayload = client.accessSecretVersion({ name: `${name}/versions/latest` });

      await expect(oldPayload).rejects.toHaveProperty('code', grpc.status.NOT_FOUND);

      const [version] = await client.addSecretVersion({
        parent: name,
        payload: { data: Buffer.from('new') },
      });
      const [accessed] = await client.accessSecretVersion({ name: `${name}/versions/1` });

      expect(version.name).toBe(`${name}/versions/1`);
      expect(Buffer.from(accessed.payload?.data ?? new Uint8Array()).toString()).toBe('new');
    }
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
