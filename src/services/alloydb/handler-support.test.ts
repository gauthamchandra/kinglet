import { describe, expect, test } from 'bun:test';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { parseBooleanFlag, readQueryString, respondWith } from './handler-support.ts';
import { AlloyDbError } from './types.ts';

const responseUtils = new ResponseUtils(new StandardResponseFormatter(new Logger('test', 'error')));

function errorBody(response: { body?: unknown }) {
  return response.body as { error: { code: number; message: string; status: string } };
}

describe('respondWith', () => {
  test('respondWith_givenASuccessfulCall_returns200WithTheResult', async () => {
    const response = await respondWith('Cluster', responseUtils, async () => ({ name: 'c1' }));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ name: 'c1' });
  });

  test('respondWith_givenADomainError_returnsTheMatchingGcpEnvelope', async () => {
    const response = await respondWith('Cluster', responseUtils, () => {
      throw new AlloyDbError('NOT_FOUND', 'gone', 'projects/p/locations/l/clusters/c1');
    });

    expect(response.status).toBe(404);
    expect(errorBody(response).error.status).toBe('NOT_FOUND');
    expect(errorBody(response).error.message).toContain('Cluster');
  });

  /**
   * `users.create` can fail on its parent, so the error's own resource type has to
   * win over the route's — otherwise a missing cluster is reported as a missing
   * user.
   */
  test('respondWith_givenAnErrorNamingItsOwnResourceType_prefersThatOverTheRoutes', async () => {
    const response = await respondWith('User', responseUtils, () => {
      throw new AlloyDbError('NOT_FOUND', 'gone', 'projects/p/locations/l/clusters/c1', 'Cluster');
    });

    expect(errorBody(response).error.message).toContain('Cluster');
    expect(errorBody(response).error.message).not.toContain('User');
  });

  test('respondWith_givenAnUnexpectedError_returns500', async () => {
    const response = await respondWith('Cluster', responseUtils, () => {
      throw new Error('boom');
    });

    expect(response.status).toBe(500);
    expect(errorBody(response).error.status).toBe('INTERNAL');
  });
});

describe('readQueryString', () => {
  test.each([
    [undefined, undefined],
    ['', undefined],
    ['abc', 'abc'],
  ] as const)('readQueryString_givenScalar_%p_returns_%p', (raw, expected) => {
    expect(readQueryString(raw)).toBe(expected);
  });

  // A repeated query parameter arrives as an array; last value wins.
  test('readQueryString_givenARepeatedParameter_takesTheLastValue', () => {
    expect(readQueryString(['first', 'second'])).toBe('second');
  });

  test('readQueryString_givenAnEmptyArray_returnsUndefined', () => {
    expect(readQueryString([])).toBeUndefined();
  });
});

describe('parseBooleanFlag', () => {
  test.each(['true', 'TRUE', 'True', '1'])('parseBooleanFlag_treats_%p_asTrue', raw => {
    expect(parseBooleanFlag(raw)).toBe(true);
  });

  test.each([
    'false',
    'FALSE',
    '0',
    'yes',
    'anything',
  ])('parseBooleanFlag_treats_%p_asFalse', raw => {
    expect(parseBooleanFlag(raw)).toBe(false);
  });

  /**
   * Absent must stay undefined rather than collapsing to false: an unspecified
   * `allowMissing` is not the same as an explicit `allowMissing=false`, and the
   * services branch on that distinction.
   */
  test('parseBooleanFlag_givenAnAbsentParameter_returnsUndefinedRatherThanFalse', () => {
    expect(parseBooleanFlag(undefined)).toBeUndefined();
  });

  // `?validateOnly` with no value is how URLSearchParams renders a bare flag.
  test('parseBooleanFlag_givenAValuelessFlag_treatsItAsTrue', () => {
    expect(parseBooleanFlag('')).toBe(true);
  });
});
