/**
 * Per-connection namespacing for extended-query protocol frames.
 *
 * <p>Every connection to one emulated database shares a single PGlite backend,
 * and a Postgres backend keeps prepared statements and portals in one
 * session-wide namespace. Clients do not expect to share that namespace: both
 * `Bun.SQL` and node-postgres derive a statement name from the query text, so
 * two connections issuing the same parameterised query — the most ordinary
 * thing a connection pool does — would each `Parse` the same name and the
 * second would be rejected with `42P05 duplicate_prepared_statement`.
 *
 * <p>Rewriting the names on the way through gives each connection its own
 * namespace without the client knowing. The prefix goes at the FRONT because
 * Postgres truncates over-long names at the tail: two long names from
 * different connections still differ after truncation.
 *
 * <p>The unnamed statement and portal (empty name) are deliberately left
 * alone. They are session-scoped by design and replaced by the next `Parse` or
 * `Bind`, so naming them would turn something the backend discards into
 * something that accumulates forever. They are protected instead by sending a
 * connection's whole extended-query sequence to the backend as one unit —
 * see `collectsUntilSyncPoint`.
 *
 * <p>Nothing here is Cloud-SQL-specific, so AlloyDB can reuse it.
 */

const PARSE = 0x50; // 'P'
const BIND = 0x42; // 'B'
const DESCRIBE = 0x44; // 'D'
const EXECUTE = 0x45; // 'E'
const CLOSE = 0x43; // 'C'

/**
 * Frames that name a prepared statement or portal, and how many leading
 * C-strings of the body are names. `Describe` and `Close` carry a one-byte
 * kind ('S' or 'P') before the name.
 */
const NAME_BEARING_FRAMES = new Map<number, { skipBytes: number; nameCount: number }>([
  [PARSE, { skipBytes: 0, nameCount: 1 }], // statement, then the query text
  [BIND, { skipBytes: 0, nameCount: 2 }], // portal, then statement
  [DESCRIBE, { skipBytes: 1, nameCount: 1 }],
  [CLOSE, { skipBytes: 1, nameCount: 1 }],
  [EXECUTE, { skipBytes: 0, nameCount: 1 }], // portal
]);

/**
 * Frames that are part of an extended-query sequence and must reach the
 * backend together with the rest of it, rather than being interleaved with
 * another connection's messages.
 */
export function isExtendedQueryFrame(tag: number): boolean {
  return NAME_BEARING_FRAMES.has(tag);
}

export function buildConnectionNamespace(connectionId: string): string {
  // Short, and containing a character a client would not put in a generated
  // statement name, so a rewritten name cannot collide with a client's own.
  return `${connectionId}/`;
}

/**
 * Rewrite the statement and portal names in one frame so they belong to this
 * connection alone. Frames that name nothing are returned unchanged.
 */
export function namespaceFrameNames(frame: Uint8Array, namespace: string): Uint8Array {
  const layout = NAME_BEARING_FRAMES.get(frame[0] ?? 0);

  if (!layout) return frame;

  const bodyStart = 5 + layout.skipBytes;
  const names: { start: number; end: number }[] = [];

  let offset = bodyStart;

  for (let index = 0; index < layout.nameCount; index++) {
    const end = frame.indexOf(0, offset);

    // A truncated or malformed frame is left untouched; the backend will
    // reject it far more precisely than this rewriting could.
    if (end < 0) return frame;

    names.push({ start: offset, end });
    offset = end + 1;
  }

  // The unnamed statement and portal stay unnamed.
  if (names.every(name => name.end === name.start)) return frame;

  const encoder = new TextEncoder();
  const prefix = encoder.encode(namespace);
  const named = names.filter(name => name.end > name.start);
  const rewritten = new Uint8Array(frame.length + prefix.length * named.length);
  const view = new DataView(rewritten.buffer);

  let source = 0;
  let target = 0;

  for (const name of names) {
    const upTo = name.start;

    rewritten.set(frame.subarray(source, upTo), target);
    target += upTo - source;
    source = upTo;

    if (name.end > name.start) {
      rewritten.set(prefix, target);
      target += prefix.length;
    }
  }

  rewritten.set(frame.subarray(source), target);

  // The length field covers everything after the tag, so it grows by exactly
  // what the prefixes added.
  view.setInt32(1, rewritten.length - 1);

  return rewritten;
}
