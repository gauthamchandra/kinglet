import { describe, expect, test } from 'bun:test';
import { NetworkSecurityError } from './types.ts';
import { resolveMaskedFields } from './update-mask.ts';

describe('resolveMaskedFields', () => {
  test('without a mask, returns writable fields present in the body', () => {
    expect(resolveMaskedFields({ items: [], type: 'IPV4', capacity: 10 })).toEqual(['items']);
  });

  test('with a mask, rejects immutable fields', () => {
    expect(() => resolveMaskedFields({}, 'type')).toThrow(NetworkSecurityError);
    expect(() => resolveMaskedFields({}, 'capacity')).toThrow(NetworkSecurityError);
  });

  test('with a mask, returns the named writable fields', () => {
    expect(resolveMaskedFields({}, 'items,description')).toEqual(['items', 'description']);
  });

  test('rejects a wildcard mask', () => {
    expect(() => resolveMaskedFields({}, '*')).toThrow(NetworkSecurityError);
  });
});
