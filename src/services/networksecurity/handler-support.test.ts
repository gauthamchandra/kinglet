import { describe, expect, test } from 'bun:test';
import type { RouteRequest } from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { readBody, readQueryString, respondWith } from './handler-support.ts';
import { NetworkSecurityError } from './types.ts';

const responseUtils = new ResponseUtils(new StandardResponseFormatter(new Logger('test', 'error')));

function errorBody(response: { body?: unknown }) {
  return response.body as { error: { code: number; message: string; status: string } };
}

describe('respondWith', () => {
  test('returns 200 with the result on success', async () => {
    const response = await respondWith('AddressGroup', responseUtils, async () => ({
      name: 'g',
    }));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ name: 'g' });
  });

  test('maps a domain error to the matching GCP envelope', async () => {
    const response = await respondWith('AddressGroup', responseUtils, () => {
      throw new NetworkSecurityError(
        'NOT_FOUND',
        'gone',
        'projects/p/locations/global/addressGroups/g'
      );
    });

    expect(response.status).toBe(404);
    expect(errorBody(response).error.status).toBe('NOT_FOUND');
  });

  test('maps ALREADY_EXISTS to 409', async () => {
    const response = await respondWith('AddressGroup', responseUtils, () => {
      throw new NetworkSecurityError(
        'ALREADY_EXISTS',
        'exists',
        'projects/p/locations/global/addressGroups/g'
      );
    });

    expect(response.status).toBe(409);
    expect(errorBody(response).error.status).toBe('ALREADY_EXISTS');
  });

  test('maps FAILED_PRECONDITION to 400', async () => {
    const response = await respondWith('AddressGroup', responseUtils, () => {
      throw new NetworkSecurityError('FAILED_PRECONDITION', 'not ready');
    });

    expect(response.status).toBe(400);
    expect(errorBody(response).error.status).toBe('FAILED_PRECONDITION');
  });

  test('returns 500 for unexpected errors', async () => {
    const response = await respondWith('AddressGroup', responseUtils, () => {
      throw new Error('boom');
    });

    expect(response.status).toBe(500);
    expect(errorBody(response).error.status).toBe('INTERNAL');
  });
});

describe('readQueryString', () => {
  test('treats missing and empty values as undefined', () => {
    expect(readQueryString(undefined)).toBeUndefined();
    expect(readQueryString('')).toBeUndefined();
    expect(readQueryString('abc')).toBe('abc');
  });

  test('takes the last value of a repeated parameter', () => {
    expect(readQueryString(['first', 'second'])).toBe('second');
  });
});

describe('readBody', () => {
  test('returns an empty object when the body is missing', () => {
    expect(
      readBody({
        method: 'GET',
        path: '/',
        query: {},
        headers: {},
        params: {},
        originalRequest: new Request('http://localhost/'),
      } as RouteRequest)
    ).toEqual({});
  });

  test('returns the object body as-is', () => {
    expect(
      readBody({
        method: 'POST',
        path: '/',
        query: {},
        headers: {},
        params: {},
        body: { type: 'IPV4' },
        originalRequest: new Request('http://localhost/'),
      } as RouteRequest)
    ).toEqual({ type: 'IPV4' });
  });
});
