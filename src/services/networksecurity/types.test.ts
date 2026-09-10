import { describe, expect, test } from 'bun:test';
import type { AddressGroupRecord } from './types.ts';
import {
  addressGroupRecordToResponse,
  addressGroupRequestToRecord,
  buildAddressGroupName,
  isValidAddressGroupId,
  itemMatchesType,
  NetworkSecurityError,
  normalizeAddressGroupType,
  normalizeCapacity,
  normalizeItems,
  normalizePurpose,
  parseAddressGroupName,
} from './types.ts';

describe('address group names', () => {
  test('buildAddressGroupName and parseAddressGroupName are inverses', () => {
    const name = buildAddressGroupName('proj', 'global', 'malicious-ips');

    expect(name).toBe('projects/proj/locations/global/addressGroups/malicious-ips');
    expect(parseAddressGroupName(name)).toEqual({
      project: 'proj',
      location: 'global',
      addressGroupId: 'malicious-ips',
    });
  });

  test('parseAddressGroupName returns null for org-scoped names', () => {
    expect(parseAddressGroupName('organizations/1/locations/global/addressGroups/g')).toBeNull();
  });

  test('isValidAddressGroupId rejects ids that start with a number', () => {
    expect(isValidAddressGroupId('malicious-ips')).toBe(true);
    expect(isValidAddressGroupId('1bad')).toBe(false);
    expect(isValidAddressGroupId('')).toBe(false);
  });
});

describe('normalizers', () => {
  test('normalizeAddressGroupType accepts names and proto numbers', () => {
    expect(normalizeAddressGroupType('IPV4')).toBe('IPV4');
    expect(normalizeAddressGroupType(2)).toBe('IPV6');
    expect(() => normalizeAddressGroupType('IP')).toThrow(NetworkSecurityError);
  });

  test('normalizeCapacity requires a positive integer', () => {
    expect(normalizeCapacity(100)).toBe(100);
    expect(normalizeCapacity('100')).toBe(100);
    expect(() => normalizeCapacity(0)).toThrow(NetworkSecurityError);
  });

  test('normalizeItems trims strings and rejects non-lists', () => {
    expect(normalizeItems([' 1.1.1.1 ', '2.2.2.2/32'])).toEqual(['1.1.1.1', '2.2.2.2/32']);
    expect(normalizeItems(undefined)).toEqual([]);
    expect(() => normalizeItems('1.1.1.1')).toThrow(NetworkSecurityError);
  });

  test('normalizePurpose accepts DEFAULT and CLOUD_ARMOR', () => {
    expect(normalizePurpose(['CLOUD_ARMOR', 1])).toEqual(['CLOUD_ARMOR', 'DEFAULT']);
    expect(() => normalizePurpose(['FIREWALL'])).toThrow(NetworkSecurityError);
  });
});

describe('itemMatchesType', () => {
  test('matches IPv4 addresses and CIDRs', () => {
    expect(itemMatchesType('198.51.100.10', 'IPV4')).toBe(true);
    expect(itemMatchesType('198.51.100.0/24', 'IPV4')).toBe(true);
    expect(itemMatchesType('2001:db8::1', 'IPV4')).toBe(false);
  });

  test('matches IPv6 addresses and CIDRs', () => {
    expect(itemMatchesType('2001:db8::1', 'IPV6')).toBe(true);
    expect(itemMatchesType('2001:db8::/32', 'IPV6')).toBe(true);
    expect(itemMatchesType('198.51.100.10', 'IPV6')).toBe(false);
  });

  test('rejects CIDRs with an invalid prefix', () => {
    expect(itemMatchesType('198.51.100.10/99', 'IPV4')).toBe(false);
    expect(itemMatchesType('10.0.0.0/abc', 'IPV4')).toBe(false);
    expect(itemMatchesType('2001:db8::/129', 'IPV6')).toBe(false);
  });
});

describe('addressGroupRequestToRecord', () => {
  test('requires type and capacity and stores JSON columns', () => {
    const record = addressGroupRequestToRecord(
      'projects/p/locations/global/addressGroups/g',
      {
        type: 'IPV4',
        capacity: 10,
        items: ['198.51.100.0/24'],
        purpose: ['CLOUD_ARMOR'],
        description: 'deny list',
      },
      '2026-01-01T00:00:00.000Z'
    );

    expect(record.type).toBe('IPV4');
    expect(record.capacity).toBe(10);
    expect(JSON.parse(record.items)).toEqual(['198.51.100.0/24']);
    expect(JSON.parse(record.purpose)).toEqual(['CLOUD_ARMOR']);
    expect(record.createTime).toBe('2026-01-01T00:00:00.000Z');
  });

  test('rejects items that exceed capacity or mismatch type', () => {
    expect(() =>
      addressGroupRequestToRecord('projects/p/locations/global/addressGroups/g', {
        type: 'IPV4',
        capacity: 1,
        items: ['198.51.100.1', '198.51.100.2'],
      })
    ).toThrow(/exceeds capacity/);

    expect(() =>
      addressGroupRequestToRecord('projects/p/locations/global/addressGroups/g', {
        type: 'IPV4',
        capacity: 10,
        items: ['198.51.100.0/99'],
      })
    ).toThrow(/not a valid IPV4/);
  });
});

describe('addressGroupRecordToResponse', () => {
  test('omits empty description, labels, and purpose', () => {
    const record: AddressGroupRecord = {
      id: 'id',
      createdAt: new Date(),
      updatedAt: new Date(),
      name: 'projects/p/locations/global/addressGroups/g',
      type: 'IPV4',
      capacity: 10,
      items: '[]',
      purpose: '[]',
      labels: '{}',
      description: '',
      createTime: '2026-01-01T00:00:00.000Z',
      updateTime: '2026-01-01T00:00:00.000Z',
    };

    const response = addressGroupRecordToResponse(record);

    expect(response.description).toBeUndefined();
    expect(response.labels).toBeUndefined();
    expect(response.purpose).toBeUndefined();
    expect(response.selfLink).toBe(
      'https://networksecurity.googleapis.com/v1/projects/p/locations/global/addressGroups/g'
    );
    expect(response.items).toEqual([]);
  });
});
