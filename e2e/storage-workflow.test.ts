/**
 * End-to-End Test: Cloud Storage Workflow
 *
 * True black-box tests — validates the full lifecycle through HTTP only.
 * Two test paths:
 *   1. Raw HTTP fetch against the emulator
 *   2. Official @google-cloud/storage client library
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Storage } from '@google-cloud/storage';
import type { Server } from 'bun';
import { StorageManager } from '@/core/storage/manager.ts';
import { CloudStorageService } from '@/services/storage/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { buildRouter } from './e2e-helpers.ts';

// ── Test Infrastructure ──

let emulatorServer: Server;
let emulatorPort: number;
let cloudStorageService: CloudStorageService;

function emulatorUrl(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

// ── Setup / Teardown ──

beforeAll(async () => {
  emulatorPort = await getAvailablePort();

  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const logger = new Logger('e2e-storage', 'error');
  cloudStorageService = new CloudStorageService(storage, logger);
  await cloudStorageService.initialize();

  const routes = cloudStorageService.getRoutes();
  const router = buildRouter(routes);

  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: router,
  });
});

afterAll(async () => {
  await cloudStorageService.stop();
  emulatorServer.stop();
});

// ── Test Path 1: Raw HTTP Fetch ──

describe('Cloud Storage E2E: Raw HTTP API', () => {
  const project = 'test-project';
  const bucketName = 'e2e-bucket';

  test('1. Create a bucket', async () => {
    const response = await fetch(emulatorUrl(`/storage/v1/b?project=${project}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: bucketName }),
    });

    expect(response.status).toBe(200);

    const bucket = await response.json();

    expect(bucket.kind).toBe('storage#bucket');
    expect(bucket.name).toBe(bucketName);
    expect(bucket.id).toBeDefined();
    expect(bucket.timeCreated).toBeDefined();
  });

  test('2. Get the bucket', async () => {
    const response = await fetch(emulatorUrl(`/storage/v1/b/${bucketName}`));

    expect(response.status).toBe(200);

    const bucket = await response.json();

    expect(bucket.name).toBe(bucketName);
    expect(bucket.kind).toBe('storage#bucket');
  });

  test('3. List buckets', async () => {
    const response = await fetch(emulatorUrl(`/storage/v1/b?project=${project}`));

    expect(response.status).toBe(200);

    const result = await response.json();

    expect(result.kind).toBe('storage#buckets');
    expect(result.items.length).toBeGreaterThanOrEqual(1);

    const found = result.items.find((b: Record<string, unknown>) => b.name === bucketName);

    expect(found).toBeDefined();
  });

  test('4. Upload an object', async () => {
    const response = await fetch(
      emulatorUrl(`/upload/storage/v1/b/${bucketName}/o?uploadType=media&name=test.txt`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'Hello GCS',
      }
    );

    expect(response.status).toBe(200);

    const obj = await response.json();

    expect(obj.kind).toBe('storage#object');
    expect(obj.name).toBe('test.txt');
    expect(obj.bucket).toBe(bucketName);
    expect(obj.size).toBe('9');
  });

  test('5. Get object metadata', async () => {
    const response = await fetch(emulatorUrl(`/storage/v1/b/${bucketName}/o/test.txt`));

    expect(response.status).toBe(200);

    const obj = await response.json();

    expect(obj.kind).toBe('storage#object');
    expect(obj.name).toBe('test.txt');
    expect(obj.contentType).toBe('text/plain');
  });

  test('6. Download object with alt=media', async () => {
    const response = await fetch(emulatorUrl(`/storage/v1/b/${bucketName}/o/test.txt?alt=media`));

    expect(response.status).toBe(200);

    const text = await response.text();

    expect(text).toBe('Hello GCS');
  });

  test('7. List objects', async () => {
    const response = await fetch(emulatorUrl(`/storage/v1/b/${bucketName}/o`));

    expect(response.status).toBe(200);

    const result = await response.json();

    expect(result.kind).toBe('storage#objects');
    expect(result.items.length).toBeGreaterThanOrEqual(1);
  });

  test('8. Upload nested object with folder prefix', async () => {
    const response = await fetch(
      emulatorUrl(
        `/upload/storage/v1/b/${bucketName}/o?uploadType=media&name=${encodeURIComponent('folder/nested.txt')}`
      ),
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'Nested content',
      }
    );

    expect(response.status).toBe(200);

    const obj = await response.json();

    expect(obj.name).toBe('folder/nested.txt');
  });

  test('9. List objects with prefix and delimiter', async () => {
    const response = await fetch(
      emulatorUrl(`/storage/v1/b/${bucketName}/o?prefix=folder/&delimiter=/`)
    );

    expect(response.status).toBe(200);

    const result = await response.json();

    expect(result.prefixes).toBeUndefined();
    expect(result.items.length).toBeGreaterThanOrEqual(1);

    const nested = result.items.find(
      (o: Record<string, unknown>) => o.name === 'folder/nested.txt'
    );

    expect(nested).toBeDefined();
  });

  test('10. Copy object', async () => {
    const response = await fetch(
      emulatorUrl(`/storage/v1/b/${bucketName}/o/test.txt/copyTo/b/${bucketName}/o/copy.txt`),
      { method: 'POST' }
    );

    expect(response.status).toBe(200);

    const obj = await response.json();

    expect(obj.name).toBe('copy.txt');
    expect(obj.bucket).toBe(bucketName);
  });

  test('11. Verify copied object data integrity', async () => {
    const response = await fetch(emulatorUrl(`/storage/v1/b/${bucketName}/o/copy.txt?alt=media`));

    expect(response.status).toBe(200);

    const text = await response.text();

    expect(text).toBe('Hello GCS');
  });

  test('12. Compose objects', async () => {
    const response = await fetch(
      emulatorUrl(`/storage/v1/b/${bucketName}/o/composed.txt/compose`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceObjects: [{ name: 'test.txt' }, { name: 'copy.txt' }],
        }),
      }
    );

    expect(response.status).toBe(200);

    const obj = await response.json();

    expect(obj.name).toBe('composed.txt');
  });

  test('13. Verify composed object data', async () => {
    const response = await fetch(
      emulatorUrl(`/storage/v1/b/${bucketName}/o/composed.txt?alt=media`)
    );

    expect(response.status).toBe(200);

    const text = await response.text();

    expect(text).toBe('Hello GCSHello GCS');
  });

  test('14. Rewrite object', async () => {
    const response = await fetch(
      emulatorUrl(
        `/storage/v1/b/${bucketName}/o/test.txt/rewriteTo/b/${bucketName}/o/rewritten.txt`
      ),
      { method: 'POST' }
    );

    expect(response.status).toBe(200);

    const result = await response.json();

    expect(result.kind).toBe('storage#rewriteResponse');
    expect(result.done).toBe(true);
    expect(result.resource.name).toBe('rewritten.txt');
  });

  test('15. Patch object metadata', async () => {
    const response = await fetch(emulatorUrl(`/storage/v1/b/${bucketName}/o/test.txt`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: { key: 'val' } }),
    });

    expect(response.status).toBe(200);

    const obj = await response.json();

    expect(obj.metadata.key).toBe('val');
  });

  test('16. Patch bucket metadata (labels)', async () => {
    const response = await fetch(emulatorUrl(`/storage/v1/b/${bucketName}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: { env: 'test', team: 'platform' } }),
    });

    expect(response.status).toBe(200);

    const bucket = await response.json();

    expect(bucket.labels.env).toBe('test');
    expect(bucket.labels.team).toBe('platform');
  });

  test('17. Update bucket (full replacement)', async () => {
    const response = await fetch(emulatorUrl(`/storage/v1/b/${bucketName}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: bucketName,
        storageClass: 'NEARLINE',
        labels: { env: 'staging' },
      }),
    });

    expect(response.status).toBe(200);

    const bucket = await response.json();

    expect(bucket.name).toBe(bucketName);
    expect(bucket.storageClass).toBe('NEARLINE');
    expect(bucket.labels.env).toBe('staging');
  });

  test('18. Resumable upload flow', async () => {
    // Step 1: Initiate resumable upload
    const initResponse = await fetch(
      emulatorUrl(`/upload/storage/v1/b/${bucketName}/o?uploadType=resumable&name=resumable.txt`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'resumable.txt', contentType: 'text/plain' }),
      }
    );

    expect(initResponse.status).toBe(200);

    const location = initResponse.headers.get('location');

    expect(location).toBeTruthy();

    // Step 2: Upload data to the resumable URL
    const uploadResponse = await fetch(location ?? '', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'Resumable upload content',
    });

    expect(uploadResponse.status).toBe(200);

    const obj = await uploadResponse.json();

    expect(obj.name).toBe('resumable.txt');
    expect(obj.bucket).toBe(bucketName);

    // Step 3: Verify data can be downloaded
    const downloadResponse = await fetch(
      emulatorUrl(`/storage/v1/b/${bucketName}/o/resumable.txt?alt=media`)
    );

    expect(downloadResponse.status).toBe(200);

    const text = await downloadResponse.text();

    expect(text).toBe('Resumable upload content');
  });

  test('19. Update object metadata (PUT full replacement)', async () => {
    const response = await fetch(emulatorUrl(`/storage/v1/b/${bucketName}/o/test.txt`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: { replaced: 'true' }, contentType: 'text/html' }),
    });

    expect(response.status).toBe(200);

    const obj = await response.json();

    expect(obj.metadata.replaced).toBe('true');
  });

  test('20. Cross-bucket copy', async () => {
    const crossBucket = 'e2e-cross-bucket';

    // Create destination bucket
    await fetch(emulatorUrl(`/storage/v1/b?project=${project}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: crossBucket }),
    });

    // Copy object across buckets
    const response = await fetch(
      emulatorUrl(
        `/storage/v1/b/${bucketName}/o/test.txt/copyTo/b/${crossBucket}/o/cross-copy.txt`
      ),
      { method: 'POST' }
    );

    expect(response.status).toBe(200);

    const obj = await response.json();

    expect(obj.name).toBe('cross-copy.txt');
    expect(obj.bucket).toBe(crossBucket);

    // Verify data integrity in destination
    const downloadResponse = await fetch(
      emulatorUrl(`/storage/v1/b/${crossBucket}/o/cross-copy.txt?alt=media`)
    );
    const text = await downloadResponse.text();

    expect(text).toBe('Hello GCS');

    // Clean up
    await fetch(emulatorUrl(`/storage/v1/b/${crossBucket}/o/cross-copy.txt`), {
      method: 'DELETE',
    });
    await fetch(emulatorUrl(`/storage/v1/b/${crossBucket}`), { method: 'DELETE' });
  });

  test('21. Cross-bucket rewrite', async () => {
    const rewriteBucket = 'e2e-rewrite-bucket';

    // Create destination bucket
    await fetch(emulatorUrl(`/storage/v1/b?project=${project}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: rewriteBucket }),
    });

    // Rewrite object across buckets
    const response = await fetch(
      emulatorUrl(
        `/storage/v1/b/${bucketName}/o/test.txt/rewriteTo/b/${rewriteBucket}/o/rewritten-cross.txt`
      ),
      { method: 'POST' }
    );

    expect(response.status).toBe(200);

    const result = await response.json();

    expect(result.kind).toBe('storage#rewriteResponse');
    expect(result.done).toBe(true);
    expect(result.resource.name).toBe('rewritten-cross.txt');
    expect(result.resource.bucket).toBe(rewriteBucket);

    // Verify data integrity
    const downloadResponse = await fetch(
      emulatorUrl(`/storage/v1/b/${rewriteBucket}/o/rewritten-cross.txt?alt=media`)
    );
    const text = await downloadResponse.text();

    expect(text).toBe('Hello GCS');

    // Clean up
    await fetch(emulatorUrl(`/storage/v1/b/${rewriteBucket}/o/rewritten-cross.txt`), {
      method: 'DELETE',
    });
    await fetch(emulatorUrl(`/storage/v1/b/${rewriteBucket}`), { method: 'DELETE' });
  });

  test('22. Delete object', async () => {
    const response = await fetch(emulatorUrl(`/storage/v1/b/${bucketName}/o/test.txt`), {
      method: 'DELETE',
    });

    expect(response.status).toBe(204);
  });

  test('23. Verify deleted object returns 404', async () => {
    const response = await fetch(emulatorUrl(`/storage/v1/b/${bucketName}/o/test.txt`));

    expect(response.status).toBe(404);
  });

  test('24. Delete bucket after cleaning up objects', async () => {
    // Clean up remaining objects first
    const listRes = await fetch(emulatorUrl(`/storage/v1/b/${bucketName}/o`));
    const listResult = await listRes.json();

    if (listResult.items) {
      for (const item of listResult.items) {
        await fetch(emulatorUrl(`/storage/v1/b/${bucketName}/o/${encodeURIComponent(item.name)}`), {
          method: 'DELETE',
        });
      }
    }

    const response = await fetch(emulatorUrl(`/storage/v1/b/${bucketName}`), {
      method: 'DELETE',
    });

    expect(response.status).toBe(204);
  });

  test('25. Verify deleted bucket returns 404', async () => {
    const response = await fetch(emulatorUrl(`/storage/v1/b/${bucketName}`));

    expect(response.status).toBe(404);
  });
});

// ── Test Path 2: Raw HTTP Error Cases ──

describe('Cloud Storage E2E: Error Cases', () => {
  const project = 'error-test-project';

  test('GET non-existent bucket returns 404', async () => {
    const response = await fetch(emulatorUrl('/storage/v1/b/no-such-bucket'));

    expect(response.status).toBe(404);
  });

  test('Create duplicate bucket returns 409', async () => {
    const bucketName = 'duplicate-test-bucket';

    const first = await fetch(emulatorUrl(`/storage/v1/b?project=${project}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: bucketName }),
    });

    expect(first.status).toBe(200);

    const second = await fetch(emulatorUrl(`/storage/v1/b?project=${project}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: bucketName }),
    });

    expect(second.status).toBe(409);

    // Clean up
    await fetch(emulatorUrl(`/storage/v1/b/${bucketName}`), { method: 'DELETE' });
  });

  test('Upload to non-existent bucket returns 404', async () => {
    const response = await fetch(
      emulatorUrl('/upload/storage/v1/b/no-such-bucket/o?uploadType=media&name=file.txt'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'data',
      }
    );

    expect(response.status).toBe(404);
  });

  test('Delete non-existent object returns 404', async () => {
    const bucketName = 'error-obj-bucket';

    await fetch(emulatorUrl(`/storage/v1/b?project=${project}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: bucketName }),
    });

    const response = await fetch(emulatorUrl(`/storage/v1/b/${bucketName}/o/nonexistent.txt`), {
      method: 'DELETE',
    });

    expect(response.status).toBe(404);

    // Clean up
    await fetch(emulatorUrl(`/storage/v1/b/${bucketName}`), { method: 'DELETE' });
  });
});

// ── Test Path 3: @google-cloud/storage Client Library ──

describe('Cloud Storage E2E: Client Library', () => {
  const project = 'client-lib-project';
  const bucketName = 'client-lib-bucket';

  let storageClient: InstanceType<typeof Storage>;

  beforeAll(() => {
    storageClient = new Storage({
      projectId: project,
      apiEndpoint: `http://localhost:${emulatorPort}`,
    });
  });

  test('1. Create a bucket via client library', async () => {
    const [bucket] = await storageClient.createBucket(bucketName);

    expect(bucket.name).toBe(bucketName);
  });

  test('2. Upload a file via client library', async () => {
    const bucket = storageClient.bucket(bucketName);
    const file = bucket.file('client-test.txt');

    await file.save('Hello from client library', {
      contentType: 'text/plain',
    });

    const [metadata] = await file.getMetadata();

    expect(metadata.name).toBe('client-test.txt');
  });

  test('3. Download file and verify data', async () => {
    const bucket = storageClient.bucket(bucketName);
    const file = bucket.file('client-test.txt');

    const [contents] = await file.download();

    expect(contents.toString()).toBe('Hello from client library');
  });

  test('4. List files in bucket', async () => {
    const bucket = storageClient.bucket(bucketName);
    const [files] = await bucket.getFiles();

    expect(files.length).toBeGreaterThanOrEqual(1);

    const found = files.find(f => f.name === 'client-test.txt');

    expect(found).toBeDefined();
  });

  test('5. Get bucket metadata', async () => {
    const bucket = storageClient.bucket(bucketName);
    const [metadata] = await bucket.getMetadata();

    expect(metadata.name).toBe(bucketName);
    expect(metadata.kind).toBe('storage#bucket');
  });

  test('6. Copy a file', async () => {
    const bucket = storageClient.bucket(bucketName);
    const srcFile = bucket.file('client-test.txt');
    const dstFile = bucket.file('client-copy.txt');

    await srcFile.copy(dstFile);

    const [contents] = await dstFile.download();

    expect(contents.toString()).toBe('Hello from client library');
  });

  test('7. Set and get custom object metadata', async () => {
    const bucket = storageClient.bucket(bucketName);
    const file = bucket.file('client-test.txt');

    await file.setMetadata({ metadata: { customKey: 'customValue', env: 'test' } });

    const [metadata] = await file.getMetadata();

    expect(metadata.metadata?.customKey).toBe('customValue');
    expect(metadata.metadata?.env).toBe('test');
  });

  test('8. Move/rename a file', async () => {
    const bucket = storageClient.bucket(bucketName);
    const srcFile = bucket.file('client-copy.txt');

    await srcFile.move('client-moved.txt');

    const [movedExists] = await bucket.file('client-moved.txt').exists();

    expect(movedExists).toBe(true);

    const [srcExists] = await srcFile.exists();

    expect(srcExists).toBe(false);
  });

  test('9. Check file existence', async () => {
    const bucket = storageClient.bucket(bucketName);

    const [existingExists] = await bucket.file('client-test.txt').exists();

    expect(existingExists).toBe(true);

    const [nonExistentExists] = await bucket.file('no-such-file.txt').exists();

    expect(nonExistentExists).toBe(false);
  });

  test('10. Delete files', async () => {
    const bucket = storageClient.bucket(bucketName);

    await bucket.file('client-test.txt').delete();
    await bucket.file('client-moved.txt').delete();

    const [files] = await bucket.getFiles();
    const remaining = files.filter(
      f =>
        f.name === 'client-test.txt' ||
        f.name === 'client-copy.txt' ||
        f.name === 'client-moved.txt'
    );

    expect(remaining.length).toBe(0);
  });

  test('11. Delete bucket', async () => {
    const bucket = storageClient.bucket(bucketName);
    await bucket.delete();

    const getBucket = async () => {
      const [metadata] = await storageClient.bucket(bucketName).getMetadata();
      return metadata;
    };

    await expect(getBucket()).rejects.toThrow();
  });
});
