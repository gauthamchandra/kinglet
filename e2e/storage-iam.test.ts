/**
 * Bucket IAM: policies are stored, not evaluated.
 *
 * Stale-etag HTTP status recorded by this suite: 409 (error.status ABORTED).
 * The assertion accepts 412 as well. 412 is not treated as the wrong status.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '@google-cloud/storage';
import type { Server } from 'bun';
import { StorageManager } from '@/core/storage/manager.ts';
import { CloudStorageService } from '@/services/storage/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { buildProductionRouter } from './e2e-helpers.ts';

let emulatorServer: Server;
let emulatorPort: number;
let cloudStorageService: CloudStorageService;
let blobRoot: string;

function emulatorUrl(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

beforeAll(async () => {
  emulatorPort = await getAvailablePort();
  blobRoot = await mkdtemp(join(tmpdir(), 'kinglet-e2e-storage-iam-'));

  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const logger = new Logger('e2e-storage-iam', 'error');
  cloudStorageService = new CloudStorageService(storage, logger, {
    blobPath: blobRoot,
    storageType: 'memory',
  });
  await cloudStorageService.initialize();

  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: buildProductionRouter(cloudStorageService.getRoutes()),
  });
});

afterAll(async () => {
  await cloudStorageService.stop('memory');
  emulatorServer.stop();
  rmSync(blobRoot, { recursive: true, force: true });
});

async function createBucket(name: string): Promise<void> {
  const response = await fetch(emulatorUrl(`/storage/v1/b?project=iam-project`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });

  expect(response.status).toBe(200);
}

describe('Cloud Storage bucket IAM', () => {
  test('empty get with optionsRequestedPolicyVersion=3 returns version 1', async () => {
    await createBucket('iam-http-empty');

    const response = await fetch(
      emulatorUrl(
        '/storage/v1/b/iam-http-empty/iam?optionsRequestedPolicyVersion=3&userProject=other'
      )
    );

    expect(response.status).toBe(200);

    const policy = await response.json();

    expect(policy.kind).toBe('storage#policy');
    expect(policy.resourceId).toBe('projects/_/buckets/iam-http-empty');
    expect(policy.version).toBe(1);
    expect(policy.etag).toBeTypeOf('string');
    expect(policy.etag.length).toBeGreaterThan(0);
  });

  test('set rotates etags, a stale etag is rejected, and a missing etag overwrites', async () => {
    await createBucket('iam-http-set');

    const initialResponse = await fetch(emulatorUrl('/storage/v1/b/iam-http-set/iam'));

    expect(initialResponse.status).toBe(200);

    const initial = await initialResponse.json();
    const firstResponse = await fetch(emulatorUrl('/storage/v1/b/iam-http-set/iam'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        etag: initial.etag,
        bindings: [{ role: 'roles/storage.objectViewer', members: ['user:a@example.com'] }],
      }),
    });

    expect(firstResponse.status).toBe(200);

    const first = await firstResponse.json();

    expect(first.etag).not.toBe(initial.etag);
    expect(first.etag.length).toBeGreaterThan(0);
    expect(first.kind).toBe('storage#policy');
    expect(first.resourceId).toBe('projects/_/buckets/iam-http-set');

    const secondResponse = await fetch(emulatorUrl('/storage/v1/b/iam-http-set/iam'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 3,
        etag: first.etag,
        bindings: [{ role: 'roles/storage.admin', members: ['user:b@example.com'] }],
      }),
    });

    expect(secondResponse.status).toBe(200);

    const second = await secondResponse.json();

    expect(second.etag).not.toBe(first.etag);
    expect(second.version).toBe(3);

    const requestedV1 = await fetch(
      emulatorUrl('/storage/v1/b/iam-http-set/iam?optionsRequestedPolicyVersion=1')
    );

    expect(requestedV1.status).toBe(200);

    const requestedV1Policy = await requestedV1.json();

    expect(requestedV1Policy.version).toBe(3);
    expect(requestedV1Policy.etag).toBe(second.etag);

    const staleResponse = await fetch(emulatorUrl('/storage/v1/b/iam-http-set/iam'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        etag: first.etag,
        bindings: [{ role: 'roles/storage.objectAdmin', members: ['allUsers'] }],
      }),
    });

    // Recorded stale-etag status: 409 ABORTED. 412 is accepted and is not locked.
    expect([409, 412]).toContain(staleResponse.status);

    const staleBody = await staleResponse.json();

    expect(staleBody.error.code).toBe(staleResponse.status);

    const afterStale = await fetch(
      emulatorUrl('/storage/v1/b/iam-http-set/iam?optionsRequestedPolicyVersion=3')
    );

    expect(afterStale.status).toBe(200);

    const stored = await afterStale.json();

    expect(stored.version).toBe(3);
    expect(stored.etag).toBe(second.etag);
    expect(stored.bindings).toEqual(second.bindings);

    const overwriteResponse = await fetch(emulatorUrl('/storage/v1/b/iam-http-set/iam'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bindings: [] }),
    });

    expect(overwriteResponse.status).toBe(200);

    const cleared = await overwriteResponse.json();

    expect(cleared.version).toBe(1);
    expect(cleared.bindings).toEqual([]);
    expect(cleared.etag).not.toBe(second.etag);
    expect(cleared.etag.length).toBeGreaterThan(0);
  });

  test('testIamPermissions echoes requested permissions', async () => {
    await createBucket('iam-http-echo');

    const response = await fetch(
      emulatorUrl(
        '/storage/v1/b/iam-http-echo/iam/testPermissions?permissions=storage.buckets.get&permissions=storage.objects.delete&permissions=not.a.real.permission'
      )
    );

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.kind).toBe('storage#testIamPermissionsResponse');
    expect(body.permissions).toEqual([
      'storage.buckets.get',
      'storage.objects.delete',
      'not.a.real.permission',
    ]);
  });

  test('missing bucket is 404', async () => {
    const response = await fetch(emulatorUrl('/storage/v1/b/iam-http-missing/iam'));

    expect(response.status).toBe(404);
  });
});

async function insertObject(bucket: string, name: string): Promise<void> {
  const response = await fetch(
    emulatorUrl(
      `/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(name)}`
    ),
    {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'object-bytes',
    }
  );

  expect(response.status).toBe(200);
}

describe('Cloud Storage object IAM', () => {
  test('empty get returns version 1, resourceId, and kind storage#policy', async () => {
    await createBucket('obj-iam-http-empty');
    await insertObject('obj-iam-http-empty', 'empty.txt');

    const response = await fetch(
      emulatorUrl('/storage/v1/b/obj-iam-http-empty/o/empty.txt/iam?userProject=other')
    );

    expect(response.status).toBe(200);

    const policy = await response.json();

    expect(policy.kind).toBe('storage#policy');
    expect(policy.resourceId).toBe('projects/_/buckets/obj-iam-http-empty/objects/empty.txt');
    expect(policy.version).toBe(1);
    expect(policy.etag).toBeTypeOf('string');
    expect(policy.etag.length).toBeGreaterThan(0);
  });

  test('set rotates etags, a stale etag is rejected, and a missing etag overwrites', async () => {
    await createBucket('obj-iam-http-set');
    await insertObject('obj-iam-http-set', 'folder/nested.txt');

    const objectPath = `/storage/v1/b/obj-iam-http-set/o/${encodeURIComponent('folder/nested.txt')}`;
    const initialResponse = await fetch(emulatorUrl(`${objectPath}/iam`));

    expect(initialResponse.status).toBe(200);

    const initial = await initialResponse.json();
    const firstResponse = await fetch(emulatorUrl(`${objectPath}/iam`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        etag: initial.etag,
        bindings: [{ role: 'roles/storage.objectViewer', members: ['user:a@example.com'] }],
      }),
    });

    expect(firstResponse.status).toBe(200);

    const first = await firstResponse.json();

    expect(first.etag).not.toBe(initial.etag);
    expect(first.etag.length).toBeGreaterThan(0);
    expect(first.kind).toBe('storage#policy');
    expect(first.resourceId).toBe('projects/_/buckets/obj-iam-http-set/objects/folder/nested.txt');

    const secondResponse = await fetch(emulatorUrl(`${objectPath}/iam`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 3,
        etag: first.etag,
        bindings: [{ role: 'roles/storage.admin', members: ['user:b@example.com'] }],
      }),
    });

    expect(secondResponse.status).toBe(200);

    const second = await secondResponse.json();

    expect(second.etag).not.toBe(first.etag);
    expect(second.version).toBe(3);

    const requested = await fetch(emulatorUrl(`${objectPath}/iam?optionsRequestedPolicyVersion=1`));

    expect(requested.status).toBe(200);

    const requestedPolicy = await requested.json();

    expect(requestedPolicy.version).toBe(3);
    expect(requestedPolicy.etag).toBe(second.etag);

    const staleResponse = await fetch(emulatorUrl(`${objectPath}/iam`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        etag: first.etag,
        bindings: [{ role: 'roles/storage.objectAdmin', members: ['allUsers'] }],
      }),
    });

    // Recorded stale-etag status: 409 ABORTED. 412 is accepted and is not locked.
    expect([409, 412]).toContain(staleResponse.status);

    const staleBody = await staleResponse.json();

    expect(staleBody.error.code).toBe(staleResponse.status);

    const afterStale = await fetch(emulatorUrl(`${objectPath}/iam`));

    expect(afterStale.status).toBe(200);

    const stored = await afterStale.json();

    expect(stored.version).toBe(3);
    expect(stored.etag).toBe(second.etag);
    expect(stored.bindings).toEqual(second.bindings);

    const overwriteResponse = await fetch(emulatorUrl(`${objectPath}/iam`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bindings: [] }),
    });

    expect(overwriteResponse.status).toBe(200);

    const cleared = await overwriteResponse.json();

    expect(cleared.version).toBe(1);
    expect(cleared.bindings).toEqual([]);
    expect(cleared.etag).not.toBe(second.etag);
    expect(cleared.etag.length).toBeGreaterThan(0);
  });

  test('testIamPermissions echoes requested permissions', async () => {
    await createBucket('obj-iam-http-echo');
    await insertObject('obj-iam-http-echo', 'echo.txt');

    const response = await fetch(
      emulatorUrl(
        '/storage/v1/b/obj-iam-http-echo/o/echo.txt/iam/testPermissions?permissions=storage.objects.get&permissions=storage.objects.delete&permissions=not.a.real.permission'
      )
    );

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.kind).toBe('storage#testIamPermissionsResponse');
    expect(body.permissions).toEqual([
      'storage.objects.get',
      'storage.objects.delete',
      'not.a.real.permission',
    ]);
  });

  test('missing object is 404', async () => {
    await createBucket('obj-iam-http-missing');

    const response = await fetch(
      emulatorUrl('/storage/v1/b/obj-iam-http-missing/o/missing.txt/iam')
    );

    expect(response.status).toBe(404);
  });

  test('deleting the object drops the policy', async () => {
    await createBucket('obj-iam-http-delete');
    await insertObject('obj-iam-http-delete', 'gone.txt');

    const setResponse = await fetch(
      emulatorUrl('/storage/v1/b/obj-iam-http-delete/o/gone.txt/iam'),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bindings: [{ role: 'roles/storage.objectViewer', members: ['user:a@example.com'] }],
        }),
      }
    );

    expect(setResponse.status).toBe(200);

    const deleted = await fetch(emulatorUrl('/storage/v1/b/obj-iam-http-delete/o/gone.txt'), {
      method: 'DELETE',
    });

    expect(deleted.status).toBe(204);

    await insertObject('obj-iam-http-delete', 'gone.txt');

    const policyResponse = await fetch(
      emulatorUrl('/storage/v1/b/obj-iam-http-delete/o/gone.txt/iam')
    );

    expect(policyResponse.status).toBe(200);

    const policy = await policyResponse.json();

    expect(policy.version).toBe(1);
    expect(policy.bindings).toEqual([]);
  });
});

describe('Cloud Storage bucket IAM client', () => {
  test('client get, set, and testPermissions round-trip', async () => {
    const storageClient = new Storage({
      projectId: 'iam-project',
      apiEndpoint: `http://localhost:${emulatorPort}`,
    });
    const [bucket] = await storageClient.createBucket('iam-client-bucket');
    const [empty] = await bucket.iam.getPolicy({ requestedPolicyVersion: 3 });

    expect(empty.version).toBe(1);
    expect(empty.etag).toBeTypeOf('string');
    expect((empty.etag ?? '').length).toBeGreaterThan(0);

    const [updated] = await bucket.iam.setPolicy({
      etag: empty.etag,
      bindings: [{ role: 'roles/storage.objectViewer', members: ['user:a@example.com'] }],
    });

    expect(updated.etag).not.toBe(empty.etag);
    expect(updated.bindings).toEqual([
      { role: 'roles/storage.objectViewer', members: ['user:a@example.com'] },
    ]);

    const [permissions] = await bucket.iam.testPermissions([
      'storage.buckets.get',
      'storage.objects.delete',
    ]);

    expect(permissions).toEqual({
      'storage.buckets.get': true,
      'storage.objects.delete': true,
    });
  });
});
