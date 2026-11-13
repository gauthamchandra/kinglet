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
});

async function patchSecret(
  name: string,
  updateMask: string | null,
  body: unknown
): Promise<Response> {
  const query = updateMask == null ? '' : `?updateMask=${encodeURIComponent(updateMask)}`;

  return fetch(`${url(`/v1/${name}`)}${query}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createWithVersions(parent: string, secretId: string, values: string[]) {
  const created = await fetch(`${url(`/v1/${parent}/secrets`)}?secretId=${secretId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      parent.includes('/locations/')
        ? { labels: { team: 'core' } }
        : { replication: { automatic: {} }, labels: { team: 'core' } }
    ),
  });

  expect(created.status).toBe(200);

  for (const value of values) {
    const added = await fetch(url(`/v1/${parent}/secrets/${secretId}:addVersion`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { data: Buffer.from(value).toString('base64') } }),
    });

    expect(added.status).toBe(200);
  }

  return `${parent}/secrets/${secretId}`;
}

describe('Secret Manager E2E: UpdateSecret over REST fetch', () => {
  test.each([
    ['projects/update-rest'],
    ['projects/update-rest/locations/us-central1'],
  ])('sets labels and an alias under %s, then gets and accesses by alias', async parent => {
    const name = await createWithVersions(parent, 'aliased', ['one', 'two']);
    const before = await fetch(url(`/v1/${name}/versions/current:access`));

    expect(before.status).toBe(404);

    const patched = await patchSecret(name, 'labels,version_aliases', {
      labels: { env: 'prod' },
      versionAliases: { current: '1' },
    });
    const secret = (await patched.json()) as {
      name: string;
      etag: string;
      labels: Record<string, string>;
      versionAliases: Record<string, string>;
    };

    expect(patched.status).toBe(200);
    expect(secret.name).toBe(name);
    expect(secret.etag).toBe('2');
    expect(secret.labels).toEqual({ env: 'prod' });
    expect(secret.versionAliases).toEqual({ current: '1' });

    const version = await fetch(url(`/v1/${name}/versions/current`));

    expect(version.status).toBe(200);
    expect(((await version.json()) as { name: string }).name).toBe(`${name}/versions/1`);

    const access = await fetch(url(`/v1/${name}/versions/current:access`));
    const accessed = (await access.json()) as { name: string; payload: { data: string } };

    expect(access.status).toBe(200);
    expect(accessed.name).toBe(`${name}/versions/1`);
    expect(Buffer.from(accessed.payload.data, 'base64').toString()).toBe('one');
  });

  test.each([
    [null],
    [''],
    ['*'],
    ['labels.env'],
    ['replication'],
    ['secretType'],
    ['name'],
    ['createTime'],
    ['bogus'],
  ])('mask %p is INVALID_ARGUMENT', async mask => {
    const name = await createWithVersions(
      'projects/update-rest-masks',
      `m${crypto.randomUUID()}`,
      []
    );
    const response = await patchSecret(name, mask, { labels: { env: 'prod' } });
    const body = (await response.json()) as { error: { status: string } };

    expect(response.status).toBe(400);
    expect(body.error.status).toBe('INVALID_ARGUMENT');
    expect(((await (await fetch(url(`/v1/${name}`))).json()) as { etag: string }).etag).toBe('1');
  });

  test('a masked field absent from the body clears it and an unmasked field is ignored', async () => {
    const name = await createWithVersions('projects/update-rest', 'clearing', []);
    const response = await patchSecret(name, 'labels', {
      annotations: { owner: 'ops' },
      replication: { userManaged: { replicas: [{ location: 'us-east1' }] } },
    });
    const secret = (await response.json()) as {
      labels?: unknown;
      annotations?: unknown;
      replication: unknown;
    };

    expect(response.status).toBe(200);
    expect(secret.labels).toBeUndefined();
    expect(secret.annotations).toBeUndefined();
    expect(secret.replication).toEqual({ automatic: {} });
  });

  test('a stale etag is ABORTED and a no-op keeps the etag', async () => {
    const name = await createWithVersions('projects/update-rest', 'etagged', []);
    const stale = await patchSecret(name, 'labels', { etag: '9', labels: { env: 'x' } });
    const staleBody = (await stale.json()) as { error: { status: string } };

    expect(stale.status).toBe(409);
    expect(staleBody.error.status).toBe('ABORTED');

    const noop = await patchSecret(name, 'labels', { etag: '1', labels: { team: 'core' } });

    expect(noop.status).toBe(200);
    expect(((await noop.json()) as { etag: string }).etag).toBe('1');

    const changed = await patchSecret(name, 'labels', { etag: '1', labels: { team: 'edge' } });

    expect(((await changed.json()) as { etag: string }).etag).toBe('2');
  });

  test('ttl becomes expireTime and is never returned', async () => {
    const name = await createWithVersions('projects/update-rest', 'expiring', []);
    const response = await patchSecret(name, 'ttl', { ttl: '3600s' });
    const secret = (await response.json()) as { expireTime: string; ttl?: unknown };

    expect(response.status).toBe(200);
    expect(Date.parse(secret.expireTime) - Date.now()).toBeGreaterThan(3500 * 1000);
    expect(secret.ttl).toBeUndefined();

    const got = (await (await fetch(url(`/v1/${name}`))).json()) as {
      expireTime: string;
      ttl?: unknown;
    };

    expect(got.expireTime).toBe(secret.expireTime);
    expect(got.ttl).toBeUndefined();
  });

  test('rejects reserved aliases and too many topics, and 404s a missing secret', async () => {
    const name = await createWithVersions('projects/update-rest', 'limits', ['one']);

    for (const alias of ['latest', 'NEW']) {
      const reserved = await patchSecret(name, 'versionAliases', {
        versionAliases: { [alias]: '1' },
      });

      expect(reserved.status).toBe(400);
    }

    const topics = Array.from({ length: 11 }, (_, i) => ({ name: `projects/p/topics/t${i}` }));
    const tooMany = await patchSecret(name, 'topics', { topics });

    expect(tooMany.status).toBe(400);

    const missing = await patchSecret('projects/update-rest/secrets/nope', 'labels', {});

    expect(missing.status).toBe(404);
  });
});

describe('Secret Manager E2E: official client over REST', () => {
  test.each([
    ['projects/client-project'],
    ['projects/client-project/locations/us-central1'],
  ])('updates labels and an alias under %s, then accesses by alias', async parent => {
    const client = new SecretManagerServiceClient({
      fallback: 'rest',
      apiEndpoint: 'localhost',
      port: emulatorPort,
      protocol: 'http',
      auth: createFakeAuth('client-project') as never,
    });

    const [created] = await client.createSecret({
      parent,
      secretId: 'client-update',
      secret: parent.includes('/locations/') ? {} : { replication: { automatic: {} } },
    });

    await client.addSecretVersion({ parent: created.name, payload: { data: Buffer.from('one') } });
    await client.addSecretVersion({ parent: created.name, payload: { data: Buffer.from('two') } });

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

    const [accessed] = await client.accessSecretVersion({
      name: `${created.name}/versions/current`,
    });

    expect(accessed.name).toBe(`${created.name}/versions/1`);
    expect(Buffer.from(accessed.payload?.data ?? new Uint8Array()).toString()).toBe('one');

    const stale = client.updateSecret({
      secret: { name: created.name, etag: '1', labels: {} },
      updateMask: { paths: ['labels'] },
    });

    await expect(stale).rejects.toHaveProperty('code', 10);

    client.close();
  });

  test('a get then ttl update applies ttl and ignores the expireTime sent back', async () => {
    const client = new SecretManagerServiceClient({
      fallback: 'rest',
      apiEndpoint: 'localhost',
      port: emulatorPort,
      protocol: 'http',
      auth: createFakeAuth('client-project') as never,
    });

    const [created] = await client.createSecret({
      parent: 'projects/client-project',
      secretId: 'ttl-mask',
      secret: { replication: { automatic: {} } },
    });

    await client.updateSecret({
      secret: { name: created.name, expireTime: { seconds: 1893456000 } },
      updateMask: { paths: ['expire_time'] },
    });

    const [got] = await client.getSecret({ name: created.name });

    got.ttl = { seconds: 7200 };

    const [updated] = await client.updateSecret({
      secret: got,
      updateMask: { paths: ['ttl'] },
    });

    const remaining = Number(updated.expireTime?.seconds) * 1000 - Date.now();

    expect(remaining).toBeGreaterThan(7000 * 1000);
    expect(remaining).toBeLessThan(7400 * 1000);

    const [cleared] = await client.updateSecret({
      secret: { name: created.name, expireTime: updated.expireTime },
      updateMask: { paths: ['ttl'] },
    });

    expect(cleared.expireTime).toBeUndefined();
    expect(cleared.etag).not.toBe(updated.etag);

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
