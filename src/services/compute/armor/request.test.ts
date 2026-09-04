import { describe, expect, test } from 'bun:test';
import {
  buildRequestAttributes,
  canonicalizeIp,
  ipInCidr,
  isValidIp,
  parseFirstValidIp,
  withInspectedBody,
} from './request.ts';
import { ArmorError } from './types.ts';

describe('canonicalizeIp', () => {
  test('leaves canonical IPv4 unchanged', () => {
    expect(canonicalizeIp('192.0.2.10')).toBe('192.0.2.10');
  });

  test('rejects IPv4 octets with leading zeros', () => {
    expect(() => canonicalizeIp('192.168.001.001')).toThrow(ArmorError);
  });

  test('compresses IPv6 and drops leading zeros', () => {
    expect(canonicalizeIp('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
  });

  test('canonicalizes the unspecified and loopback addresses', () => {
    expect(canonicalizeIp('0:0:0:0:0:0:0:0')).toBe('::');
    expect(canonicalizeIp('0:0:0:0:0:0:0:1')).toBe('::1');
  });

  test('strips brackets and zone ids', () => {
    expect(canonicalizeIp('[2001:db8::1]')).toBe('2001:db8::1');
    expect(canonicalizeIp('fe80::1%eth0')).toBe('fe80::1');
  });

  test('formats IPv4-mapped IPv6 in dotted form', () => {
    expect(canonicalizeIp('::ffff:192.0.2.1')).toBe('::ffff:192.0.2.1');
  });

  test('throws INVALID_ARGUMENT for garbage', () => {
    expect(() => canonicalizeIp('not-an-ip')).toThrow(ArmorError);
    expect(() => canonicalizeIp('not-an-ip')).toThrow(/Invalid IP address/);
  });
});

describe('isValidIp / parseFirstValidIp', () => {
  test('accepts IPv4 and IPv6', () => {
    expect(isValidIp('203.0.113.5')).toBe(true);
    expect(isValidIp('2001:db8::2')).toBe(true);
    expect(isValidIp('999.1.1.1')).toBe(false);
    expect(isValidIp('')).toBe(false);
  });

  test('returns the first valid hop in a comma list', () => {
    expect(parseFirstValidIp('not-an-ip, 198.51.100.9, 203.0.113.1')).toBe('198.51.100.9');
    expect(parseFirstValidIp('nope, still-nope')).toBeNull();
  });
});

describe('ipInCidr', () => {
  test('matches IPv4 prefixes', () => {
    expect(ipInCidr('192.0.2.10', '192.0.2.0/24')).toBe(true);
    expect(ipInCidr('192.0.2.10', '192.0.3.0/24')).toBe(false);
    expect(ipInCidr('192.0.2.10', '192.0.2.10')).toBe(true);
  });

  test('matches IPv6 prefixes after canonicalization', () => {
    expect(ipInCidr('2001:db8::1', '2001:0db8::/32')).toBe(true);
    expect(ipInCidr('2001:db9::1', '2001:db8::/32')).toBe(false);
  });

  test('returns false for mixed families and invalid CIDRs', () => {
    expect(ipInCidr('192.0.2.1', '2001:db8::/32')).toBe(false);
    expect(ipInCidr('192.0.2.1', 'not-a-cidr')).toBe(false);
    expect(ipInCidr('10.1.2.3', '10.0.0.0/8junk')).toBe(false);
    expect(ipInCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
  });
});

describe('buildRequestAttributes', () => {
  test('uses the provided peer as origin.ip and ignores X-Forwarded-For', () => {
    const attrs = buildRequestAttributes({
      method: 'GET',
      path: '/x',
      originIp: '192.0.2.8',
      headers: {
        'X-Forwarded-For': '198.51.100.1',
      },
    });

    expect(attrs.origin.ip).toBe('192.0.2.8');
    expect(attrs.request.headers['x-forwarded-for']).toBe('198.51.100.1');
  });

  test('sets origin.user_ip from the first valid userIpRequestHeaders value', () => {
    const attrs = buildRequestAttributes({
      method: 'get',
      path: '/',
      originIp: '192.0.2.8',
      headers: {
        'True-Client-IP': 'not-valid',
        'X-Forwarded-For': '203.0.113.9, 198.51.100.1',
      },
      userIpRequestHeaders: ['True-Client-IP', 'X-Forwarded-For'],
    });

    expect(attrs.origin.userIp).toBe('203.0.113.9');
    expect(attrs.origin.userIpResolved).toBe(true);
  });

  test('falls back origin.user_ip to origin.ip when headers are missing or invalid', () => {
    const missing = buildRequestAttributes({
      method: 'GET',
      path: '/',
      originIp: '192.0.2.8',
      userIpRequestHeaders: ['True-Client-IP'],
    });

    const invalid = buildRequestAttributes({
      method: 'GET',
      path: '/',
      originIp: '192.0.2.8',
      headers: { 'True-Client-IP': 'nope' },
      userIpRequestHeaders: ['True-Client-IP'],
    });

    const unspecified = buildRequestAttributes({
      method: 'GET',
      path: '/',
      originIp: '192.0.2.8',
    });

    expect(missing.origin.userIp).toBe('192.0.2.8');
    expect(missing.origin.userIpResolved).toBe(false);
    expect(invalid.origin.userIp).toBe('192.0.2.8');
    expect(invalid.origin.userIpResolved).toBe(false);
    expect(unspecified.origin.userIp).toBe('192.0.2.8');
  });

  test('keeps path and raw query as given', () => {
    const attrs = buildRequestAttributes({
      method: 'GET',
      path: '/Admin%20Page',
      query: 'q=%2Fsecret&x=1',
      originIp: '192.0.2.1',
    });

    expect(attrs.request.path).toBe('/Admin%20Page');
    expect(attrs.request.query).toBe('q=%2Fsecret&x=1');
  });

  test('lowercases header names and comma-joins multi-value headers', () => {
    const attrs = buildRequestAttributes({
      method: 'GET',
      path: '/',
      originIp: '192.0.2.1',
      headers: {
        Host: 'app.example.com',
        Accept: ['text/html', 'application/json'],
      },
    });

    expect(attrs.request.headers.host).toBe('app.example.com');
    expect(attrs.request.headers.accept).toBe('text/html,application/json');
    expect(attrs.request.headers.Host).toBeUndefined();
  });

  test('uppercases method and lowercases scheme', () => {
    const attrs = buildRequestAttributes({
      method: 'post',
      path: '/',
      originIp: '192.0.2.1',
      scheme: 'HTTPS',
    });

    expect(attrs.request.method).toBe('POST');
    expect(attrs.request.scheme).toBe('https');
  });

  test('leaves asn, region, ja3, ja4, and sni empty unless supplied', () => {
    const empty = buildRequestAttributes({
      method: 'GET',
      path: '/',
      originIp: '8.8.8.8',
    });

    const supplied = buildRequestAttributes({
      method: 'GET',
      path: '/',
      originIp: '8.8.8.8',
      asn: 15169,
      regionCode: 'US',
      tlsJa3Fingerprint: 'deadbeef',
      tlsJa4Fingerprint: 't13d',
      sni: 'app.example.com',
    });

    expect(empty.origin.asn).toBe(0);
    expect(empty.origin.regionCode).toBe('');
    expect(empty.origin.tlsJa3Fingerprint).toBe('');
    expect(empty.origin.tlsJa4Fingerprint).toBe('');
    expect(empty.sni).toBe('');
    expect(supplied.origin.asn).toBe(15169);
    expect(supplied.origin.regionCode).toBe('US');
    expect(supplied.origin.tlsJa3Fingerprint).toBe('deadbeef');
    expect(supplied.origin.tlsJa4Fingerprint).toBe('t13d');
    expect(supplied.sni).toBe('app.example.com');
  });

  test('canonicalizes origin.ip IPv6', () => {
    const attrs = buildRequestAttributes({
      method: 'GET',
      path: '/',
      originIp: '2001:0db8:0000::1',
    });

    expect(attrs.origin.ip).toBe('2001:db8::1');
  });

  test('does not invent an X-Forwarded-For header', () => {
    const attrs = buildRequestAttributes({
      method: 'GET',
      path: '/',
      originIp: '192.0.2.1',
    });

    expect(attrs.request.headers['x-forwarded-for']).toBeUndefined();
  });

  test('leaves JSON body out of request.params when jsonParsing is disabled', () => {
    const attrs = buildRequestAttributes({
      method: 'POST',
      path: '/',
      originIp: '192.0.2.1',
      query: 'q=one',
      body: '{"city":"NewYork"}',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(attrs.request.params.q).toBe('one');
    expect(attrs.request.params.city).toBeUndefined();
  });

  test('parses query and JSON body into string params when jsonParsing is STANDARD', () => {
    const attrs = buildRequestAttributes({
      method: 'POST',
      path: '/',
      originIp: '192.0.2.1',
      query: 'q=one',
      body: '{"city":"NewYork","n":1,"ok":true}',
      headers: { 'Content-Type': 'Application/JSON; charset=utf-8' },
      jsonParsing: 'STANDARD',
    });

    expect(attrs.request.params.q).toBe('one');
    expect(attrs.request.params.city).toBe('NewYork');
    expect(attrs.request.params.n).toBe('1');
    expect(attrs.request.params.ok).toBe('true');
  });

  test('does not treat application/jsonp as JSON', () => {
    const attrs = buildRequestAttributes({
      method: 'POST',
      path: '/',
      originIp: '192.0.2.1',
      body: '{"city":"NewYork"}',
      headers: { 'content-type': 'application/jsonp' },
      jsonParsing: 'STANDARD',
    });

    expect(attrs.request.params.city).toBeUndefined();
  });

  test('withInspectedBody drops params that sit past the inspection window', () => {
    const attrs = buildRequestAttributes({
      method: 'POST',
      path: '/',
      originIp: '127.0.0.1',
      query: 'q=keep',
      body: `${'x'.repeat(32)}secret=UNIQUE-TAIL`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const inspected = withInspectedBody(attrs, 32);

    expect(inspected.request.body).toBe('x'.repeat(32));
    expect(inspected.request.params.q).toBe('keep');
    expect(inspected.request.params.secret).toBeUndefined();
  });

  test('withInspectedBody keeps complete JSON keys inside a truncated prefix', () => {
    const visible = '{"keep":"yes","cut":"';
    const attrs = buildRequestAttributes({
      method: 'POST',
      path: '/',
      originIp: '127.0.0.1',
      query: 'q=keep',
      body: `${visible}${'x'.repeat(40)}"}`,
      headers: { 'content-type': 'application/json' },
      jsonParsing: 'STANDARD',
    });
    const inspected = withInspectedBody(attrs, visible.length, 'STANDARD');

    expect(inspected.request.params.q).toBe('keep');
    expect(inspected.request.params.keep).toBe('yes');
    expect(inspected.request.params.cut).toBeUndefined();
  });
});
