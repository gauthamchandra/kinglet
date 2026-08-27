/**
 * `updateMask` resolution shared by the AlloyDB cluster and instance services.
 *
 * <p>Both resources PATCH the same way and differ only in which fields are
 * writable, so the rules live here rather than being written twice.
 */

import { AlloyDbError } from './types.ts';

/**
 * Reduce an `updateMask` to the top-level resource fields it names.
 *
 * <p>With no mask, the writable fields present in the body are used and
 * everything else is dropped silently — a whole-resource PATCH legitimately
 * round-trips output-only fields the client read from a GET.
 *
 * <p>With a mask, every path must name a writable field or the request fails
 * with `INVALID_ARGUMENT`. A returned field that is absent from the body means
 * "clear it", per FieldMask semantics (AIP-134), so callers must handle absence
 * rather than skipping it.
 *
 * <p><b>NOTE:</b> nested paths collapse to their root field. Mutability is only
 * tracked at the top level, so `networkConfig.network` means "replace the whole
 * `networkConfig`" rather than merging one leaf.
 */
export function resolveMaskedFields(
  body: Record<string, unknown>,
  mutableFields: ReadonlySet<string>,
  updateMask?: string
): string[] {
  if (updateMask === undefined || updateMask.trim() === '') {
    return Object.keys(body).filter(field => mutableFields.has(field));
  }

  const rootFields = new Set<string>();

  for (const rawPath of updateMask.split(',')) {
    const path = rawPath.trim();

    // Real `*` semantics replace the entire resource, which would let a client
    // blank out server-owned fields (state, uid, ...) by omitting them. Rejected
    // rather than half-implemented.
    if (path === '*') {
      throw new AlloyDbError(
        'INVALID_ARGUMENT',
        'Field mask wildcard "*" is not supported; specify explicit field paths'
      );
    }

    const rootField = path.split('.')[0] ?? path;

    if (!mutableFields.has(rootField)) {
      throw new AlloyDbError(
        'INVALID_ARGUMENT',
        `Field "${rootField}" is output-only or unknown and cannot be updated`
      );
    }

    rootFields.add(rootField);
  }

  return [...rootFields];
}
