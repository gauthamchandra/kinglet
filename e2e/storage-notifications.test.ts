/**
 * Cloud Storage notificationConfigs over the production router.
 *
 * Insert, get, list, and delete. No events are published.
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

function url(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

async function createBucket(name: string): Promise<void> {
  const response = await fetch(url(`/storage/v1/b?project=notify-project`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });

  expect(response.status).toBe(200);
}

beforeAll(async () => {
  emulatorPort = await getAvailablePort();

  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const logger = new Logger('e2e-storage-notifications', 'error');
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

describe('Cloud Storage notificationConfigs', () => {
  test('insert rewrites a bare topic, then get, list, and delete', async () => {
    await createBucket('notify-http');

    const inserted = await fetch(url('/storage/v1/b/notify-http/notificationConfigs'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: 'projects/my-project/topics/object-events',
        payload_format: 'JSON_API_V1',
        event_types: ['OBJECT_FINALIZE'],
        object_name_prefix: 'photos/',
        custom_attributes: { origin: 'kinglet' },
      }),
    });

    expect(inserted.status).toBe(200);

    const created = (await inserted.json()) as {
      kind: string;
      id: string;
      topic: string;
      payload_format: string;
      event_types: string[];
      object_name_prefix: string;
      custom_attributes: Record<string, string>;
      selfLink: string;
    };

    expect(created.kind).toBe('storage#notification');
    expect(created.topic).toBe('//pubsub.googleapis.com/projects/my-project/topics/object-events');
    expect(created.payload_format).toBe('JSON_API_V1');
    expect(created.event_types).toEqual(['OBJECT_FINALIZE']);
    expect(created.object_name_prefix).toBe('photos/');
    expect(created.custom_attributes).toEqual({ origin: 'kinglet' });
    expect(created.selfLink).toBe(
      `https://www.googleapis.com/storage/v1/b/notify-http/notificationConfigs/${created.id}`
    );

    const fetched = await fetch(url(`/storage/v1/b/notify-http/notificationConfigs/${created.id}`));

    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(created);

    const listed = await fetch(url('/storage/v1/b/notify-http/notificationConfigs'));

    expect(listed.status).toBe(200);

    const listBody = (await listed.json()) as { kind: string; items: Array<{ id: string }> };

    expect(listBody.kind).toBe('storage#notifications');
    expect(listBody.items.map(item => item.id)).toEqual([created.id]);

    const deleted = await fetch(
      url(`/storage/v1/b/notify-http/notificationConfigs/${created.id}`),
      { method: 'DELETE' }
    );

    expect(deleted.status).toBe(204);

    const afterDelete = await fetch(
      url(`/storage/v1/b/notify-http/notificationConfigs/${created.id}`)
    );

    expect(afterDelete.status).toBe(404);

    const missingBody = (await afterDelete.json()) as { error: { code: number; status: string } };

    expect(missingBody.error.code).toBe(404);
    expect(missingBody.error.status).toBe('NOT_FOUND');
  });

  test('insert keeps a topic that already has the pubsub prefix', async () => {
    await createBucket('notify-canonical');

    const topic = '//pubsub.googleapis.com/projects/my-project/topics/already-set';
    const response = await fetch(url('/storage/v1/b/notify-canonical/notificationConfigs'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic, payload_format: 'NONE' }),
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { topic: string; payload_format: string }).topic).toBe(
      topic
    );
  });

  test('insert accepts the snake_case body createNotification sends', async () => {
    await createBucket('notify-client');

    const response = await fetch(url('/storage/v1/b/notify-client/notificationConfigs'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: '//pubsub.googleapis.com/projects/my-project/topics/from-node',
        payload_format: 'JSON_API_V1',
        event_types: ['OBJECT_FINALIZE'],
        object_name_prefix: 'logs/',
        custom_attributes: { origin: 'node' },
      }),
    });

    expect(response.status).toBe(200);

    const created = (await response.json()) as {
      topic: string;
      payload_format: string;
      event_types: string[];
      object_name_prefix: string;
      custom_attributes: Record<string, string>;
    };

    expect(created.topic).toBe('//pubsub.googleapis.com/projects/my-project/topics/from-node');
    expect(created.payload_format).toBe('JSON_API_V1');
    expect(created.event_types).toEqual(['OBJECT_FINALIZE']);
    expect(created.object_name_prefix).toBe('logs/');
    expect(created.custom_attributes).toEqual({ origin: 'node' });
  });

  test('unknown notification id is 404', async () => {
    await createBucket('notify-missing-id');

    const response = await fetch(
      url('/storage/v1/b/notify-missing-id/notificationConfigs/does-not-exist')
    );

    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: { code: number; status: string } };

    expect(body.error.code).toBe(404);
    expect(body.error.status).toBe('NOT_FOUND');
  });

  test('custom attribute keys that collide with built-in names are 400', async () => {
    await createBucket('notify-collision');

    const response = await fetch(url('/storage/v1/b/notify-collision/notificationConfigs'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: 'projects/my-project/topics/object-events',
        payload_format: 'JSON_API_V1',
        custom_attributes: { eventType: 'nope' },
      }),
    });

    expect(response.status).toBe(400);

    const body = (await response.json()) as {
      error: { code: number; message: string; status: string };
    };

    expect(body.error.code).toBe(400);
    expect(body.error.status).toBe('INVALID_ARGUMENT');
    expect(body.error.message).toContain('eventType');

    const listed = await fetch(url('/storage/v1/b/notify-collision/notificationConfigs'));

    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { items: unknown[] }).items).toEqual([]);
  });

  test('insert on a missing bucket is 404', async () => {
    const response = await fetch(url('/storage/v1/b/no-such-bucket/notificationConfigs'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: 'projects/my-project/topics/object-events',
        payload_format: 'JSON_API_V1',
      }),
    });

    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: { status: string } };

    expect(body.error.status).toBe('NOT_FOUND');
  });
});
