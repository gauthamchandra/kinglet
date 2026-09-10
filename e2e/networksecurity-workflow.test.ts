/**
 * End-to-End Test: Network Security address groups
 *
 * Black-box HTTP against a running emulator. Address groups are
 * `google.longrunning.Operation` RPCs; terraform's waiter GETs the operation
 * name against the `/v1/` custom endpoint, so that poll is part of this suite.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { createLocationRoutes } from '@/core/gateway/location-routes.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { NetworkSecurityService } from '@/services/networksecurity/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { buildProductionRouter } from './e2e-helpers.ts';

let emulatorServer: Server;
let emulatorPort: number;
let service: NetworkSecurityService;

function url(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(url(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patchJson(path: string, body: unknown): Promise<Response> {
  return fetch(url(path), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  emulatorPort = await getAvailablePort();

  const logger = new Logger('e2e-networksecurity', 'error');
  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  service = new NetworkSecurityService(storage, logger);
  await service.initialize();

  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: buildProductionRouter([...createLocationRoutes(logger), ...service.getRoutes()]),
  });
});

afterAll(async () => {
  await service.stop();
  emulatorServer.stop();
});

describe('Network Security E2E: Raw HTTP API', () => {
  const project = 'e2e-project';
  const location = 'global';
  const groupId = 'web-allow';
  const collection = `/v1/projects/${project}/locations/${location}/addressGroups`;
  const resource = `${collection}/${groupId}`;
  const resourceName = `projects/${project}/locations/${location}/addressGroups/${groupId}`;

  let createOperationName: string;

  test('1. create returns a done Operation carrying the AddressGroup', async () => {
    const response = await postJson(`${collection}?addressGroupId=${groupId}`, {
      type: 'IPV4',
      capacity: 100,
      items: ['198.51.100.0/24'],
      purpose: ['CLOUD_ARMOR'],
      description: 'e2e allow list',
    });

    expect(response.status).toBe(200);

    const operation = await response.json();

    expect(operation.done).toBe(true);
    expect(operation.name).toMatch(
      new RegExp(`^projects/${project}/locations/${location}/operations/[0-9a-f-]+$`)
    );
    expect(operation.metadata['@type']).toBe(
      'type.googleapis.com/google.cloud.networksecurity.v1.OperationMetadata'
    );
    expect(operation.response['@type']).toBe(
      'type.googleapis.com/google.cloud.networksecurity.v1.AddressGroup'
    );
    expect(operation.response.name).toBe(resourceName);
    expect(operation.response.purpose).toEqual(['CLOUD_ARMOR']);
    expect(operation.response.items).toEqual(['198.51.100.0/24']);

    createOperationName = operation.name;
  });

  test('2. GET the create operation the way terraform polls it', async () => {
    const response = await fetch(url(`/v1/${createOperationName}`));

    expect(response.status).toBe(200);

    const operation = await response.json();

    expect(operation.done).toBe(true);
    expect(operation.name).toBe(createOperationName);
    expect(operation.response.name).toBe(resourceName);
  });

  test('3. GET the address group', async () => {
    const response = await fetch(url(resource));

    expect(response.status).toBe(200);

    const group = await response.json();

    expect(group.name).toBe(resourceName);
    expect(group.type).toBe('IPV4');
    expect(group.capacity).toBe(100);
    expect(group.items).toEqual(['198.51.100.0/24']);
    expect(group.purpose).toEqual(['CLOUD_ARMOR']);
    expect(group.description).toBe('e2e allow list');
  });

  test('4. list includes the group', async () => {
    const response = await fetch(url(collection));

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.addressGroups.map((group: { name: string }) => group.name)).toEqual([resourceName]);
  });

  test('5. duplicate create is 409 ALREADY_EXISTS', async () => {
    const response = await postJson(`${collection}?addressGroupId=${groupId}`, {
      type: 'IPV4',
      capacity: 10,
    });

    expect(response.status).toBe(409);

    const { error } = await response.json();

    expect(error.status).toBe('ALREADY_EXISTS');
  });

  test('6. create without addressGroupId is 400', async () => {
    const response = await postJson(collection, { type: 'IPV4', capacity: 10 });

    expect(response.status).toBe(400);

    const { error } = await response.json();

    expect(error.status).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain('addressGroupId');
  });

  test('7. PATCH items returns a done operation', async () => {
    const response = await patchJson(`${resource}?updateMask=items`, {
      items: ['203.0.113.0/24', '198.51.100.10'],
    });

    expect(response.status).toBe(200);

    const operation = await response.json();

    expect(operation.done).toBe(true);
    expect(operation.response.items).toEqual(['203.0.113.0/24', '198.51.100.10']);
  });

  test('8. DELETE returns a done operation with no response', async () => {
    const response = await fetch(url(resource), { method: 'DELETE' });

    expect(response.status).toBe(200);

    const operation = await response.json();

    expect(operation.done).toBe(true);
    expect(operation.response).toBeUndefined();
  });

  test('9. GET after delete is 404', async () => {
    const response = await fetch(url(resource));

    expect(response.status).toBe(404);
  });
});
