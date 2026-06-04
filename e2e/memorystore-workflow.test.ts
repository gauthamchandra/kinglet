/**
 * End-to-End Test: Memorystore for Valkey Control-Plane Lifecycle
 *
 * Black-box tests validating the full instance/aclPolicy/location lifecycle
 * through HTTP, and the core instance lifecycle again through the official
 * @google-cloud/memorystore client library. The data plane (spawning a real
 * valkey-server) is exercised separately in memorystore-data-plane.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MemorystoreClient } from '@google-cloud/memorystore';
import type { Server } from 'bun';
import { createLocationRoutes } from '@/core/gateway/location-routes.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { MemorystoreService } from '@/services/memorystore/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { buildRouter, createFakeAuth } from './e2e-helpers.ts';

let emulatorServer: Server;
let emulatorPort: number;
let memorystoreService: MemorystoreService;

function emulatorUrl(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

beforeAll(async () => {
  emulatorPort = await getAvailablePort();

  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const logger = new Logger('e2e-memorystore', 'error');
  memorystoreService = new MemorystoreService(storage, logger, { enabled: false });
  await memorystoreService.initialize();

  const router = buildRouter([...createLocationRoutes(logger), ...memorystoreService.getRoutes()]);

  emulatorServer = Bun.serve({ port: emulatorPort, fetch: router });
});

afterAll(async () => {
  await memorystoreService.stop();
  emulatorServer.stop();
});

describe('Memorystore E2E: Raw HTTP API', () => {
  const project = 'test-project';
  const location = 'us-central1';
  const instanceId = 'e2e-test-instance';
  const basePath = `/v1/projects/${project}/locations/${location}/instances`;

  test('1. Create an instance - returns a done Operation with metadata-only defaults', async () => {
    const response = await fetch(emulatorUrl(`${basePath}?instanceId=${instanceId}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shardCount: 1, replicaCount: 0, nodeType: 'HIGHMEM_MEDIUM' }),
    });

    expect(response.status).toBe(200);

    const op = await response.json();

    expect(op.done).toBe(true);
    expect(op.metadata['@type']).toBe(
      'type.googleapis.com/google.cloud.memorystore.v1.OperationMetadata'
    );
    expect(op.metadata.verb).toBe('create');

    const instance = op.response;

    expect(instance.name).toBe(`projects/${project}/locations/${location}/instances/${instanceId}`);
    expect(instance.state).toBe('ACTIVE');
    expect(instance.discoveryEndpoints?.[0]?.address).toBeTypeOf('string');
    expect(instance.discoveryEndpoints?.[0]?.port).toBeTypeOf('number');
  });

  test('2. Get the instance - verify ACTIVE state', async () => {
    const response = await fetch(emulatorUrl(`${basePath}/${instanceId}`));

    expect(response.status).toBe(200);

    const instance = await response.json();

    expect(instance.name).toBe(`projects/${project}/locations/${location}/instances/${instanceId}`);
    expect(instance.state).toBe('ACTIVE');
  });

  test('3. List instances - verify the created instance appears', async () => {
    const response = await fetch(emulatorUrl(basePath));

    expect(response.status).toBe(200);

    const result = await response.json();
    const found = result.instances.find((i: Record<string, unknown>) =>
      (i.name as string).includes(instanceId)
    );

    expect(found).toBeDefined();
  });

  test('4. Update the instance - masked field changes, others left alone', async () => {
    const response = await fetch(emulatorUrl(`${basePath}/${instanceId}?updateMask=replicaCount`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replicaCount: 2, shardCount: 99 }),
    });

    expect(response.status).toBe(200);

    const op = await response.json();

    expect(op.metadata.verb).toBe('update');
    expect(op.response.replicaCount).toBe(2);
    expect(op.response.shardCount).not.toBe(99);
  });

  test('5. Add a token auth user - returns a done Operation', async () => {
    const response = await fetch(emulatorUrl(`${basePath}/${instanceId}:addTokenAuthUser`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenAuthUser: 'e2e-user' }),
    });

    expect(response.status).toBe(200);

    const op = await response.json();

    expect(op.done).toBe(true);
    expect(op.metadata.verb).toBe('addTokenAuthUser');
  });

  test('6. List token auth users - verify the added user appears', async () => {
    const response = await fetch(emulatorUrl(`${basePath}/${instanceId}/tokenAuthUsers`));

    expect(response.status).toBe(200);

    const result = await response.json();

    expect(
      result.tokenAuthUsers.some((u: Record<string, unknown>) =>
        (u.name as string).endsWith('/tokenAuthUsers/e2e-user')
      )
    ).toBe(true);
  });

  test('7. Re-add the same token auth user - returns 409 ALREADY_EXISTS', async () => {
    const response = await fetch(emulatorUrl(`${basePath}/${instanceId}:addTokenAuthUser`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenAuthUser: 'e2e-user' }),
    });

    expect(response.status).toBe(409);

    const body = await response.json();

    expect(body.error.status).toBe('ALREADY_EXISTS');
    expect(body.error.details[0].resourceType).toBe('TokenAuthUser');

    const listResponse = await fetch(emulatorUrl(`${basePath}/${instanceId}/tokenAuthUsers`));
    const users = await listResponse.json();

    expect(
      users.tokenAuthUsers.filter((u: Record<string, unknown>) =>
        (u.name as string).endsWith('/tokenAuthUsers/e2e-user')
      )
    ).toHaveLength(1);
  });

  test('8. Backup the instance - implicitly creates a backupCollection', async () => {
    const response = await fetch(emulatorUrl(`${basePath}/${instanceId}:backup`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backupId: 'e2e-backup' }),
    });

    expect(response.status).toBe(200);

    const op = await response.json();

    expect(op.metadata.verb).toBe('backup');

    const collectionsResponse = await fetch(
      emulatorUrl(`/v1/projects/${project}/locations/${location}/backupCollections`)
    );
    const collections = await collectionsResponse.json();

    expect(
      collections.backupCollections.some((c: Record<string, unknown>) =>
        (c.name as string).endsWith(`/backupCollections/${instanceId}`)
      )
    ).toBe(true);
  });

  test('9. Re-backup with the same backupId - returns 409 ALREADY_EXISTS', async () => {
    const response = await fetch(emulatorUrl(`${basePath}/${instanceId}:backup`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backupId: 'e2e-backup' }),
    });

    expect(response.status).toBe(409);

    const body = await response.json();

    expect(body.error.status).toBe('ALREADY_EXISTS');
    expect(body.error.details[0].resourceType).toBe('Backup');
  });

  test('10. Delete the instance - returns a done Operation', async () => {
    const response = await fetch(emulatorUrl(`${basePath}/${instanceId}`), { method: 'DELETE' });

    expect(response.status).toBe(200);

    const op = await response.json();

    expect(op.done).toBe(true);
    expect(op.metadata.verb).toBe('delete');
  });

  test('11. Get the deleted instance - verify 404', async () => {
    const response = await fetch(emulatorUrl(`${basePath}/${instanceId}`));

    expect(response.status).toBe(404);
  });
});

describe('Memorystore E2E: ACL Policies (create returns a bare resource)', () => {
  const project = 'test-project';
  const location = 'us-central1';
  const aclPolicyId = 'e2e-policy';
  const basePath = `/v1/projects/${project}/locations/${location}/aclPolicies`;

  test('create returns the bare AclPolicy resource, not an Operation', async () => {
    const response = await fetch(emulatorUrl(`${basePath}?aclPolicyId=${aclPolicyId}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: [{ username: 'alice', rule: 'on nopass ~* +@all' }] }),
    });

    expect(response.status).toBe(200);

    const body = await response.json();

    expect('done' in body).toBe(false);
    expect(body.name).toBe(`projects/${project}/locations/${location}/aclPolicies/${aclPolicyId}`);
  });

  test('delete with a stale etag returns 409 ABORTED and leaves the policy in place', async () => {
    const response = await fetch(emulatorUrl(`${basePath}/${aclPolicyId}?etag=stale-etag`), {
      method: 'DELETE',
    });

    expect(response.status).toBe(409);

    const body = await response.json();

    expect(body.error.status).toBe('ABORTED');

    const getResponse = await fetch(emulatorUrl(`${basePath}/${aclPolicyId}`));

    expect(getResponse.status).toBe(200);
  });

  test('delete returns an Operation with done:true', async () => {
    const response = await fetch(emulatorUrl(`${basePath}/${aclPolicyId}`), { method: 'DELETE' });

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.done).toBe(true);
  });
});

describe('Memorystore E2E: Locations', () => {
  const project = 'test-project';

  test('list locations returns GCP regions', async () => {
    const response = await fetch(emulatorUrl(`/v1/projects/${project}/locations`));

    expect(response.status).toBe(200);

    const result = await response.json();
    const ids = result.locations.map((l: Record<string, unknown>) => l.locationId);

    expect(ids).toContain('us-central1');
  });
});

describe('Memorystore E2E: Client Library', () => {
  const project = 'client-lib-project';
  const location = 'us-central1';
  const instanceId = 'client-lib-instance';
  const instanceName = `projects/${project}/locations/${location}/instances/${instanceId}`;

  let client: InstanceType<typeof MemorystoreClient>;

  beforeAll(() => {
    const fakeAuth = createFakeAuth(project);

    client = new MemorystoreClient({
      fallback: 'rest',
      apiEndpoint: 'localhost',
      port: emulatorPort,
      protocol: 'http',
      auth: fakeAuth as never,
    });
  });

  test('1. Create instance via client library', async () => {
    const [operation] = await client.createInstance({
      parent: `projects/${project}/locations/${location}`,
      instanceId,
      instance: { name: instanceName, shardCount: 1 },
    });

    const [instance] = await operation.promise();

    expect(instance.name).toBe(instanceName);
    // Proto deserialization converts enum strings to integers (ACTIVE = 2)
    expect(instance.state).not.toBe(0);
  });

  test('2. Get instance via client library', async () => {
    const [instance] = await client.getInstance({ name: instanceName });

    expect(instance.name).toBe(instanceName);
  });

  test('3. List instances via client library', async () => {
    const [instances] = await client.listInstances({
      parent: `projects/${project}/locations/${location}`,
    });

    expect(instances.some(i => i.name === instanceName)).toBe(true);
  });

  test('4. Delete instance via client library', async () => {
    const [operation] = await client.deleteInstance({ name: instanceName });

    await operation.promise();

    const promise = client.getInstance({ name: instanceName });

    await expect(promise).rejects.toThrow();
  });
});
