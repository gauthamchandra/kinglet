/**
 * Binary request and response bodies through the production router.
 *
 * ADR-020: path and query are matched before the body is read, and a
 * Uint8Array response is not JSON-encoded.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { StorageManager } from '@/core/storage/manager.ts';
import { CloudStorageService } from '@/services/storage/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { buildProductionRouter } from './e2e-helpers.ts';

let emulatorServer: Server;
let emulatorPort: number;
let cloudStorageService: CloudStorageService;

const bucketName = 'binary-bucket';
const mediaBytes = new Uint8Array([0xff, 0x00, 0x41, 0x42]);

function emulatorUrl(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

function md5Base64(data: Uint8Array): string {
  return new Bun.CryptoHasher('md5').update(data).digest('base64');
}

beforeAll(async () => {
  emulatorPort = await getAvailablePort();

  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const logger = new Logger('e2e-storage-binary', 'error');
  cloudStorageService = new CloudStorageService(storage, logger);
  await cloudStorageService.initialize();

  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: buildProductionRouter(cloudStorageService.getRoutes()),
  });

  const created = await fetch(emulatorUrl(`/storage/v1/b?project=binary-project`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: bucketName }),
  });

  expect(created.status).toBe(200);
});

afterAll(async () => {
  await cloudStorageService.stop();
  emulatorServer.stop();
});

describe('Cloud Storage binary bodies', () => {
  test('raw media bytes round-trip', async () => {
    const expectedMd5 = md5Base64(mediaBytes);

    const octet = await fetch(
      emulatorUrl(`/upload/storage/v1/b/${bucketName}/o?uploadType=media&name=bytes.bin`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: mediaBytes,
      }
    );

    expect(octet.status).toBe(200);

    const octetObject = await octet.json();

    expect(octetObject.md5Hash).toBe(expectedMd5);

    const octetMedia = await fetch(
      emulatorUrl(`/storage/v1/b/${bucketName}/o/bytes.bin?alt=media`)
    );

    expect(octetMedia.status).toBe(200);
    expect(new Uint8Array(await octetMedia.arrayBuffer())).toEqual(mediaBytes);

    const jsonTyped = await fetch(
      emulatorUrl(`/upload/storage/v1/b/${bucketName}/o?uploadType=media&name=bytes.json`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: mediaBytes,
      }
    );

    expect(jsonTyped.status).toBe(200);

    const jsonObject = await jsonTyped.json();

    expect(jsonObject.md5Hash).toBe(expectedMd5);

    const jsonMedia = await fetch(
      emulatorUrl(`/storage/v1/b/${bucketName}/o/bytes.json?alt=media`)
    );

    expect(jsonMedia.status).toBe(200);
    expect(new Uint8Array(await jsonMedia.arrayBuffer())).toEqual(mediaBytes);
  });

  test('resumable JSON initiation then raw PUT', async () => {
    const chunk = new Uint8Array([0xde, 0xad, 0x00, 0xff]);

    const init = await fetch(
      emulatorUrl(`/upload/storage/v1/b/${bucketName}/o?uploadType=resumable`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'obj', contentType: 'text/plain' }),
      }
    );

    expect(init.status).toBe(200);

    const location = init.headers.get('location');

    expect(location).toBeTypeOf('string');
    expect((location ?? '').length).toBeGreaterThan(0);

    // application/json would be parsed and discarded if this PUT were not raw bytes.
    const uploaded = await fetch(location ?? '', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: chunk,
    });

    expect(uploaded.status).toBe(200);

    const metadata = await fetch(emulatorUrl(`/storage/v1/b/${bucketName}/o/obj`));

    expect(metadata.status).toBe(200);

    const object = await metadata.json();

    expect(object.name).toBe('obj');
    expect(object.contentType).toBe('text/plain');

    const media = await fetch(emulatorUrl(`/storage/v1/b/${bucketName}/o/obj?alt=media`));

    expect(media.status).toBe(200);
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(chunk);
  });
});
