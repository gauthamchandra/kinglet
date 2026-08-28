import { describe, expect, test } from 'bun:test';
import { isRemoteDiscoveryUrl } from './fetch-discovery-document.ts';

describe('isRemoteDiscoveryUrl', () => {
  test('accepts https discovery registry URLs', () => {
    expect(
      isRemoteDiscoveryUrl('https://cloudscheduler.googleapis.com/$discovery/rest?version=v1')
    ).toBe(true);
  });

  test('rejects local file paths', () => {
    expect(isRemoteDiscoveryUrl('./memorystore.discovery-document.private.json')).toBe(false);
  });
});
