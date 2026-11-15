/**
 * Bucket IAM: policies are stored, not evaluated.
 *
 * Stale-etag HTTP status recorded by this suite: 409 (error.status ABORTED).
 * The assertion accepts 412 as well. 412 is not treated as the wrong status.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Storage } from '@google-cloud/storage';
import type { Server } from 'bun';
import { StorageManager } from '@/core/storage/manager.ts';
import { CloudStorageService } from '@/services/storage/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { buildProductionRouter } from './e2e-helpers.ts';

const RECORDED_STALE_BUCKET_IAM_ETAG_STATUS = 409;

let emulatorServer: Server;
let emulatorPort: number;
let cloudStorageService: CloudStorageService;

function emulatorUrl(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

beforeAll(async () => {
  emulatorPort = await getAvailablePort();

  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const logger = new Logger('e2e-storage-iam', 'error');
  cloudStorageService = new CloudStorageService(storage, logger);
  await cloudStorageService.initialize();

  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: buildProductionRouter(cloudStorageService.getRoutes()),
  });
});

afterAll(async () => {
  await cloudStorageService.stop();
  emulatorServer.stop();
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

    expect([409, 412]).toContain(staleResponse.status);
    expect(staleResponse.status).toBe(RECORDED_STALE_BUCKET_IAM_ETAG_STATUS);

    const staleBody = await staleResponse.json();

    expect(staleBody.error.code).toBe(RECORDED_STALE_BUCKET_IAM_ETAG_STATUS);
    expect(staleBody.error.status).toBe('ABORTED');

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
