import { beforeEach, describe, expect, test } from 'bun:test';
import { OperationsStore } from '@/core/operations/operations-store.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { AddressGroupRepository } from './repository.ts';
import { AddressGroupService } from './service.ts';
import { NETWORKSECURITY_API_TYPE_PREFIX, NETWORKSECURITY_OPERATIONS_TABLE } from './types.ts';

const PROJECT = 'p';
const LOCATION = 'global';

describe('AddressGroupService', () => {
  let service: AddressGroupService;

  beforeEach(async () => {
    const storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    const groups = new AddressGroupRepository(storage);
    const operations = new OperationsStore(storage, {
      tableName: NETWORKSECURITY_OPERATIONS_TABLE,
      apiTypePrefix: NETWORKSECURITY_API_TYPE_PREFIX,
    });

    await Promise.all([groups.initialize(), operations.initialize()]);
    service = new AddressGroupService(groups, operations);
  });

  test('create returns a done Operation whose response is the AddressGroup', async () => {
    const operation = await service.createAddressGroup(PROJECT, LOCATION, 'malicious-ips', {
      type: 'IPV4',
      capacity: 100,
      items: ['198.51.100.0/24'],
      purpose: ['CLOUD_ARMOR'],
    });

    expect(operation.done).toBe(true);
    expect(operation.name).toMatch(/^projects\/p\/locations\/global\/operations\/[0-9a-f-]+$/);
    expect(operation.metadata['@type']).toBe(
      'type.googleapis.com/google.cloud.networksecurity.v1.OperationMetadata'
    );
    expect(operation.response?.['@type']).toBe(
      'type.googleapis.com/google.cloud.networksecurity.v1.AddressGroup'
    );
    expect(operation.response?.name).toBe(
      'projects/p/locations/global/addressGroups/malicious-ips'
    );
    expect(operation.response?.purpose).toEqual(['CLOUD_ARMOR']);
  });

  test('create rejects a duplicate id with ALREADY_EXISTS', async () => {
    await service.createAddressGroup(PROJECT, LOCATION, 'g', {
      type: 'IPV4',
      capacity: 10,
    });

    const promise = service.createAddressGroup(PROJECT, LOCATION, 'g', {
      type: 'IPV4',
      capacity: 10,
    });

    await expect(promise).rejects.toBeInstanceOf(Error);
    await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
  });

  // Serialized on the group name: without the lock both creates pass the
  // existence check and the loser trips the repository's plain-Error guard, which
  // surfaces as 500 rather than a clean ALREADY_EXISTS.
  test('create given concurrent same-id creates: one succeeds, one ALREADY_EXISTS', async () => {
    const results = await Promise.allSettled([
      service.createAddressGroup(PROJECT, LOCATION, 'g', { type: 'IPV4', capacity: 10 }),
      service.createAddressGroup(PROJECT, LOCATION, 'g', { type: 'IPV4', capacity: 10 }),
    ]);

    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const reason = (rejected[0] as PromiseRejectedResult).reason;

    expect(reason).toHaveProperty('code', 'ALREADY_EXISTS');

    const listed = await service.listAddressGroups(PROJECT, LOCATION);

    expect(listed.addressGroups).toHaveLength(1);
  });

  test('get, list, patch items, and delete round-trip', async () => {
    await service.createAddressGroup(PROJECT, LOCATION, 'g', {
      type: 'IPV4',
      capacity: 10,
      items: ['198.51.100.1'],
    });

    const got = await service.getAddressGroup(PROJECT, LOCATION, 'g');

    expect(got.items).toEqual(['198.51.100.1']);
    expect(got.capacity).toBe(10);

    const listed = await service.listAddressGroups(PROJECT, LOCATION);

    expect(listed.addressGroups).toHaveLength(1);

    const patched = await service.updateAddressGroup(
      PROJECT,
      LOCATION,
      'g',
      { items: ['203.0.113.0/24'] },
      'items'
    );

    expect(patched.response?.items).toEqual(['203.0.113.0/24']);

    const deleted = await service.deleteAddressGroup(PROJECT, LOCATION, 'g');

    expect(deleted.done).toBe(true);
    expect(deleted.response).toBeUndefined();

    const missing = service.getAddressGroup(PROJECT, LOCATION, 'g');

    await expect(missing).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('patch cannot change type or capacity via updateMask', async () => {
    await service.createAddressGroup(PROJECT, LOCATION, 'g', {
      type: 'IPV4',
      capacity: 10,
    });

    const promise = service.updateAddressGroup(PROJECT, LOCATION, 'g', { type: 'IPV6' }, 'type');

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });
});
