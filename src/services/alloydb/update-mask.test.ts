import { describe, expect, test } from 'bun:test';
import { AlloyDbError, MUTABLE_CLUSTER_FIELDS } from './types.ts';
import { resolveMaskedFields } from './update-mask.ts';

function resolve(body: Record<string, unknown>, updateMask?: string): string[] {
  return resolveMaskedFields(body, MUTABLE_CLUSTER_FIELDS, updateMask).sort();
}

describe('without an updateMask', () => {
  test('resolveMaskedFields_withoutAMask_returnsTheWritableFieldsPresentInTheBody', () => {
    expect(resolve({ displayName: 'db', labels: { a: 'b' } })).toEqual(['displayName', 'labels']);
  });

  /**
   * A whole-resource PATCH body legitimately round-trips output-only fields the
   * client read back from a GET, so dropping them silently is correct here. Only
   * an *explicit* mask naming one is a client error worth a 400.
   */
  test('resolveMaskedFields_withoutAMask_silentlyDropsOutputOnlyFields', () => {
    expect(resolve({ displayName: 'db', state: 'FAILED', uid: 'x', name: 'spoofed' })).toEqual([
      'displayName',
    ]);
  });

  test('resolveMaskedFields_withoutAMask_dropsUnknownFields', () => {
    expect(resolve({ displayName: 'db', notARealField: 1 })).toEqual(['displayName']);
  });

  test('resolveMaskedFields_givenAnEmptyBody_returnsNothing', () => {
    expect(resolve({})).toEqual([]);
  });

  test.each([
    '',
    '   ',
  ])('resolveMaskedFields_givenABlankMask_%p_fallsBackToTheBodyRatherThanRejecting', blankMask => {
    expect(resolve({ displayName: 'db' }, blankMask)).toEqual(['displayName']);
  });
});

describe('with an updateMask', () => {
  test('resolveMaskedFields_returnsExactlyTheMaskedFields', () => {
    expect(resolve({ displayName: 'db', labels: { a: 'b' } }, 'displayName')).toEqual([
      'displayName',
    ]);
  });

  test('resolveMaskedFields_trimsWhitespaceAroundEachPath', () => {
    expect(resolve({ displayName: 'db', labels: {} }, ' displayName , labels ')).toEqual([
      'displayName',
      'labels',
    ]);
  });

  /**
   * Mutability is tracked at the top level of the resource, so a nested path
   * means "replace the whole parent object" rather than a field-by-field merge.
   */
  test('resolveMaskedFields_collapsesANestedPathToItsRootField', () => {
    expect(resolve({ networkConfig: { network: 'default' } }, 'networkConfig.network')).toEqual([
      'networkConfig',
    ]);
  });

  test('resolveMaskedFields_deduplicatesPathsSharingARootField', () => {
    expect(
      resolve({ networkConfig: {} }, 'networkConfig.network,networkConfig.allocatedIpRange')
    ).toEqual(['networkConfig']);
  });

  /**
   * Standard FieldMask semantics (AIP-134): a field named in the mask but absent
   * from the body is cleared, not ignored. It is returned so the caller can
   * remove it.
   */
  test('resolveMaskedFields_returnsAMaskedFieldAbsentFromTheBodySoTheCallerCanClearIt', () => {
    expect(resolve({}, 'displayName')).toEqual(['displayName']);
  });

  /**
   * Real FieldMask semantics for `*` mean "replace the entire resource", which
   * would let a client blank out server-owned fields by simply omitting them.
   * Rejecting it is safer than half-implementing it.
   */
  test('resolveMaskedFields_rejectsTheWildcardMask', () => {
    expect(() => resolve({ displayName: 'db' }, '*')).toThrow(AlloyDbError);
    expect(() => resolve({ displayName: 'db' }, '*')).toThrow(/wildcard/i);
  });

  test('resolveMaskedFields_rejectsTheWildcardEvenAlongsideValidPaths', () => {
    expect(() => resolve({ displayName: 'db' }, 'displayName,*')).toThrow(AlloyDbError);
  });

  test.each([
    'state',
    'uid',
    'name',
    'createTime',
    'reconciling',
  ])('resolveMaskedFields_rejectsOutputOnlyField_%s', readOnlyField => {
    expect(() => resolve({ displayName: 'db' }, readOnlyField)).toThrow(AlloyDbError);
  });

  test('resolveMaskedFields_rejectingAnOutputOnlyFieldReportsInvalidArgument', () => {
    try {
      resolve({}, 'state');
      throw new Error('expected resolveMaskedFields to reject a read-only field');
    } catch (error) {
      expect(error).toBeInstanceOf(AlloyDbError);
      expect((error as AlloyDbError).code).toBe('INVALID_ARGUMENT');
      expect((error as AlloyDbError).message).toContain('state');
    }
  });

  test('resolveMaskedFields_rejectsAnUnknownField', () => {
    expect(() => resolve({}, 'notARealField')).toThrow(AlloyDbError);
  });
});
