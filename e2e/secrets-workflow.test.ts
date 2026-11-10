/**
 * Secret Manager REST: raw fetch and the official client over HTTP.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import type { Server } from 'bun';
import { createLocationRoutes } from '@/core/gateway/location-routes.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { SecretsService } from '@/services/secrets/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { buildProductionRouter, createFakeAuth } from './e2e-helpers.ts';

let emulatorServer: Server;
let emulatorPort: number;
let service: SecretsService;

function url(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

beforeAll(async () => {
  emulatorPort = await getAvailablePort();

  const storage = new StorageManager();

  await storage.initialize({ type: 'memory' });

  const logger = new Logger('e2e-secrets', 'error');

  service = new SecretsService(storage, logger);
  await service.initialize();
  service.start();

  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: buildProductionRouter([...service.getRoutes(), ...createLocationRoutes(logger)]),
  });
});

afterAll(async () => {
  emulatorServer.stop();
  await service.stop();
});

describe('Secret Manager E2E: REST fetch', () => {
  test('creates and gets a global secret and a regional secret', async () => {
    const created = await fetch(`${url('/v1/projects/demo/secrets')}?secretId=db-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replication: { automatic: {} }, labels: { team: 'core' } }),
    });

    expect(created.status).toBe(200);

    const secret = (await created.json()) as {
      name: string;
      etag: string;
      replication: { automatic: object };
    };

    expect(secret.name).toBe('projects/demo/secrets/db-password');
    expect(secret.etag).toBe('1');
    expect(secret.replication.automatic).toEqual({});

    const got = await fetch(url('/v1/projects/demo/secrets/db-password'));

    expect(got.status).toBe(200);
    expect(((await got.json()) as { labels: { team: string } }).labels.team).toBe('core');

    const regional = await fetch(
      `${url('/v1/projects/demo/locations/us-central1/secrets')}?secretId=db-password`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }
    );

    expect(regional.status).toBe(200);
    expect(((await regional.json()) as { name: string }).name).toBe(
      'projects/demo/locations/us-central1/secrets/db-password'
    );
  });

  test('rejects a duplicate, a missing secret, a missing id, and a global secret without replication', async () => {
    const duplicate = await fetch(`${url('/v1/projects/demo/secrets')}?secretId=db-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replication: { automatic: {} } }),
    });
    const duplicateBody = (await duplicate.json()) as { error: { status: string } };

    expect(duplicate.status).toBe(409);
    expect(duplicateBody.error.status).toBe('ALREADY_EXISTS');

    const missing = await fetch(url('/v1/projects/demo/secrets/missing'));
    const missingBody = (await missing.json()) as { error: { status: string } };

    expect(missing.status).toBe(404);
    expect(missingBody.error.status).toBe('NOT_FOUND');

    const noId = await fetch(url('/v1/projects/demo/secrets'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replication: { automatic: {} } }),
    });

    expect(noId.status).toBe(400);

    const noReplication = await fetch(`${url('/v1/projects/other/secrets')}?secretId=plain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ labels: { team: 'core' } }),
    });
    const noReplicationBody = (await noReplication.json()) as { error: { status: string } };

    expect(noReplication.status).toBe(400);
    expect(noReplicationBody.error.status).toBe('INVALID_ARGUMENT');
  });

  test('GET IAM is not served as GetSecret', async () => {
    const response = await fetch(url('/v1/projects/demo/secrets/db-password:getIamPolicy'));
    const body = (await response.json()) as { error: { status: string } };

    expect(response.status).toBe(501);
    expect(body.error.status).toBe('UNIMPLEMENTED');
  });

  test('a secret id that contains a colon is invalid', async () => {
    const response = await fetch(`${url('/v1/projects/demo/secrets')}?secretId=a:b`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replication: { automatic: {} } }),
    });
    const body = (await response.json()) as { error: { status: string } };

    expect(response.status).toBe(400);
    expect(body.error.status).toBe('INVALID_ARGUMENT');
  });
});

describe('Secret Manager E2E: official client over REST', () => {
  test('creates and gets a secret, including an enum field', async () => {
    const client = new SecretManagerServiceClient({
      fallback: 'rest',
      apiEndpoint: 'localhost',
      port: emulatorPort,
      protocol: 'http',
      auth: createFakeAuth('client-project') as never,
    });

    const [created] = await client.createSecret({
      parent: 'projects/client-project',
      secretId: 'from-client',
      secret: { replication: { automatic: {} }, secretType: 'ACCESS_KEY' },
    });

    expect(created.name).toBe('projects/client-project/secrets/from-client');

    const [got] = await client.getSecret({ name: created.name });

    expect(got.etag).toBe('1');
    expect(got.replication?.automatic).toEqual({ customerManagedEncryption: null });
    expect(got.secretType).toBe('ACCESS_KEY');

    const iam = client.getIamPolicy({ resource: created.name });

    await expect(iam).rejects.toHaveProperty('code', 12);

    client.close();
  });
});
