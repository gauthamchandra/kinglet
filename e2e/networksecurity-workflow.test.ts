/**
 * End-to-End Test: Network Security address groups
 *
 * Two black-box paths against a running emulator:
 *   1. Raw HTTP (create LRO, terraform-style operation GET, GET/list/patch/delete)
 *   2. The official @google-cloud/network-security client over REST
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { protos, v1 } from '@google-cloud/network-security';
import type { Server } from 'bun';
import { createLocationRoutes } from '@/core/gateway/location-routes.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { NetworkSecurityService } from '@/services/networksecurity/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { buildProductionRouter, createFakeAuth } from './e2e-helpers.ts';

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

  test('6b. create with an invalid CIDR prefix is 400', async () => {
    const response = await postJson(`${collection}?addressGroupId=bad-cidr`, {
      type: 'IPV4',
      capacity: 10,
      items: ['198.51.100.10/99'],
    });

    expect(response.status).toBe(400);

    const { error } = await response.json();

    expect(error.status).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain('198.51.100.10/99');
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

describe('Network Security E2E: Client Library', () => {
  const project = 'client-project';
  const location = 'global';
  const groupId = 'armor-allowlist';
  const parent = `projects/${project}/locations/${location}`;
  const name = `${parent}/addressGroups/${groupId}`;

  /**
   * Enum decoding differs by response path, so the assertions below
   * deliberately differ too:
   *
   * - A resource unwrapped from an LRO (`operation.promise()`) keeps proto
   *   enum numbers — `type` is 1.
   * - A resource returned directly from a unary call (`getAddressGroup`) is
   *   decoded with string enums — `type` is `'IPV4'`.
   *
   * Both happen identically against real GCP: the emulator sends the enum name
   * on the wire either way, which the raw-HTTP suite above asserts.
   */
  const nsProtos = protos.google.cloud.networksecurity.v1;

  let client: InstanceType<typeof v1.AddressGroupServiceClient>;

  beforeAll(() => {
    client = new v1.AddressGroupServiceClient({
      fallback: 'rest',
      apiEndpoint: 'localhost',
      port: emulatorPort,
      protocol: 'http',
      auth: createFakeAuth(project) as never,
    });
  });

  test('1. Create an address group via the client library', async () => {
    const [operation] = await client.createAddressGroup({
      parent,
      addressGroupId: groupId,
      addressGroup: {
        type: 'IPV4',
        capacity: 100,
        description: 'via google-cloud client',
        items: ['198.51.100.0/24'],
        purpose: ['CLOUD_ARMOR'],
      },
    });

    const [group] = await operation.promise();

    expect(group.name).toBe(name);
    expect(group.type).toBe(nsProtos.AddressGroup.Type.IPV4);
    expect(group.capacity).toBe(100);
    expect(group.items).toEqual(['198.51.100.0/24']);
    expect(group.purpose).toEqual([nsProtos.AddressGroup.Purpose.CLOUD_ARMOR]);
    expect(group.description).toBe('via google-cloud client');
  });

  test('2. Get the address group via the client library', async () => {
    const [group] = await client.getAddressGroup({ name });

    expect(group.name).toBe(name);
    expect(group.type).toBe('IPV4');
    expect(group.items).toEqual(['198.51.100.0/24']);
    expect(group.purpose).toEqual(['CLOUD_ARMOR']);
  });

  test('3. List address groups via the client library', async () => {
    const [groups] = await client.listAddressGroups({ parent });

    expect(groups.map(group => group.name)).toContain(name);
  });

  test('4. Patch items through updateMask via the client library', async () => {
    const [operation] = await client.updateAddressGroup({
      addressGroup: {
        name,
        items: ['198.51.100.0/24', '203.0.113.0/24'],
        description: 'should not apply',
      },
      updateMask: { paths: ['items'] },
    });

    const [updated] = await operation.promise();

    expect(updated.items).toEqual(['198.51.100.0/24', '203.0.113.0/24']);
    expect(updated.description).toBe('via google-cloud client');
  });

  test('5. Create with an invalid CIDR prefix is rejected', async () => {
    const promise = client.createAddressGroup({
      parent,
      addressGroupId: 'bad-cidr',
      addressGroup: {
        type: 'IPV4',
        capacity: 10,
        items: ['198.51.100.10/99'],
      },
    });

    await expect(promise).rejects.toThrow();
  });

  test('6. Delete the address group via the client library', async () => {
    const [operation] = await client.deleteAddressGroup({ name });
    const [empty] = await operation.promise();

    expect(empty).toEqual({});

    await expect(client.getAddressGroup({ name })).rejects.toThrow();
  });
});
