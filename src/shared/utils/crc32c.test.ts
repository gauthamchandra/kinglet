import { describe, expect, test } from 'bun:test';
import { crc32c, crc32cBase64, crc32cString } from './crc32c.ts';

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('crc32c', () => {
  test('returns 0 for empty input', () => {
    expect(crc32c(new Uint8Array(0))).toBe(0);
  });

  test('matches the canonical CRC-32C check value for "123456789"', () => {
    // 0xE3069283 is the published Castagnoli check value; a wrong polynomial
    // (e.g. IEEE) would not produce this.
    expect(crc32c(encode('123456789'))).toBe(0xe3069283);
  });

  test('is deterministic and order-sensitive', () => {
    expect(crc32c(encode('hello'))).toBe(crc32c(encode('hello')));
    expect(crc32c(encode('hello'))).not.toBe(crc32c(encode('olleh')));
  });

  test('returns an unsigned 32-bit integer even when the high bit is set', () => {
    const value = crc32c(encode('123456789'));

    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('crc32cString', () => {
  test('formats the checksum as a base-10 string (KMS Int64 wire form)', () => {
    expect(crc32cString(encode('123456789'))).toBe('3808858755');
  });
});

describe('crc32cBase64', () => {
  test('formats the checksum as 4-byte big-endian base64 (GCS object hash form)', () => {
    expect(crc32cBase64(encode('123456789'))).toBe('4waSgw==');
  });
});
