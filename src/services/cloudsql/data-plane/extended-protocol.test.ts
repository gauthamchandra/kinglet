/**
 * Tests for extended-query protocol namespacing
 */

import { describe, expect, test } from 'bun:test';
import {
  buildConnectionNamespace,
  isExtendedQueryFrame,
  namespaceFrameNames,
} from './extended-protocol.ts';

const NAMESPACE = 'conn-7/';

function frame(tag: string, body: Uint8Array): Uint8Array {
  const message = new Uint8Array(5 + body.length);

  message[0] = tag.charCodeAt(0);
  new DataView(message.buffer).setInt32(1, 4 + body.length);
  message.set(body, 5);

  return message;
}

const NUL = 0x00;

/** Build a frame body from NUL-terminated strings and raw byte runs. */
function bytes(...parts: (string | number[])[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks = parts.map(part =>
    typeof part === 'string'
      ? Uint8Array.from([...encoder.encode(part), NUL])
      : Uint8Array.from(part)
  );
  const combined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));

  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return combined;
}

/** The frame's declared length, which must always match its real size. */
function declaredLength(message: Uint8Array): number {
  return new DataView(message.buffer, message.byteOffset, message.byteLength).getInt32(1);
}

/** Frame body as text, with NUL terminators shown as `|`. */
function bodyText(message: Uint8Array): string {
  return Array.from(message.subarray(5), byte =>
    byte === NUL ? '|' : String.fromCharCode(byte)
  ).join('');
}

describe('isExtendedQueryFrame', () => {
  test('recognises the frames that make up an extended-query sequence', () => {
    for (const tag of ['P', 'B', 'D', 'E', 'C']) {
      expect(isExtendedQueryFrame(tag.charCodeAt(0))).toBe(true);
    }
  });

  test('does not claim frames that end a sequence', () => {
    for (const tag of ['S', 'Q', 'H', 'X', 'd', 'c']) {
      expect(isExtendedQueryFrame(tag.charCodeAt(0))).toBe(false);
    }
  });
});

describe('namespaceFrameNames', () => {
  test('prefixes the statement name in Parse and fixes the length', () => {
    const parse = frame('P', bytes('stmt1', 'SELECT 1', [0, 0]));
    const result = namespaceFrameNames(parse, NAMESPACE);

    expect(bodyText(result).startsWith('conn-7/stmt1|SELECT 1|')).toBe(true);
    expect(declaredLength(result)).toBe(result.length - 1);
  });

  test('prefixes both the portal and the statement in Bind', () => {
    const bind = frame('B', bytes('portal1', 'stmt1', [0, 0, 0, 0]));
    const result = namespaceFrameNames(bind, NAMESPACE);

    expect(bodyText(result).startsWith('conn-7/portal1|conn-7/stmt1|')).toBe(true);
    expect(declaredLength(result)).toBe(result.length - 1);
  });

  test('prefixes the name after the kind byte in Describe and Close', () => {
    for (const tag of ['D', 'C']) {
      const message = frame(tag, bytes([0x53], 'stmt1'));
      const result = namespaceFrameNames(message, NAMESPACE);

      expect(bodyText(result)).toBe('Sconn-7/stmt1|');
      expect(declaredLength(result)).toBe(result.length - 1);
    }
  });

  test('prefixes the portal in Execute and keeps the trailing row limit', () => {
    const execute = frame('E', bytes('portal1', [0, 0, 0, 5]));
    const result = namespaceFrameNames(execute, NAMESPACE);

    expect(bodyText(result).startsWith('conn-7/portal1|')).toBe(true);
    expect(result.length).toBe(execute.length + NAMESPACE.length);
    expect(declaredLength(result)).toBe(result.length - 1);
  });

  test('leaves the unnamed statement and portal unnamed', () => {
    // Naming these would turn something the backend discards on the next
    // Parse into something that accumulates for the life of the connection.
    const parse = frame('P', bytes('', 'SELECT 1', [0, 0]));
    const bind = frame('B', bytes('', '', [0, 0, 0, 0]));

    expect(namespaceFrameNames(parse, NAMESPACE)).toEqual(parse);
    expect(namespaceFrameNames(bind, NAMESPACE)).toEqual(bind);
  });

  test('prefixes only the named half of a mixed Bind', () => {
    const bind = frame('B', bytes('', 'stmt1', [0, 0, 0, 0]));
    const result = namespaceFrameNames(bind, NAMESPACE);

    expect(bodyText(result).startsWith('|conn-7/stmt1|')).toBe(true);
    expect(declaredLength(result)).toBe(result.length - 1);
  });

  test('leaves frames that name nothing untouched', () => {
    const sync = frame('S', new Uint8Array(0));
    const query = frame('Q', bytes('SELECT 1'));

    expect(namespaceFrameNames(sync, NAMESPACE)).toEqual(sync);
    expect(namespaceFrameNames(query, NAMESPACE)).toEqual(query);
  });

  test('leaves a truncated frame for the backend to reject', () => {
    // No NUL terminator: rewriting would have to guess where the name ends.
    const malformed = frame('P', Uint8Array.from([0x61, 0x62]));

    expect(namespaceFrameNames(malformed, NAMESPACE)).toEqual(malformed);
  });

  test('gives different connections different namespaces', () => {
    expect(buildConnectionNamespace('conn-1')).not.toBe(buildConnectionNamespace('conn-2'));
  });

  test('puts the prefix at the front so tail truncation cannot merge namespaces', () => {
    // Postgres truncates over-long names at the tail; a prefix at the front
    // keeps two connections distinct even after truncation.
    const long = 'x'.repeat(120);
    const first = namespaceFrameNames(frame('P', bytes(long, 'SELECT 1', [0, 0])), 'conn-1/');
    const second = namespaceFrameNames(frame('P', bytes(long, 'SELECT 1', [0, 0])), 'conn-2/');

    expect(bodyText(first).startsWith('conn-1/')).toBe(true);
    expect(bodyText(second).startsWith('conn-2/')).toBe(true);
  });
});
