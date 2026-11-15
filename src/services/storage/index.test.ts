import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { createMockLogger } from '../../../test-utils/mock-logger.ts';
import { CloudStorageService } from './index.ts';
import { ObjectRepository } from './object-repository.ts';

describe('CloudStorageService', () => {
  let storage: StorageManager;
  let service: CloudStorageService;
  let blobRoot: string;

  beforeEach(async () => {
    blobRoot = await mkdtemp(join(tmpdir(), 'kinglet-storage-svc-'));
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    service = new CloudStorageService(storage, createMockLogger(), {
      blobPath: blobRoot,
      storageType: 'memory',
    });
  });

  afterEach(async () => {
    await service.stop('memory');
    rmSync(blobRoot, { recursive: true, force: true });
  });

  test('initialize creates tables and wires components', async () => {
    await expect(service.initialize()).resolves.toBeUndefined();
  });

  test('getRoutes returns non-empty array after initialize', async () => {
    await service.initialize();
    const routes = service.getRoutes();

    expect(routes.length).toBeGreaterThan(0);
  });

  test('getRoutes throws before initialize', () => {
    expect(() => service.getRoutes()).toThrow('not initialized');
  });

  test('getRoutes returns bucket, object, and hmac routes with unique IDs', async () => {
    await service.initialize();
    const routes = service.getRoutes();

    const ids = routes.map(r => r.id);
    expect(ids).toContain('storage.buckets.insert');
    expect(ids).toContain('storage.objects.insert');
    expect(ids).toContain('storage.buckets.getIamPolicy');
    expect(ids).toContain('storage.buckets.setIamPolicy');
    expect(ids).toContain('storage.buckets.testIamPermissions');
    expect(ids).toContain('storage.notifications.insert');
    expect(ids).toContain('storage.notifications.get');
    expect(ids).toContain('storage.notifications.list');
    expect(ids).toContain('storage.notifications.delete');
    expect(ids).toContain('storage.projects.hmacKeys.create');
    expect(ids).toContain('storage.projects.hmacKeys.get');
    expect(ids).toContain('storage.projects.hmacKeys.list');
    expect(ids).toContain('storage.projects.hmacKeys.update');
    expect(ids).toContain('storage.projects.hmacKeys.delete');
    expect(ids).toContain('storage.objects.getIamPolicy');
    expect(ids).toContain('storage.objects.setIamPolicy');
    expect(ids).toContain('storage.objects.testIamPermissions');

    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  test('start and stop do not error', async () => {
    await service.initialize();
    service.start();
    await expect(service.stop('memory')).resolves.toBeUndefined();
  });
});

function routeRequest(overrides: Partial<RouteRequest>): RouteRequest {
  return {
    method: 'GET',
    path: '/',
    query: {},
    headers: {},
    params: {},
    body: undefined,
    originalRequest: new Request('http://localhost/'),
    ...overrides,
  };
}

async function callRoute(
  service: CloudStorageService,
  id: string,
  overrides: Partial<RouteRequest>
): Promise<RouteResponse> {
  const route: RouteDefinition | undefined = service.getRoutes().find(item => item.id === id);

  if (!route) {
    throw new Error(`missing route ${id}`);
  }

  return route.handler(routeRequest(overrides), {
    routeId: id,
    startTime: Date.now(),
    metadata: {},
    logger: createMockLogger(),
  });
}

async function insertObject(service: CloudStorageService, payload: Uint8Array): Promise<void> {
  const bucket = await callRoute(service, 'storage.buckets.insert', {
    method: 'POST',
    query: { project: 'proj-1' },
    body: { name: 'blob-bucket' },
  });

  expect(bucket.status).toBe(200);

  const object = await callRoute(service, 'storage.objects.insert', {
    method: 'POST',
    query: { name: 'hello.txt' },
    headers: { 'content-type': 'text/plain' },
    params: { bucket: 'blob-bucket' },
    body: payload,
  });

  expect(object.status).toBe(200);
}

async function readBlobInNewProcess(blobPath: string): Promise<Uint8Array> {
  const proc = Bun.spawn(
    [
      'bun',
      '-e',
      'const path = process.env.KINGLET_BLOB ?? ""; const bytes = new Uint8Array(await Bun.file(path).arrayBuffer()); await Bun.write(Bun.stdout, bytes);',
    ],
    {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? '', KINGLET_BLOB: blobPath },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );

  const stdout = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  const code = await proc.exited;

  expect(code).toBe(0);

  return stdout;
}

describe('CloudStorageService blob directory', () => {
  test('memory stop deletes only blob files this process stored', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kinglet-blob-mem-'));
    const blobRoot = join(parent, 'blobs');
    const preexisting = join(blobRoot, 'already-there.txt');

    mkdirSync(blobRoot);
    await Bun.write(preexisting, 'keep');

    const storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    const service = new CloudStorageService(storage, createMockLogger(), {
      blobPath: blobRoot,
      storageType: 'memory',
    });

    try {
      await service.initialize();
      await insertObject(service, new TextEncoder().encode('ephemeral'));

      const record = await new ObjectRepository(storage).getObject('blob-bucket', 'hello.txt');
      const blobPath = record?.blobPath ?? '';

      expect(existsSync(blobPath)).toBe(true);
      expect(blobPath).not.toBe(preexisting);

      await service.stop('memory');

      expect(existsSync(blobPath)).toBe(false);
      expect(existsSync(preexisting)).toBe(true);
      expect(existsSync(blobRoot)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      await storage.close();
    }
  });

  test('memory stop leaves a file whose blob was deleted before shutdown', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kinglet-blob-del-'));
    const blobRoot = join(parent, 'blobs');
    const storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    const service = new CloudStorageService(storage, createMockLogger(), {
      blobPath: blobRoot,
      storageType: 'memory',
    });

    try {
      await service.initialize();
      await insertObject(service, new TextEncoder().encode('ephemeral'));

      const record = await new ObjectRepository(storage).getObject('blob-bucket', 'hello.txt');
      const blobPath = record?.blobPath ?? '';

      expect(existsSync(blobPath)).toBe(true);

      const deleted = await callRoute(service, 'storage.objects.delete', {
        method: 'DELETE',
        params: { bucket: 'blob-bucket', object: 'hello.txt' },
      });

      expect(deleted.status).toBe(204);

      await Bun.write(blobPath, 'recreated');
      await service.stop('memory');

      expect(existsSync(blobPath)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      await storage.close();
    }
  });

  test('sqlite does not track blob paths, so a memory cleanup removes nothing', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kinglet-blob-untracked-'));
    const blobRoot = join(parent, 'blobs');
    const storage = new StorageManager();
    await storage.initialize({ type: 'sqlite', database: { path: join(parent, 'emulator.db') } });
    const service = new CloudStorageService(storage, createMockLogger(), {
      blobPath: blobRoot,
      storageType: 'sqlite',
    });

    try {
      await service.initialize();
      await insertObject(service, new TextEncoder().encode('durable'));

      const record = await new ObjectRepository(storage).getObject('blob-bucket', 'hello.txt');
      const blobPath = record?.blobPath ?? '';

      expect(existsSync(blobPath)).toBe(true);

      await service.stop('memory');

      expect(existsSync(blobPath)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      await storage.close();
    }
  });

  test('rejected blob paths do not delete the working directory', async () => {
    const marker = join(process.cwd(), 'package.json');

    expect(existsSync(marker)).toBe(true);

    const rejected = ['', '.', '..', process.cwd(), '/', resolve(process.cwd(), '..')];

    for (const blobPath of rejected) {
      const storage = new StorageManager();
      await storage.initialize({ type: 'memory' });
      const service = new CloudStorageService(storage, createMockLogger(), {
        blobPath,
        storageType: 'memory',
      });

      await expect(service.initialize()).rejects.toThrow(/BLOB_PATH/);
      await service.stop('memory');
      await storage.close();

      expect(existsSync(process.cwd())).toBe(true);
      expect(existsSync(marker)).toBe(true);
    }
  });

  test('stores an absolute blobPath when the configured root is relative', async () => {
    const relative = `blob-f1-${crypto.randomUUID()}`;
    const resolved = resolve(process.cwd(), relative);
    const storage = new StorageManager();

    await storage.initialize({ type: 'memory' });

    const service = new CloudStorageService(storage, createMockLogger(), {
      blobPath: relative,
      storageType: 'memory',
    });
    const payload = new TextEncoder().encode('relative-root');

    try {
      await service.initialize();
      await insertObject(service, payload);

      const record = await new ObjectRepository(storage).getObject('blob-bucket', 'hello.txt');
      const blobPath = record?.blobPath ?? '';

      expect(isAbsolute(blobPath)).toBe(true);
      expect(blobPath.startsWith(resolved)).toBe(true);
    } finally {
      await service.stop('memory');
      rmSync(resolved, { recursive: true, force: true });
      await storage.close();
    }
  });

  test('sqlite stop leaves the files and a new process reads the stored blobPath', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kinglet-blob-sqlite-'));
    const blobRoot = join(parent, 'blobs');
    const sibling = join(parent, 'sibling');
    const dbPath = join(parent, 'emulator.db');
    const payload = new TextEncoder().encode('persist-me');

    mkdirSync(sibling);
    await Bun.write(join(sibling, 'keep.txt'), 'keep');

    const storage = new StorageManager();
    await storage.initialize({ type: 'sqlite', database: { path: dbPath } });

    const service = new CloudStorageService(storage, createMockLogger(), {
      blobPath: blobRoot,
      storageType: 'sqlite',
    });

    try {
      await service.initialize();
      await insertObject(service, payload);

      const record = await new ObjectRepository(storage).getObject('blob-bucket', 'hello.txt');
      const blobPath = record?.blobPath ?? '';

      expect(isAbsolute(blobPath)).toBe(true);
      expect(blobPath.startsWith(blobRoot)).toBe(true);
      expect(existsSync(blobPath)).toBe(true);

      await service.stop('sqlite');

      expect(existsSync(blobPath)).toBe(true);
      expect(existsSync(blobRoot)).toBe(true);
      expect(existsSync(join(sibling, 'keep.txt'))).toBe(true);

      const reread = await readBlobInNewProcess(blobPath);

      expect(reread).toEqual(payload);

      await storage.close();

      const restarted = new StorageManager();
      await restarted.initialize({ type: 'sqlite', database: { path: dbPath } });

      const next = new CloudStorageService(restarted, createMockLogger(), {
        blobPath: blobRoot,
        storageType: 'sqlite',
      });

      try {
        await next.initialize();

        const media = await callRoute(next, 'storage.objects.get', {
          params: { bucket: 'blob-bucket', object: 'hello.txt' },
          query: { alt: 'media' },
        });

        expect(media.status).toBe(200);
        expect(media.body).toEqual(payload);
      } finally {
        await next.stop('sqlite');
        await restarted.close();
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
      await storage.close();
    }
  });
});
