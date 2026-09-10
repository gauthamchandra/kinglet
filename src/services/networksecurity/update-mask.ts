/**
 * `updateMask` resolution for AddressGroup PATCH.
 *
 * Same FieldMask rules as AlloyDB: no mask means "writable fields present in the
 * body"; a mask names the fields to replace (absent body values clear them).
 */

import { MUTABLE_ADDRESS_GROUP_FIELDS, NetworkSecurityError } from './types.ts';

export function resolveMaskedFields(body: Record<string, unknown>, updateMask?: string): string[] {
  if (updateMask === undefined || updateMask.trim() === '') {
    return Object.keys(body).filter(field => MUTABLE_ADDRESS_GROUP_FIELDS.has(field));
  }

  const rootFields = new Set<string>();

  for (const rawPath of updateMask.split(',')) {
    const path = rawPath.trim();

    if (path === '*') {
      throw new NetworkSecurityError(
        'INVALID_ARGUMENT',
        'Field mask wildcard "*" is not supported; specify explicit field paths'
      );
    }

    const rootField = path.split('.')[0] ?? path;

    if (!MUTABLE_ADDRESS_GROUP_FIELDS.has(rootField)) {
      throw new NetworkSecurityError(
        'INVALID_ARGUMENT',
        `Field "${rootField}" is output-only or unknown and cannot be updated`
      );
    }

    rootFields.add(rootField);
  }

  return [...rootFields];
}
