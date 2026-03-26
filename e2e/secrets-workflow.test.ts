/**
 * End-to-End Test: Secret Manager Workflow
 *
 * True black-box tests — validates the full lifecycle through HTTP only.
 * Two test paths:
 *   1. Raw HTTP fetch against the emulator
 *   2. Official @google-cloud/secret-manager client library
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { Server } from 'bun';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { SecretsManagerService } from '@/services/secrets/index.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { buildRouter, createFakeAuth } from './e2e-helpers.ts';

// ── Test Infrastructure ──

let emulatorServer: Server;
let emulatorPort: number;
let secretsService: SecretsManagerService;

function emulatorUrl(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

// ── Setup / Teardown ──

beforeAll(async () => {
  emulatorPort = await getAvailablePort();

  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const logger = new Logger('e2e-secrets', 'error');
  secretsService = new SecretsManagerService(storage, logger);
  await secretsService.initialize();

  const routes = secretsService.getRoutes();
  const router = buildRouter(routes);

  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: router,
  });
});

afterAll(async () => {
  await secretsService.stop();
  emulatorServer.stop();
});

// ── Test Path 1: Raw HTTP Fetch ──

describe('Secret Manager E2E: Raw HTTP API', () => {
  const project = 'test-project';
  const secretId = 'e2e-test-secret';
  const secretsBasePath = `/v1/projects/${project}/secrets`;

  test('1. Create a secret', async () => {
    const response = await fetch(emulatorUrl(`${secretsBasePath}?secretId=${secretId}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        replication: { automatic: {} },
        labels: { env: 'e2e' },
      }),
    });

    expect(response.status).toBe(200);

    const secret = await response.json();

    expect(secret.name).toBe(`projects/${project}/secrets/${secretId}`);
    expect(secret.replication).toEqual({ automatic: {} });
    expect(secret.labels).toEqual({ env: 'e2e' });
    expect(secret.createTime).toBeTypeOf('string');
    expect(secret.etag).toBeTypeOf('string');
  });

  test('2. Get the secret', async () => {
    const response = await fetch(emulatorUrl(`${secretsBasePath}/${secretId}`));

    expect(response.status).toBe(200);

    const secret = await response.json();

    expect(secret.name).toBe(`projects/${project}/secrets/${secretId}`);
    expect(secret.labels).toEqual({ env: 'e2e' });
  });

  test('3. List secrets', async () => {
    const response = await fetch(emulatorUrl(secretsBasePath));

    expect(response.status).toBe(200);

    const result = await response.json();

    expect(result.secrets).toBeDefined();
    expect(result.secrets.length).toBeGreaterThanOrEqual(1);
  });

  test('4. Update the secret', async () => {
    const response = await fetch(emulatorUrl(`${secretsBasePath}/${secretId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        labels: { env: 'e2e', updated: 'true' },
      }),
    });

    expect(response.status).toBe(200);

    const secret = await response.json();

    expect(secret.labels).toEqual({ env: 'e2e', updated: 'true' });
  });

  test('5. Add a secret version', async () => {
    const response = await fetch(emulatorUrl(`${secretsBasePath}/${secretId}:addVersion`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: { data: btoa('my-secret-value-v1') },
      }),
    });

    expect(response.status).toBe(200);

    const version = await response.json();

    expect(version.name).toBe(`projects/${project}/secrets/${secretId}/versions/1`);
    expect(version.state).toBe('ENABLED');
    expect(version.createTime).toBeTypeOf('string');
  });

  test('6. Add a second version', async () => {
    const response = await fetch(emulatorUrl(`${secretsBasePath}/${secretId}:addVersion`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: { data: btoa('my-secret-value-v2') },
      }),
    });

    expect(response.status).toBe(200);

    const version = await response.json();

    expect(version.name).toBe(`projects/${project}/secrets/${secretId}/versions/2`);
  });

  test('7. Access specific version', async () => {
    const response = await fetch(emulatorUrl(`${secretsBasePath}/${secretId}/versions/1:access`));

    expect(response.status).toBe(200);

    const result = await response.json();

    expect(result.name).toBe(`projects/${project}/secrets/${secretId}/versions/1`);
    expect(atob(result.payload.data)).toBe('my-secret-value-v1');
  });

  test('8. Access "latest" version resolves to v2', async () => {
    const response = await fetch(
      emulatorUrl(`${secretsBasePath}/${secretId}/versions/latest:access`)
    );

    expect(response.status).toBe(200);

    const result = await response.json();

    expect(atob(result.payload.data)).toBe('my-secret-value-v2');
  });

  test('9. Get version metadata', async () => {
    const response = await fetch(emulatorUrl(`${secretsBasePath}/${secretId}/versions/1`));

    expect(response.status).toBe(200);

    const version = await response.json();

    expect(version.name).toBe(`projects/${project}/secrets/${secretId}/versions/1`);
    expect(version.state).toBe('ENABLED');
    expect(version.etag).toBeTypeOf('string');
  });

  test('10. List versions', async () => {
    const response = await fetch(emulatorUrl(`${secretsBasePath}/${secretId}/versions`));

    expect(response.status).toBe(200);

    const result = await response.json();

    expect(result.versions).toBeDefined();
    expect(result.versions.length).toBe(2);
  });

  test('11. Disable a version', async () => {
    const response = await fetch(emulatorUrl(`${secretsBasePath}/${secretId}/versions/1:disable`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);

    const version = await response.json();

    expect(version.state).toBe('DISABLED');
  });

  test('12. Accessing disabled version returns error', async () => {
    const response = await fetch(emulatorUrl(`${secretsBasePath}/${secretId}/versions/1:access`));

    expect(response.status).toBe(400);

    const error = await response.json();

    expect(error.error.status).toBe('FAILED_PRECONDITION');
  });

  test('13. Enable the version back', async () => {
    const response = await fetch(emulatorUrl(`${secretsBasePath}/${secretId}/versions/1:enable`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);

    const version = await response.json();

    expect(version.state).toBe('ENABLED');
  });

  test('14. Access works again after re-enabling', async () => {
    const response = await fetch(emulatorUrl(`${secretsBasePath}/${secretId}/versions/1:access`));

    expect(response.status).toBe(200);

    const result = await response.json();

    expect(atob(result.payload.data)).toBe('my-secret-value-v1');
  });

  test('15. Destroy a version', async () => {
    const response = await fetch(emulatorUrl(`${secretsBasePath}/${secretId}/versions/1:destroy`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);

    const version = await response.json();

    expect(version.state).toBe('DESTROYED');
    expect(version.destroyTime).toBeTypeOf('string');
  });

  test('16. Accessing destroyed version returns error', async () => {
    const response = await fetch(emulatorUrl(`${secretsBasePath}/${secretId}/versions/1:access`));

    expect(response.status).toBe(400);
  });

  test('17. Destroying already-destroyed version is idempotent', async () => {
    const response = await fetch(emulatorUrl(`${secretsBasePath}/${secretId}/versions/1:destroy`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);

    const version = await response.json();

    expect(version.state).toBe('DESTROYED');
    expect(version.destroyTime).toBeTypeOf('string');
  });

  test('18. "latest" skips destroyed versions', async () => {
    const response = await fetch(
      emulatorUrl(`${secretsBasePath}/${secretId}/versions/latest:access`)
    );

    expect(response.status).toBe(200);

    const result = await response.json();

    expect(atob(result.payload.data)).toBe('my-secret-value-v2');
  });

  test('19. Delete the secret and verify 404', async () => {
    const deleteResponse = await fetch(emulatorUrl(`${secretsBasePath}/${secretId}`), {
      method: 'DELETE',
    });

    expect(deleteResponse.status).toBe(200);

    const getResponse = await fetch(emulatorUrl(`${secretsBasePath}/${secretId}`));

    expect(getResponse.status).toBe(404);
  });

  test('20. Creating duplicate secret returns 409', async () => {
    // Create first
    await fetch(emulatorUrl(`${secretsBasePath}?secretId=dup-test`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replication: { automatic: {} } }),
    });

    // Duplicate
    const response = await fetch(emulatorUrl(`${secretsBasePath}?secretId=dup-test`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replication: { automatic: {} } }),
    });

    expect(response.status).toBe(409);

    // Cleanup
    await fetch(emulatorUrl(`${secretsBasePath}/dup-test`), { method: 'DELETE' });
  });

  test('21. List secrets supports pagination', async () => {
    // Create 3 secrets
    for (const id of ['page-a', 'page-b', 'page-c']) {
      await fetch(emulatorUrl(`${secretsBasePath}?secretId=${id}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replication: { automatic: {} } }),
      });
    }

    const page1 = await fetch(emulatorUrl(`${secretsBasePath}?pageSize=2`));

    expect(page1.status).toBe(200);

    const result1 = await page1.json();

    expect(result1.secrets.length).toBe(2);
    expect(result1.nextPageToken).toBeDefined();

    const page2 = await fetch(
      emulatorUrl(`${secretsBasePath}?pageSize=2&pageToken=${result1.nextPageToken}`)
    );

    expect(page2.status).toBe(200);

    const result2 = await page2.json();

    expect(result2.secrets.length).toBe(1);

    // Cleanup
    for (const id of ['page-a', 'page-b', 'page-c']) {
      await fetch(emulatorUrl(`${secretsBasePath}/${id}`), { method: 'DELETE' });
    }
  });

  test('22. Regional secret CRUD works', async () => {
    const regionalPath = `/v1/projects/${project}/locations/us-central1/secrets`;

    // Create
    const createResp = await fetch(emulatorUrl(`${regionalPath}?secretId=regional-secret`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replication: { automatic: {} } }),
    });

    expect(createResp.status).toBe(200);

    const secret = await createResp.json();

    expect(secret.name).toBe(`projects/${project}/locations/us-central1/secrets/regional-secret`);

    // Add version
    const addResp = await fetch(emulatorUrl(`${regionalPath}/regional-secret:addVersion`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { data: btoa('regional-value') } }),
    });

    expect(addResp.status).toBe(200);

    // Access version
    const accessResp = await fetch(
      emulatorUrl(`${regionalPath}/regional-secret/versions/1:access`)
    );

    expect(accessResp.status).toBe(200);

    const accessResult = await accessResp.json();

    expect(atob(accessResult.payload.data)).toBe('regional-value');

    // Cleanup
    await fetch(emulatorUrl(`${regionalPath}/regional-secret`), { method: 'DELETE' });
  });

  test('23. locations.list returns available locations', async () => {
    const resp = await fetch(emulatorUrl(`/v1/projects/${project}/locations`));

    expect(resp.status).toBe(200);

    const result = await resp.json();

    expect(result.locations).toBeInstanceOf(Array);
    expect(result.locations.length).toBeGreaterThanOrEqual(1);
    expect(result.locations[0].locationId).toBeTypeOf('string');
    expect(result.locations[0].name).toMatch(/^projects\/[^/]+\/locations\/[^/]+$/);
  });

  test('24. locations.get returns a specific location', async () => {
    const resp = await fetch(emulatorUrl(`/v1/projects/${project}/locations/us-central1`));

    expect(resp.status).toBe(200);

    const loc = await resp.json();

    expect(loc.locationId).toBe('us-central1');
    expect(loc.name).toBe(`projects/${project}/locations/us-central1`);
  });
});

// ── Test Path 2: Official @google-cloud/secret-manager Client Library ──

describe('Secret Manager E2E: Client Library', () => {
  const project = 'client-lib-project';
  const secretId = 'client-lib-secret';
  const parent = `projects/${project}`;
  const secretName = `${parent}/secrets/${secretId}`;

  let client: InstanceType<typeof SecretManagerServiceClient>;

  beforeAll(() => {
    const fakeAuth = createFakeAuth(project);

    client = new SecretManagerServiceClient({
      fallback: 'rest',
      apiEndpoint: 'localhost',
      port: emulatorPort,
      protocol: 'http',
      auth: fakeAuth as never,
    });
  });

  test('1. Create a secret via client library', async () => {
    const [secret] = await client.createSecret({
      parent,
      secretId,
      secret: {
        replication: { automatic: {} },
        labels: { source: 'client-lib' },
      },
    });

    expect(secret.name).toBe(secretName);
    expect(secret.labels).toEqual({ source: 'client-lib' });
  });

  test('2. Get the secret via client library', async () => {
    const [secret] = await client.getSecret({ name: secretName });

    expect(secret.name).toBe(secretName);
    expect(secret.labels).toEqual({ source: 'client-lib' });
  });

  test('3. List secrets via client library', async () => {
    const [secrets] = await client.listSecrets({ parent });

    expect(secrets.length).toBeGreaterThanOrEqual(1);

    const found = secrets.find(s => s.name === secretName);

    expect(found).toBeDefined();
  });

  test('4. Update secret via client library', async () => {
    const [secret] = await client.updateSecret({
      secret: {
        name: secretName,
        labels: { source: 'client-lib', updated: 'yes' },
      },
      updateMask: { paths: ['labels'] },
    });

    expect(secret.labels).toEqual({ source: 'client-lib', updated: 'yes' });
  });

  test('5. Add a secret version via client library', async () => {
    const [version] = await client.addSecretVersion({
      parent: secretName,
      payload: {
        data: Buffer.from('client-lib-secret-v1'),
      },
    });

    expect(version.name).toBe(`${secretName}/versions/1`);
    expect(version.state).toBe('ENABLED');
  });

  test('6. Add a second version via client library', async () => {
    const [version] = await client.addSecretVersion({
      parent: secretName,
      payload: {
        data: Buffer.from('client-lib-secret-v2'),
      },
    });

    expect(version.name).toBe(`${secretName}/versions/2`);
  });

  test('7. Access specific version via client library', async () => {
    const [response] = await client.accessSecretVersion({
      name: `${secretName}/versions/1`,
    });

    expect(response.name).toBe(`${secretName}/versions/1`);

    const payload = response.payload?.data;
    const value =
      payload instanceof Uint8Array
        ? new TextDecoder().decode(payload)
        : typeof payload === 'string'
          ? payload
          : '';

    expect(value).toContain('client-lib-secret-v1');
  });

  test('8. Access "latest" version via client library', async () => {
    const [response] = await client.accessSecretVersion({
      name: `${secretName}/versions/latest`,
    });

    const payload = response.payload?.data;
    const value =
      payload instanceof Uint8Array
        ? new TextDecoder().decode(payload)
        : typeof payload === 'string'
          ? payload
          : '';

    expect(value).toContain('client-lib-secret-v2');
  });

  test('9. Get version metadata via client library', async () => {
    const [version] = await client.getSecretVersion({
      name: `${secretName}/versions/1`,
    });

    expect(version.name).toBe(`${secretName}/versions/1`);
    expect(version.state).toBe('ENABLED');
  });

  test('10. List versions via client library', async () => {
    const [versions] = await client.listSecretVersions({
      parent: secretName,
    });

    expect(versions.length).toBe(2);
  });

  test('11. Disable version via client library', async () => {
    const [version] = await client.disableSecretVersion({
      name: `${secretName}/versions/1`,
    });

    expect(version.state).toBe('DISABLED');
  });

  test('12. Enable version via client library', async () => {
    const [version] = await client.enableSecretVersion({
      name: `${secretName}/versions/1`,
    });

    expect(version.state).toBe('ENABLED');
  });

  test('13. Destroy version via client library', async () => {
    const [version] = await client.destroySecretVersion({
      name: `${secretName}/versions/1`,
    });

    expect(version.state).toBe('DESTROYED');
    expect(version.destroyTime).toBeDefined();
  });

  test('14. Accessing destroyed version throws error', async () => {
    const promise = client.accessSecretVersion({
      name: `${secretName}/versions/1`,
    });

    await expect(promise).rejects.toThrow();
  });

  test('15. Delete secret via client library and verify not found', async () => {
    await client.deleteSecret({ name: secretName });

    const promise = client.getSecret({ name: secretName });

    await expect(promise).rejects.toThrow(/not found/i);
  });
});
