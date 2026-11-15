/**
 * HMAC key HTTP lifecycle through the production router.
 *
 * Create returns `secret` once. Get and list do not. Update requires `etag`.
 * Delete of an ACTIVE key is 400. No request signature is checked.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  blobRoot = await mkdtemp(join(tmpdir(), 'kinglet-e2e-storage-hmac-'));

  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const logger = new Logger('e2e-storage-hmac', 'error');
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

describe('Cloud Storage HMAC keys', () => {
  const project = 'hmac-project';
  const email = 'hmac-sa@hmac-project.iam.gserviceaccount.com';
  let accessId = '';
  let secret = '';
  let etag = '';

  test('create returns the secret once', async () => {
    const response = await fetch(
      emulatorUrl(
        `/storage/v1/projects/${project}/hmacKeys?serviceAccountEmail=${encodeURIComponent(email)}&userProject=billing`
      ),
      { method: 'POST' }
    );

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.kind).toBe('storage#hmacKey');
    expect(body.secret).toBeTypeOf('string');
    expect(body.secret.length).toBeGreaterThan(0);
    expect(body.metadata.kind).toBe('storage#hmacKeyMetadata');
    expect(body.metadata.state).toBe('ACTIVE');
    expect(body.metadata.serviceAccountEmail).toBe(email);
    expect(body.metadata).not.toHaveProperty('secret');

    accessId = body.metadata.accessId;
    secret = body.secret;
    etag = body.metadata.etag;
  });

  test('get omits the secret', async () => {
    const response = await fetch(
      emulatorUrl(`/storage/v1/projects/${project}/hmacKeys/${accessId}`)
    );

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.kind).toBe('storage#hmacKeyMetadata');
    expect(body.accessId).toBe(accessId);
    expect(body).not.toHaveProperty('secret');
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  test('list omits the secret', async () => {
    const response = await fetch(emulatorUrl(`/storage/v1/projects/${project}/hmacKeys`));

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.kind).toBe('storage#hmacKeysMetadata');
    expect(body.items).toHaveLength(1);
    expect(body.items[0].accessId).toBe(accessId);
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  test('update without an etag is 400', async () => {
    const response = await fetch(
      emulatorUrl(`/storage/v1/projects/${project}/hmacKeys/${accessId}`),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'INACTIVE' }),
      }
    );

    expect(response.status).toBe(400);

    const body = await response.json();

    expect(body.error.status).toBe('INVALID_ARGUMENT');
    expect(body.error.message).toContain('Etag is required');
  });

  test('update with a mismatched etag is 400', async () => {
    const response = await fetch(
      emulatorUrl(`/storage/v1/projects/${project}/hmacKeys/${accessId}`),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'INACTIVE', etag: 'badEtag' }),
      }
    );

    expect(response.status).toBe(400);

    const body = await response.json();

    expect(body.error.message).toBe('Etag does not match expected value.');
  });

  test('delete of an ACTIVE key is 400', async () => {
    const response = await fetch(
      emulatorUrl(`/storage/v1/projects/${project}/hmacKeys/${accessId}`),
      { method: 'DELETE' }
    );

    expect(response.status).toBe(400);

    const body = await response.json();

    expect(body.error.code).toBe(400);
    expect(body.error.message).toBe('Cannot delete keys in ACTIVE state.');
    expect(body.error.status).toBe('INVALID_ARGUMENT');
  });

  test('update with the current etag deactivates the key', async () => {
    const response = await fetch(
      emulatorUrl(`/storage/v1/projects/${project}/hmacKeys/${accessId}?userProject=billing`),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'storage#hmacKeyMetadata',
          accessId,
          projectId: project,
          serviceAccountEmail: email,
          state: 'INACTIVE',
          etag,
        }),
      }
    );

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.state).toBe('INACTIVE');
    expect(body.etag).not.toBe(etag);
    expect(body).not.toHaveProperty('secret');

    etag = body.etag;
  });

  test('delete of an INACTIVE key hides it from the default list', async () => {
    const deleted = await fetch(
      emulatorUrl(`/storage/v1/projects/${project}/hmacKeys/${accessId}`),
      { method: 'DELETE' }
    );

    expect(deleted.status).toBe(204);

    const listed = await fetch(emulatorUrl(`/storage/v1/projects/${project}/hmacKeys`));
    expect(listed.status).toBe(200);

    const listBody = await listed.json();
    expect(listBody.items ?? []).toHaveLength(0);

    const shown = await fetch(
      emulatorUrl(`/storage/v1/projects/${project}/hmacKeys?showDeletedKeys=true`)
    );
    expect(shown.status).toBe(200);

    const shownBody = await shown.json();
    expect(shownBody.items).toHaveLength(1);
    expect(shownBody.items[0].state).toBe('DELETED');
    expect(shownBody.items[0]).not.toHaveProperty('secret');

    const got = await fetch(emulatorUrl(`/storage/v1/projects/${project}/hmacKeys/${accessId}`));
    expect(got.status).toBe(200);

    const gotBody = await got.json();
    expect(gotBody.state).toBe('DELETED');
    expect(JSON.stringify(gotBody)).not.toContain(secret);
  });

  test('unknown access id is 404', async () => {
    const response = await fetch(
      emulatorUrl(`/storage/v1/projects/${project}/hmacKeys/GOOG1MISSING`)
    );

    expect(response.status).toBe(404);

    const body = await response.json();

    expect(body.error.status).toBe('NOT_FOUND');
  });
});
