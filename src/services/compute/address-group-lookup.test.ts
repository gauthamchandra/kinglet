import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { AddressGroupRepository } from '@/services/networksecurity/repository.ts';
import type { AddressGroupRecord } from '@/services/networksecurity/types.ts';
import {
  loadAddressGroupLookup,
  projectFromSecurityPolicySelfLink,
} from './address-group-lookup.ts';
import { buildSecurityPolicySelfLink } from './types.ts';

function makeGroup(
  overrides: Partial<Omit<AddressGroupRecord, keyof BaseRecord>> = {}
): Omit<AddressGroupRecord, keyof BaseRecord> {
  return {
    name: 'projects/p/locations/global/addressGroups/malicious-ips',
    type: 'IPV4',
    capacity: 10,
    items: JSON.stringify(['198.51.100.0/24', '203.0.113.10']),
    purpose: JSON.stringify(['CLOUD_ARMOR']),
    labels: '{}',
    description: '',
    createTime: '2026-01-01T00:00:00.000Z',
    updateTime: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('projectFromSecurityPolicySelfLink', () => {
  test('reads the project from a Compute selfLink', () => {
    expect(projectFromSecurityPolicySelfLink(buildSecurityPolicySelfLink('acme', 'edge'))).toBe(
      'acme'
    );
  });

  test('returns undefined for a non-policy URL', () => {
    expect(projectFromSecurityPolicySelfLink('https://example.com/pol')).toBeUndefined();
  });
});

describe('loadAddressGroupLookup', () => {
  let repo: AddressGroupRepository;

  beforeEach(async () => {
    const storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new AddressGroupRepository(storage);
    await repo.initialize();
  });

  test('resolves short names and matching full resource names', async () => {
    await repo.create(makeGroup());

    const lookup = await loadAddressGroupLookup(repo, 'p');

    expect(lookup('malicious-ips')).toEqual(['198.51.100.0/24', '203.0.113.10']);
    expect(lookup('projects/p/locations/global/addressGroups/malicious-ips')).toEqual([
      '198.51.100.0/24',
      '203.0.113.10',
    ]);
  });

  test('does not match another project, another location, or a missing group', async () => {
    await repo.create(makeGroup());
    await repo.create(
      makeGroup({
        name: 'projects/other/locations/global/addressGroups/malicious-ips',
        items: JSON.stringify(['192.0.2.1']),
      })
    );
    await repo.create(
      makeGroup({
        name: 'projects/p/locations/us-central1/addressGroups/regional',
        items: JSON.stringify(['192.0.2.8']),
      })
    );

    const lookup = await loadAddressGroupLookup(repo, 'p');

    expect(lookup('missing')).toBeUndefined();
    expect(lookup('projects/other/locations/global/addressGroups/malicious-ips')).toBeUndefined();
    expect(lookup('regional')).toBeUndefined();
    expect(lookup('projects/p/locations/us-central1/addressGroups/regional')).toBeUndefined();
  });

  test('treats malformed stored items as an empty list', async () => {
    await repo.create(makeGroup({ items: 'not-json' }));
    await repo.create(
      makeGroup({
        name: 'projects/p/locations/global/addressGroups/numbers',
        items: JSON.stringify([1, 2]),
      })
    );

    const lookup = await loadAddressGroupLookup(repo, 'p');

    expect(lookup('malicious-ips')).toEqual([]);
    expect(lookup('numbers')).toEqual([]);
  });
});
