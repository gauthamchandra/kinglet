import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { AddressGroupRepository } from './repository.ts';
import type { AddressGroupRecord } from './types.ts';

function makeGroup(
  overrides: Partial<Omit<AddressGroupRecord, keyof BaseRecord>> = {}
): Omit<AddressGroupRecord, keyof BaseRecord> {
  return {
    name: 'projects/p/locations/global/addressGroups/g',
    type: 'IPV4',
    capacity: 10,
    items: '[]',
    purpose: '[]',
    labels: '{}',
    description: '',
    createTime: '2026-01-01T00:00:00.000Z',
    updateTime: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('AddressGroupRepository', () => {
  let repo: AddressGroupRepository;

  beforeEach(async () => {
    const storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new AddressGroupRepository(storage);
    await repo.initialize();
  });

  test('create rejects duplicate names', async () => {
    await repo.create(makeGroup());

    await expect(repo.create(makeGroup())).rejects.toThrow();
  });

  test('listAddressGroups pages groups in one project and location', async () => {
    await repo.create(makeGroup({ name: 'projects/p/locations/global/addressGroups/a' }));
    await repo.create(makeGroup({ name: 'projects/p/locations/global/addressGroups/b' }));
    await repo.create(makeGroup({ name: 'projects/p/locations/global/addressGroups/c' }));
    await repo.create(makeGroup({ name: 'projects/other/locations/global/addressGroups/d' }));

    const page1 = await repo.listAddressGroups('p', 'global', 2);

    expect(page1.addressGroups.map(group => group.name)).toEqual([
      'projects/p/locations/global/addressGroups/a',
      'projects/p/locations/global/addressGroups/b',
    ]);
    expect(page1.nextPageToken).toBeTypeOf('string');

    const page2 = await repo.listAddressGroups('p', 'global', 2, page1.nextPageToken);

    expect(page2.addressGroups.map(group => group.name)).toEqual([
      'projects/p/locations/global/addressGroups/c',
    ]);
    expect(page2.nextPageToken).toBeUndefined();
  });

  test('update and delete operate by resource name', async () => {
    const created = await repo.create(makeGroup());
    const updated = await repo.update(created.name, { description: 'updated' });

    expect(updated?.description).toBe('updated');
    expect(await repo.delete(created.name)).toBe(true);
    expect(await repo.getByName(created.name)).toBeNull();
  });
});
