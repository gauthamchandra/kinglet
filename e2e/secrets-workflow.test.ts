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

const replicated = { replication: { automatic: {} } };

interface ListBody {
  secrets: Array<{ name: string; createTime: string }>;
  nextPageToken?: string;
  totalSize?: number;
}

function url(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

async function addVersion(secretPath: string, data: string): Promise<{ name: string }> {
  const added = await fetch(url(`${secretPath}:addVersion`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload: { data: Buffer.from(data).toString('base64') } }),
  });

  expect(added.status).toBe(200);

  return (await added.json()) as { name: string };
}

function expectNewestFirst(secrets: ReadonlyArray<{ createTime: string }>): void {
  const times = secrets.map(secret => Date.parse(secret.createTime));

  expect(times.every((time, index) => index === 0 || time <= (times[index - 1] ?? time))).toBe(
    true
  );
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

  test('adds a version and accesses it by latest', async () => {
    const created = await fetch(`${url('/v1/projects/demo/secrets')}?secretId=token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replication: { automatic: {} } }),
    });

    expect(created.status).toBe(200);

    const added = await fetch(url('/v1/projects/demo/secrets/token:addVersion'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { data: Buffer.from('s3cret').toString('base64') } }),
    });
    const version = (await added.json()) as { name: string; payload?: unknown; state: string };

    expect(added.status).toBe(200);
    expect(version.name).toBe('projects/demo/secrets/token/versions/1');
    expect(version.payload).toBeUndefined();
    expect(version.state).toBe('ENABLED');

    const access = await fetch(url('/v1/projects/demo/secrets/token/versions/latest:access'));
    const accessed = (await access.json()) as {
      name: string;
      payload: { data: string; dataCrc32c: string };
    };

    expect(access.status).toBe(200);
    expect(accessed.name).toBe('projects/demo/secrets/token/versions/1');
    expect(Buffer.from(accessed.payload.data, 'base64').toString()).toBe('s3cret');
    expect(accessed.payload.dataCrc32c).toBeTypeOf('string');

    const mismatch = await fetch(url('/v1/projects/demo/secrets/token:addVersion'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: { data: Buffer.from('nope').toString('base64'), dataCrc32c: '1' },
      }),
    });

    expect(mismatch.status).toBe(400);
  });

  test('lists global and regional parents separately, newest first, in pages', async () => {
    for (const parent of ['/v1/projects/list-fetch', '/v1/projects/list-fetch/locations/eu']) {
      for (const id of ['one', 'two', 'three']) {
        const created = await fetch(`${url(`${parent}/secrets`)}?secretId=${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(parent.includes('/locations/') ? {} : replicated),
        });

        expect(created.status).toBe(200);
      }
    }

    const first = await fetch(`${url('/v1/projects/list-fetch/secrets')}?pageSize=2`);
    const firstBody = (await first.json()) as ListBody;

    expect(first.status).toBe(200);
    expect(firstBody.secrets).toHaveLength(2);
    expect(firstBody.totalSize).toBe(3);
    expect(firstBody.nextPageToken).toBeTypeOf('string');

    const second = await fetch(
      `${url('/v1/projects/list-fetch/secrets')}?pageSize=2&pageToken=${firstBody.nextPageToken}`
    );
    const secondBody = (await second.json()) as ListBody;
    const listed = [...firstBody.secrets, ...secondBody.secrets];

    expect(secondBody.nextPageToken).toBeUndefined();
    expect(listed.map(secret => secret.name).sort()).toEqual([
      'projects/list-fetch/secrets/one',
      'projects/list-fetch/secrets/three',
      'projects/list-fetch/secrets/two',
    ]);
    expectNewestFirst(listed);

    const regional = await fetch(url('/v1/projects/list-fetch/locations/eu/secrets'));
    const regionalBody = (await regional.json()) as ListBody;

    expect(regionalBody.secrets.map(secret => secret.name).sort()).toEqual([
      'projects/list-fetch/locations/eu/secrets/one',
      'projects/list-fetch/locations/eu/secrets/three',
      'projects/list-fetch/locations/eu/secrets/two',
    ]);
    expect(regionalBody.nextPageToken).toBeUndefined();

    const filtered = await fetch(`${url('/v1/projects/list-fetch/secrets')}?filter=name:one`);
    const filteredBody = (await filtered.json()) as { error: { status: string } };

    expect(filtered.status).toBe(501);
    expect(filteredBody.error.status).toBe('UNIMPLEMENTED');
  });

  test('deletes global and regional secrets, honours etag, and recreates from version 1', async () => {
    for (const parent of ['/v1/projects/delete-fetch', '/v1/projects/delete-fetch/locations/eu']) {
      const secretPath = `${parent}/secrets/doomed`;

      await fetch(`${url(`${parent}/secrets`)}?secretId=doomed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parent.includes('/locations/') ? {} : replicated),
      });
      await addVersion(secretPath, 'old');

      const stale = await fetch(`${url(secretPath)}?etag=99`, { method: 'DELETE' });

      expect(stale.status).toBe(409);
      expect(((await stale.json()) as { error: { status: string } }).error.status).toBe('ABORTED');

      const deleted = await fetch(`${url(secretPath)}?etag=1`, { method: 'DELETE' });

      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({});
      expect((await fetch(url(secretPath))).status).toBe(404);

      const missing = await fetch(url(secretPath), { method: 'DELETE' });

      expect(missing.status).toBe(404);

      await fetch(`${url(`${parent}/secrets`)}?secretId=doomed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parent.includes('/locations/') ? {} : replicated),
      });

      expect((await fetch(url(`${secretPath}/versions/latest:access`))).status).toBe(404);

      const version = await addVersion(secretPath, 'new');

      expect(version.name).toBe(`${secretPath.slice('/v1/'.length)}/versions/1`);

      const access = await fetch(url(`${secretPath}/versions/1:access`));
      const accessed = (await access.json()) as { payload: { data: string } };

      expect(Buffer.from(accessed.payload.data, 'base64').toString()).toBe('new');
    }
  });
});

describe('Secret Manager E2E: official client over REST', () => {
  test('lists and deletes on global and regional parents', async () => {
    const client = new SecretManagerServiceClient({
      fallback: 'rest',
      apiEndpoint: 'localhost',
      port: emulatorPort,
      protocol: 'http',
      auth: createFakeAuth('client-list') as never,
    });

    for (const parent of ['projects/client-list', 'projects/client-list/locations/eu']) {
      const secret = parent.includes('/locations/') ? {} : { replication: { automatic: {} } };

      for (const secretId of ['a', 'b', 'c']) {
        await client.createSecret({ parent, secretId, secret });
      }

      const [all] = await client.listSecrets({ parent, pageSize: 2 });

      expect(all.map(listed => listed.name).sort()).toEqual([
        `${parent}/secrets/a`,
        `${parent}/secrets/b`,
        `${parent}/secrets/c`,
      ]);

      const [page, nextRequest, response] = await client.listSecrets(
        { parent, pageSize: 2 },
        { autoPaginate: false }
      );

      expect(page).toHaveLength(2);
      expect(nextRequest?.pageToken).toBeTypeOf('string');
      expect(response?.totalSize).toBe(3);

      const stale = client.deleteSecret({ name: `${parent}/secrets/a`, etag: '99' });

      await expect(stale).rejects.toHaveProperty('code', 10);

      await client.deleteSecret({ name: `${parent}/secrets/a` });

      const missing = client.getSecret({ name: `${parent}/secrets/a` });

      await expect(missing).rejects.toHaveProperty('code', 5);

      const filtered = client.listSecrets({ parent, filter: 'name:b' });

      await expect(filtered).rejects.toHaveProperty('code', 12);
    }

    const [global] = await client.listSecrets({ parent: 'projects/client-list' });

    expect(global.map(listed => listed.name).sort()).toEqual([
      'projects/client-list/secrets/b',
      'projects/client-list/secrets/c',
    ]);

    client.close();
  });

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

    const [version] = await client.addSecretVersion({
      parent: created.name,
      payload: { data: Buffer.from('s3cret') },
    });

    expect(version.name).toBe('projects/client-project/secrets/from-client/versions/1');

    const [accessed] = await client.accessSecretVersion({
      name: `${created.name}/versions/latest`,
    });

    expect(Buffer.from(accessed.payload?.data ?? new Uint8Array()).toString()).toBe('s3cret');

    const iam = client.getIamPolicy({ resource: created.name });

    await expect(iam).rejects.toHaveProperty('code', 12);

    client.close();
  });
});
