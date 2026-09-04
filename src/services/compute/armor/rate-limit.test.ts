import { beforeEach, describe, expect, test } from 'bun:test';
import {
  applyRateLimit,
  assertRateLimitActionTransition,
  buildClientKey,
  resetRateLimitStore,
  setRateLimitClock,
  VALID_BAN_DURATION_SEC,
  VALID_INTERVAL_SEC,
  validateRateLimitOptions,
} from './rate-limit.ts';
import { buildRequestAttributes } from './request.ts';
import type { RateLimitOptions, RequestAttributeInput, RequestAttributes } from './types.ts';
import { ArmorError } from './types.ts';

function attrs(overrides: Partial<RequestAttributeInput> = {}): RequestAttributes {
  const input: RequestAttributeInput = {
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/x',
    originIp: overrides.originIp ?? '127.0.0.1',
  };

  if (overrides.query != null) input.query = overrides.query;
  if (overrides.headers != null) input.headers = overrides.headers;
  if (overrides.body != null) input.body = overrides.body;
  if (overrides.scheme != null) input.scheme = overrides.scheme;
  if (overrides.asn != null) input.asn = overrides.asn;
  if (overrides.regionCode != null) input.regionCode = overrides.regionCode;
  if (overrides.tlsJa3Fingerprint != null) input.tlsJa3Fingerprint = overrides.tlsJa3Fingerprint;
  if (overrides.tlsJa4Fingerprint != null) input.tlsJa4Fingerprint = overrides.tlsJa4Fingerprint;
  if (overrides.sni != null) input.sni = overrides.sni;
  if (overrides.userIpRequestHeaders != null) {
    input.userIpRequestHeaders = overrides.userIpRequestHeaders;
  }

  return buildRequestAttributes(input);
}

function throttleOptions(overrides: RateLimitOptions = {}): RateLimitOptions {
  return {
    rateLimitThreshold: { count: 2, intervalSec: 60 },
    conformAction: 'allow',
    exceedAction: 'deny(429)',
    ...overrides,
  };
}

describe('validateRateLimitOptions', () => {
  test('accepts documented intervalSec and banDurationSec values', () => {
    expect(VALID_INTERVAL_SEC).toEqual([
      10, 30, 60, 120, 180, 240, 300, 600, 900, 1200, 1800, 2700, 3600,
    ]);
    expect(VALID_BAN_DURATION_SEC).toEqual([
      60, 120, 180, 240, 300, 600, 900, 1200, 1800, 2700, 3600,
    ]);

    expect(() => validateRateLimitOptions('throttle', throttleOptions())).not.toThrow();
  });

  test('rejects intervalSec outside the allowed set', () => {
    expect(() =>
      validateRateLimitOptions(
        'throttle',
        throttleOptions({
          rateLimitThreshold: { count: 1, intervalSec: 15 },
        })
      )
    ).toThrow('Invalid intervalSec: 15');
  });

  test('rejects throttle counts outside 1–1000000 and ban counts outside 1–10000', () => {
    expect(() =>
      validateRateLimitOptions(
        'throttle',
        throttleOptions({
          rateLimitThreshold: { count: 0, intervalSec: 60 },
        })
      )
    ).toThrow('rateLimitThreshold.count must be between 1 and 1000000');

    expect(() =>
      validateRateLimitOptions('rate_based_ban', {
        rateLimitThreshold: { count: 10001, intervalSec: 60 },
        banDurationSec: 60,
      })
    ).toThrow('rateLimitThreshold.count must be between 1 and 10000');
  });

  test('rejects more than 3 enforceOnKeyConfigs and enforceOnKey when configs are set', () => {
    expect(() =>
      validateRateLimitOptions(
        'throttle',
        throttleOptions({
          enforceOnKeyConfigs: [
            { enforceOnKeyType: 'IP' },
            { enforceOnKeyType: 'HTTP_PATH' },
            { enforceOnKeyType: 'REGION_CODE' },
            { enforceOnKeyType: 'ALL' },
          ],
        })
      )
    ).toThrow('A maximum of 3 enforceOnKeyConfigs are allowed');

    expect(() =>
      validateRateLimitOptions(
        'throttle',
        throttleOptions({
          enforceOnKey: 'IP',
          enforceOnKeyConfigs: [{ enforceOnKeyType: 'IP' }],
        })
      )
    ).toThrow('enforceOnKey must be empty when enforceOnKeyConfigs is set');
  });

  test('rejects invalid banDurationSec', () => {
    expect(() =>
      validateRateLimitOptions('rate_based_ban', {
        rateLimitThreshold: { count: 1, intervalSec: 60 },
        banDurationSec: 30,
      })
    ).toThrow('Invalid banDurationSec: 30');
  });
});

describe('assertRateLimitActionTransition', () => {
  test('allows throttle to rate_based_ban and rejects the reverse', () => {
    expect(() => assertRateLimitActionTransition('throttle', 'rate_based_ban')).not.toThrow();

    let thrown: unknown;

    try {
      assertRateLimitActionTransition('rate_based_ban', 'throttle');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ArmorError);
    expect(thrown).toHaveProperty('status', 'INVALID_ARGUMENT');
  });
});

describe('applyRateLimit', () => {
  let now = 1_000_000;

  beforeEach(() => {
    resetRateLimitStore();
    now = 1_000_000;
    setRateLimitClock(() => now);
  });

  test('throttle conforms until the threshold is exceeded', () => {
    const options = throttleOptions();
    const request = attrs();

    expect(applyRateLimit('p', 1000, 'throttle', options, request)).toBe('allow');
    expect(applyRateLimit('p', 1000, 'throttle', options, request)).toBe('allow');
    expect(applyRateLimit('p', 1000, 'throttle', options, request)).toBe('deny(429)');
    expect(applyRateLimit('p', 1000, 'throttle', options, request)).toBe('deny(429)');
  });

  test('throttle window resets after intervalSec', () => {
    const options = throttleOptions({
      rateLimitThreshold: { count: 1, intervalSec: 60 },
    });
    const request = attrs();

    expect(applyRateLimit('p', 1, 'throttle', options, request)).toBe('allow');
    expect(applyRateLimit('p', 1, 'throttle', options, request)).toBe('deny(429)');

    now += 60_000;

    expect(applyRateLimit('p', 1, 'throttle', options, request)).toBe('allow');
  });

  test('rate_based_ban bans the key for banDurationSec', () => {
    const options: RateLimitOptions = {
      rateLimitThreshold: { count: 1, intervalSec: 60 },
      banDurationSec: 60,
      exceedAction: 'deny(429)',
    };
    const request = attrs();

    expect(applyRateLimit('p', 2, 'rate_based_ban', options, request)).toBe('allow');
    expect(applyRateLimit('p', 2, 'rate_based_ban', options, request)).toBe('deny(429)');

    now += 30_000;

    expect(applyRateLimit('p', 2, 'rate_based_ban', options, request)).toBe('deny(429)');

    now += 31_000;

    expect(applyRateLimit('p', 2, 'rate_based_ban', options, request)).toBe('allow');
  });

  test('banThreshold counts all requests before throttle', () => {
    const options: RateLimitOptions = {
      rateLimitThreshold: { count: 100, intervalSec: 60 },
      banThreshold: { count: 2, intervalSec: 60 },
      banDurationSec: 60,
      exceedAction: 'deny(403)',
    };
    const request = attrs();

    expect(applyRateLimit('p', 3, 'rate_based_ban', options, request)).toBe('allow');
    expect(applyRateLimit('p', 3, 'rate_based_ban', options, request)).toBe('allow');
    expect(applyRateLimit('p', 3, 'rate_based_ban', options, request)).toBe('deny(403)');
  });

  test('distinct IPs have distinct IP keys', () => {
    const options = throttleOptions({
      enforceOnKey: 'IP',
      rateLimitThreshold: { count: 1, intervalSec: 60 },
    });

    expect(applyRateLimit('p', 4, 'throttle', options, attrs({ originIp: '192.0.2.1' }))).toBe(
      'allow'
    );
    expect(applyRateLimit('p', 4, 'throttle', options, attrs({ originIp: '192.0.2.2' }))).toBe(
      'allow'
    );
    expect(applyRateLimit('p', 4, 'throttle', options, attrs({ originIp: '192.0.2.1' }))).toBe(
      'deny(429)'
    );
  });

  test('missing HTTP_HEADER degrades that component to ALL', () => {
    const options = throttleOptions({
      enforceOnKey: 'HTTP_HEADER',
      enforceOnKeyName: 'x-api-key',
      rateLimitThreshold: { count: 1, intervalSec: 60 },
    });

    expect(applyRateLimit('p', 5, 'throttle', options, attrs({ originIp: '192.0.2.1' }))).toBe(
      'allow'
    );
    expect(applyRateLimit('p', 5, 'throttle', options, attrs({ originIp: '192.0.2.9' }))).toBe(
      'deny(429)'
    );
  });

  test('unresolvable USER_IP degrades to IP', () => {
    const options = throttleOptions({
      enforceOnKey: 'USER_IP',
      rateLimitThreshold: { count: 1, intervalSec: 60 },
    });

    const a = attrs({ originIp: '192.0.2.4' });
    const b = attrs({ originIp: '192.0.2.4', userIpRequestHeaders: ['x-real-ip'] });

    expect(buildClientKey(options, a)).toBe(buildClientKey({ enforceOnKey: 'IP' }, a));
    expect(applyRateLimit('p', 6, 'throttle', options, a)).toBe('allow');
    expect(applyRateLimit('p', 6, 'throttle', options, b)).toBe('deny(429)');
  });

  test('XFF_IP uses the leftmost valid hop and falls back to IP', () => {
    const options = throttleOptions({
      enforceOnKey: 'XFF_IP',
      rateLimitThreshold: { count: 1, intervalSec: 60 },
    });

    const withXff = attrs({
      originIp: '192.0.2.8',
      headers: { 'X-Forwarded-For': '203.0.113.9, 198.51.100.1' },
    });
    const without = attrs({ originIp: '192.0.2.8' });

    expect(buildClientKey(options, withXff)).toBe('XFF_IP:203.0.113.9');
    expect(buildClientKey(options, without)).toBe('IP:192.0.2.8');
  });

  test('HTTP_COOKIE missing degrades to ALL and values truncate at 128 bytes', () => {
    const options = throttleOptions({
      enforceOnKey: 'HTTP_COOKIE',
      enforceOnKeyName: 'sid',
    });
    const long = 'a'.repeat(200);
    const withCookie = attrs({
      headers: { cookie: `sid=${long}` },
    });

    expect(buildClientKey(options, attrs())).toBe('ALL');
    expect(buildClientKey(options, withCookie).endsWith('a'.repeat(128))).toBe(true);
    expect(buildClientKey(options, withCookie).length).toBe('HTTP_COOKIE:sid='.length + 128);
  });

  test('up to 3 enforceOnKeyConfigs form one composite key', () => {
    const options = throttleOptions({
      enforceOnKeyConfigs: [
        { enforceOnKeyType: 'IP' },
        { enforceOnKeyType: 'HTTP_PATH' },
        { enforceOnKeyType: 'REGION_CODE' },
      ],
    });
    const request = attrs({ path: '/a', regionCode: 'US' });

    expect(buildClientKey(options, request)).toBe('IP:127.0.0.1|HTTP_PATH:/a|REGION_CODE:US');
  });

  test('SNI and JA fingerprints degrade to ALL when empty', () => {
    expect(buildClientKey({ enforceOnKey: 'SNI' }, attrs())).toBe('ALL');
    expect(buildClientKey({ enforceOnKey: 'TLS_JA3_FINGERPRINT' }, attrs())).toBe('ALL');
    expect(buildClientKey({ enforceOnKey: 'TLS_JA4_FINGERPRINT' }, attrs())).toBe('ALL');
    expect(buildClientKey({ enforceOnKey: 'SNI' }, attrs({ sni: 'app.example.com' }))).toBe(
      'SNI:app.example.com'
    );
  });

  test('resetRateLimitStore clears counters between cases', () => {
    const options = throttleOptions({
      rateLimitThreshold: { count: 1, intervalSec: 60 },
    });

    expect(applyRateLimit('p', 9, 'throttle', options, attrs())).toBe('allow');
    resetRateLimitStore();
    setRateLimitClock(() => now);
    expect(applyRateLimit('p', 9, 'throttle', options, attrs())).toBe('allow');
  });
});
