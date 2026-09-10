/**
 * HTTP-layer tests for address-group handlers.
 *
 * Exercised through the real service over in-memory storage rather than mocks:
 * the thing worth pinning is that query parameters reach the right argument
 * and that the response body is shaped the way a GCP client expects.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { RouteDefinition, RouteRequest } from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import { OperationsStore } from '@/core/operations/operations-store.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { AddressGroupHandlers } from './handlers.ts';
import { AddressGroupRepository } from './repository.ts';
import { AddressGroupService } from './service.ts';
import type { AddressGroupResponse } from './types.ts';
import { NETWORKSECURITY_API_TYPE_PREFIX, NETWORKSECURITY_OPERATIONS_TABLE } from './types.ts';

const PROJECT = 'p';
const LOCATION = 'global';

let handlers: AddressGroupHandlers;

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/',
    query: {},
    headers: {},
    params: { project: PROJECT, location: LOCATION },
    originalRequest: new Request('http://localhost/'),
    ...overrides,
  };
}

async function invoke(routeId: string, overrides: Partial<RouteRequest> = {}) {
  const route = handlers.getRoutes().find(candidate => candidate.id === routeId);

  if (!route) {
    throw new Error(`No route registered with id "${routeId}"`);
  }

  return route.handler(request(overrides), {
    routeId,
    startTime: 0,
    metadata: {},
    logger: new Logger('test', 'error'),
  });
}

function body(response: { body?: unknown }): Record<string, unknown> {
  return response.body as Record<string, unknown>;
}

beforeEach(async () => {
  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const groups = new AddressGroupRepository(storage);
  const operations = new OperationsStore(storage, {
    tableName: NETWORKSECURITY_OPERATIONS_TABLE,
    apiTypePrefix: NETWORKSECURITY_API_TYPE_PREFIX,
  });

  await Promise.all([groups.initialize(), operations.initialize()]);

  handlers = new AddressGroupHandlers(
    new AddressGroupService(groups, operations),
    new ResponseUtils(new StandardResponseFormatter(new Logger('test', 'error')))
  );
});

describe('AddressGroupHandlers', () => {
  test('every route id is unique and prefixed with networksecurity', () => {
    const routes: RouteDefinition[] = handlers.getRoutes();
    const ids = routes.map(route => route.id);

    expect(new Set(ids).size).toBe(ids.length);

    for (const route of routes) {
      expect(route.id).toStartWith('networksecurity.');
    }
  });

  test('create requires addressGroupId', async () => {
    const response = await invoke('networksecurity.addressGroups.create', {
      method: 'POST',
      body: { type: 'IPV4', capacity: 10 },
    });

    expect(response.status).toBe(400);
    expect(body(response).error).toEqual(
      expect.objectContaining({
        status: 'INVALID_ARGUMENT',
        message: expect.stringContaining('addressGroupId'),
      })
    );
  });

  test('create returns a done operation whose response is the AddressGroup', async () => {
    const response = await invoke('networksecurity.addressGroups.create', {
      method: 'POST',
      query: { addressGroupId: 'web-allow' },
      body: {
        type: 'IPV4',
        capacity: 10,
        items: ['10.0.0.0/8'],
        purpose: ['CLOUD_ARMOR'],
      },
    });

    expect(response.status).toBe(200);

    const operation = body(response);

    expect(operation.done).toBe(true);
    expect(operation.name).toStartWith(`projects/${PROJECT}/locations/${LOCATION}/operations/`);

    const group = operation.response as AddressGroupResponse;

    expect(group.name).toBe(`projects/${PROJECT}/locations/${LOCATION}/addressGroups/web-allow`);
    expect(group.purpose).toEqual(['CLOUD_ARMOR']);
    expect(group.items).toEqual(['10.0.0.0/8']);
  });

  test('get returns the resource without a /v1/ prefix in name', async () => {
    await invoke('networksecurity.addressGroups.create', {
      method: 'POST',
      query: { addressGroupId: 'web-allow' },
      body: { type: 'IPV4', capacity: 10, items: ['10.0.0.0/8'] },
    });

    const response = await invoke('networksecurity.addressGroups.get', {
      params: { project: PROJECT, location: LOCATION, addressGroup: 'web-allow' },
    });

    expect(response.status).toBe(200);

    const group = body(response) as unknown as AddressGroupResponse;

    expect(group.name).toBe(`projects/${PROJECT}/locations/${LOCATION}/addressGroups/web-allow`);
    expect(group.selfLink).toBe(
      'https://networksecurity.googleapis.com/v1/projects/p/locations/global/addressGroups/web-allow'
    );
  });

  test('get of a missing group returns 404', async () => {
    const response = await invoke('networksecurity.addressGroups.get', {
      params: { project: PROJECT, location: LOCATION, addressGroup: 'missing' },
    });

    expect(response.status).toBe(404);
    expect(body(response).error).toEqual(expect.objectContaining({ status: 'NOT_FOUND' }));
  });

  test('list returns items for the location', async () => {
    await invoke('networksecurity.addressGroups.create', {
      method: 'POST',
      query: { addressGroupId: 'web-allow' },
      body: { type: 'IPV4', capacity: 10 },
    });

    const response = await invoke('networksecurity.addressGroups.list');

    expect(response.status).toBe(200);
    expect(body(response).addressGroups).toHaveLength(1);
  });

  test('patch requires a writable updateMask field', async () => {
    await invoke('networksecurity.addressGroups.create', {
      method: 'POST',
      query: { addressGroupId: 'web-allow' },
      body: { type: 'IPV4', capacity: 10 },
    });

    const response = await invoke('networksecurity.addressGroups.patch', {
      method: 'PATCH',
      params: { project: PROJECT, location: LOCATION, addressGroup: 'web-allow' },
      query: { updateMask: 'type' },
      body: { type: 'IPV6' },
    });

    expect(response.status).toBe(400);
  });

  test('patch returns a done operation', async () => {
    await invoke('networksecurity.addressGroups.create', {
      method: 'POST',
      query: { addressGroupId: 'web-allow' },
      body: { type: 'IPV4', capacity: 10 },
    });

    const response = await invoke('networksecurity.addressGroups.patch', {
      method: 'PATCH',
      params: { project: PROJECT, location: LOCATION, addressGroup: 'web-allow' },
      query: { updateMask: 'description' },
      body: { description: 'updated' },
    });

    expect(response.status).toBe(200);

    const operation = body(response);

    expect(operation.done).toBe(true);
    expect((operation.response as AddressGroupResponse).description).toBe('updated');
  });

  test('delete operation has no response', async () => {
    await invoke('networksecurity.addressGroups.create', {
      method: 'POST',
      query: { addressGroupId: 'web-allow' },
      body: { type: 'IPV4', capacity: 10 },
    });

    const response = await invoke('networksecurity.addressGroups.delete', {
      method: 'DELETE',
      params: { project: PROJECT, location: LOCATION, addressGroup: 'web-allow' },
    });

    expect(response.status).toBe(200);

    const operation = body(response);

    expect(operation.done).toBe(true);
    expect(operation.response).toBeUndefined();
  });
});
