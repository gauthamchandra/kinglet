/**
 * End-to-End Test: Memorystore for Valkey Data Plane
 *
 * With the data plane enabled, creating an Instance spawns a real
 * `valkey-server` process. This suite asserts application code can actually
 * connect to it with Bun's built-in Bun.RedisClient — the entire point of
 * emulating a data plane rather than metadata only. Skips cleanly on
 * machines without the real binary installed; in CI a missing binary is a
 * hard error instead (see test-utils/valkey.ts).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { StorageManager } from '@/core/storage/manager.ts';
import { MemorystoreService } from '@/services/memorystore/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { isRealValkeyBinaryAvailable } from '../test-utils/valkey.ts';
import { buildRouter } from './e2e-helpers.ts';

describe.skipIf(!isRealValkeyBinaryAvailable)('Memorystore E2E: Data Plane', () => {
  let emulatorServer: Server;
  let emulatorPort: number;
  let memorystoreService: MemorystoreService;

  const project = 'test-project';
  const location = 'us-central1';
  const instanceId = 'e2e-data-plane-instance';
  const instancePath = `/v1/projects/${project}/locations/${location}/instances/${instanceId}`;

  function emulatorUrl(path: string): string {
    return `http://localhost:${emulatorPort}${path}`;
  }

  beforeAll(async () => {
    emulatorPort = await getAvailablePort();

    const storage = new StorageManager();
    await storage.initialize({ type: 'memory' });

    const logger = new Logger('e2e-memorystore-data-plane', 'error');
    memorystoreService = new MemorystoreService(storage, logger, {
      enabled: true,
      portRangeStart: 19000,
      portRangeEnd: 19010,
    });
    await memorystoreService.initialize();

    const router = buildRouter(memorystoreService.getRoutes());

    emulatorServer = Bun.serve({ port: emulatorPort, fetch: router });
  });

  afterAll(async () => {
    await memorystoreService.stop();
    emulatorServer.stop();
  });

  test('creating an instance spawns a real valkey-server reachable via Bun.RedisClient', async () => {
    const createResponse = await fetch(
      emulatorUrl(
        `/v1/projects/${project}/locations/${location}/instances?instanceId=${instanceId}`
      ),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }
    );

    expect(createResponse.status).toBe(200);

    const op = await createResponse.json();
    const endpoint = op.response.discoveryEndpoints?.[0];

    expect(endpoint).toBeDefined();
    expect(endpoint.port).toBeGreaterThanOrEqual(19000);
    expect(endpoint.port).toBeLessThanOrEqual(19010);

    // The deprecated discoveryEndpoints port is also mirrored onto the modern
    // PSC discovery path, so a client reading only endpoints[] still resolves it.
    const pscAutoConnection = op.response.endpoints?.[0]?.connections?.[0]?.pscAutoConnection;

    expect(pscAutoConnection).toBeDefined();
    expect(pscAutoConnection.port).toBe(endpoint.port);
    expect(pscAutoConnection.ipAddress).toBe(endpoint.address);
    expect(pscAutoConnection.connectionType).toBe('CONNECTION_TYPE_DISCOVERY');

    const client = new Bun.RedisClient(`redis://${endpoint.address}:${endpoint.port}`);

    try {
      expect(await client.send('PING', [])).toBe('PONG');

      await client.send('SET', ['e2e-key', 'e2e-value']);
      expect(await client.send('GET', ['e2e-key'])).toBe('e2e-value');
    } finally {
      client.close();
    }

    const deleteResponse = await fetch(emulatorUrl(instancePath), { method: 'DELETE' });

    expect(deleteResponse.status).toBe(200);

    const deletedClient = new Bun.RedisClient(`redis://${endpoint.address}:${endpoint.port}`, {
      connectionTimeout: 1000,
      autoReconnect: false,
      maxRetries: 0,
    });

    await expect(deletedClient.send('PING', [])).rejects.toThrow();
    deletedClient.close();
  });
});
