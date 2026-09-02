/**
 * Tests for PostgresWireServer
 *
 * The server is driven end-to-end over a real socket with hand-built protocol
 * frames, because the thing worth testing is what a Postgres client would
 * actually observe on the wire. The database behind it is a fake queue: PGlite
 * has its own coverage, and booting wasm Postgres per case would swamp these.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { PGliteSessionQueue } from './pglite-session-queue.ts';
import type { ConnectionResolution, ResolvedConnection } from './postgres-wire-server.ts';
import {
  buildErrorResponse,
  PostgresWireServer,
  parseStartupPacket,
  SQLSTATE_INVALID_AUTHORIZATION_SPECIFICATION,
  SQLSTATE_INVALID_CATALOG_NAME,
  SQLSTATE_INVALID_PASSWORD,
  SQLSTATE_PROTOCOL_VIOLATION,
} from './postgres-wire-server.ts';

const TEST_PORT_BASE = 45900;

let nextTestPort = TEST_PORT_BASE;

// ── Frame builders (the client side of the protocol) ──

function buildStartupPacket(parameters: Record<string, string>, version = 196608): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  for (const [key, value] of Object.entries(parameters)) {
    parts.push(encoder.encode(`${key}\0${value}\0`));
  }

  const bodyLength = parts.reduce((total, part) => total + part.length, 0) + 1;
  const packet = new Uint8Array(8 + bodyLength);
  const view = new DataView(packet.buffer);

  view.setInt32(0, packet.length);
  view.setInt32(4, version);

  let offset = 8;

  for (const part of parts) {
    packet.set(part, offset);
    offset += part.length;
  }

  return packet;
}

function buildRequestPacket(code: number): Uint8Array {
  const packet = new Uint8Array(8);
  const view = new DataView(packet.buffer);

  view.setInt32(0, 8);
  view.setInt32(4, code);

  return packet;
}

function buildTaggedMessage(tag: string, body: Uint8Array): Uint8Array {
  const message = new Uint8Array(5 + body.length);

  message[0] = tag.charCodeAt(0);
  new DataView(message.buffer).setInt32(1, 4 + body.length);
  message.set(body, 5);

  return message;
}

function buildPasswordMessage(password: string): Uint8Array {
  return buildTaggedMessage('p', new TextEncoder().encode(`${password}\0`));
}

/** A Parse frame body: statement name, query text, then a zero parameter count. */
function buildParseBody(name: string, sql: string): Uint8Array {
  const encoder = new TextEncoder();
  const named = encoder.encode(name);
  const query = encoder.encode(sql);
  const body = new Uint8Array(named.length + 1 + query.length + 1 + 2);

  body.set(named, 0);
  body.set(query, named.length + 1);

  return body;
}

function buildQueryMessage(sql: string): Uint8Array {
  return buildTaggedMessage('Q', new TextEncoder().encode(`${sql}\0`));
}

/** Split a backend byte stream into `[tag, body]` pairs. */
function readBackendMessages(bytes: Uint8Array): { tag: string; body: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const messages: { tag: string; body: Uint8Array }[] = [];

  let offset = 0;

  while (offset + 5 <= bytes.length) {
    const length = view.getInt32(offset + 1);

    messages.push({
      tag: String.fromCharCode(bytes[offset] ?? 0),
      body: bytes.subarray(offset + 5, offset + 1 + length),
    });

    offset += 1 + length;
  }

  return messages;
}

function readErrorFields(body: Uint8Array): Record<string, string> {
  const fields: Record<string, string> = {};
  const decoder = new TextDecoder();

  let offset = 0;

  while (offset < body.length && body[offset] !== 0) {
    const end = body.indexOf(0, offset);
    const code = String.fromCharCode(body[offset] ?? 0);

    fields[code] = decoder.decode(body.subarray(offset + 1, end));
    offset = end + 1;
  }

  return fields;
}

// ── Test doubles ──

/** Echoes back what it was asked to run, so pass-through is observable. */
function makeFakeQueue(): { queue: PGliteSessionQueue; received: string[] } {
  const received: string[] = [];
  const queue = {
    enqueue: async (
      _connectionId: string,
      bytes: Uint8Array,
      onData: (data: Uint8Array) => void
    ) => {
      received.push(new TextDecoder().decode(bytes).replace(/\0/g, '·'));
      onData(buildTaggedMessage('Z', new Uint8Array([0x49])));
    },
    detach: async () => {},
  };

  return { queue: queue as unknown as PGliteSessionQueue, received };
}

function allow(queue: PGliteSessionQueue, password: string): ConnectionResolution {
  const connection: ResolvedConnection = { queue, password };

  return { allowed: true, connection };
}

/** A raw client that accumulates everything the server sends. */
class TestClient {
  private socket: Awaited<ReturnType<typeof Bun.connect>> | null = null;
  private received = new Uint8Array(0);
  // Unwritten bytes. The server pauses reading under load, so writes are
  // accepted only partially and the remainder has to go out on drain — a real
  // client has to do this, and ignoring it would silently lose data.
  private unwritten = new Uint8Array(0);

  static async connect(port: number): Promise<TestClient> {
    const client = new TestClient();

    client.socket = await Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        data: (_socket, chunk) => {
          const combined = new Uint8Array(client.received.length + chunk.length);

          combined.set(client.received);
          combined.set(chunk, client.received.length);
          client.received = combined;
        },
        drain: () => {
          client.flush();
        },
        open() {},
        close() {},
        error() {},
      },
    });

    return client;
  }

  send(bytes: Uint8Array): void {
    const combined = new Uint8Array(this.unwritten.length + bytes.length);

    combined.set(this.unwritten);
    combined.set(bytes, this.unwritten.length);
    this.unwritten = combined;

    this.flush();
  }

  private flush(): void {
    if (!this.socket || this.unwritten.length === 0) return;

    const written = this.socket.write(this.unwritten);

    this.unwritten = this.unwritten.slice(written);
  }

  /** Wait until at least one more byte arrives than the caller has seen. */
  async waitForBytes(atLeast: number): Promise<Uint8Array> {
    const deadline = Date.now() + 2000;

    while (this.received.length < atLeast && Date.now() < deadline) {
      await Bun.sleep(5);
    }

    return this.received;
  }

  async waitForMessages(
    count: number,
    timeoutMs = 2000
  ): Promise<{ tag: string; body: Uint8Array }[]> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const messages = readBackendMessages(this.received);

      if (messages.length >= count) return messages;

      await Bun.sleep(5);
    }

    return readBackendMessages(this.received);
  }

  close(): void {
    this.socket?.end();
  }
}

let servers: PostgresWireServer[] = [];

function startServer(
  resolveConnection: (
    instanceKey: string,
    database: string,
    user: string
  ) => Promise<ConnectionResolution>
): number {
  const port = nextTestPort++;
  const server = new PostgresWireServer({
    instanceKey: 'p1/inst',
    port,
    resolveConnection,
  });

  server.listen();
  servers.push(server);

  return port;
}

afterEach(() => {
  for (const server of servers) server.stop();

  servers = [];
});

describe('parseStartupPacket', () => {
  test('reads the protocol version and parameters', () => {
    const parsed = parseStartupPacket(buildStartupPacket({ user: 'postgres', database: 'app' }));

    expect(parsed).toEqual({
      kind: 'startup',
      protocolVersion: 196608,
      parameters: { user: 'postgres', database: 'app' },
    });
  });

  test('recognises the SSL, GSSENC and cancel magic codes', () => {
    expect(parseStartupPacket(buildRequestPacket(80877103)).kind).toBe('ssl-request');
    expect(parseStartupPacket(buildRequestPacket(80877104)).kind).toBe('gssenc-request');
    expect(parseStartupPacket(buildRequestPacket(80877102)).kind).toBe('cancel-request');
  });

  test('throws on a packet too short to hold its own header', () => {
    expect(() => parseStartupPacket(new Uint8Array(4))).toThrow('shorter than its fixed header');
  });

  test('throws on an unterminated parameter value', () => {
    const truncated = buildStartupPacket({ user: 'postgres' }).subarray(0, 15);

    expect(() => parseStartupPacket(truncated)).toThrow('Unterminated parameter value');
  });
});

describe('buildErrorResponse', () => {
  test('frames a FATAL error carrying the SQLSTATE and message', () => {
    const [message] = readBackendMessages(buildErrorResponse('28P01', 'nope'));

    expect(message?.tag).toBe('E');
    expect(readErrorFields(message?.body ?? new Uint8Array(0))).toEqual({
      S: 'FATAL',
      V: 'FATAL',
      C: '28P01',
      M: 'nope',
    });
  });
});

describe('PostgresWireServer', () => {
  test('refuses SSL negotiation with a single N so the client falls back to plaintext', async () => {
    const { queue } = makeFakeQueue();
    const port = startServer(async () => allow(queue, ''));
    const client = await TestClient.connect(port);

    client.send(buildRequestPacket(80877103));

    expect(await client.waitForBytes(1)).toEqual(new Uint8Array([0x4e]));

    client.close();
  });

  test('drops a cancel request without answering it', async () => {
    const { queue } = makeFakeQueue();
    const port = startServer(async () => allow(queue, ''));
    const client = await TestClient.connect(port);

    client.send(buildRequestPacket(80877102));

    await Bun.sleep(50);

    expect(await client.waitForBytes(0)).toHaveLength(0);

    client.close();
  });

  test('forwards the startup packet straight through when the user has no password', async () => {
    const { queue, received } = makeFakeQueue();
    const port = startServer(async () => allow(queue, ''));
    const client = await TestClient.connect(port);

    client.send(buildStartupPacket({ user: 'postgres', database: 'postgres' }));

    const messages = await client.waitForMessages(1);

    expect(messages[0]?.tag).toBe('Z');
    expect(received[0]).toContain('user·postgres');
  });

  test('completes a cleartext password exchange and then passes queries through', async () => {
    const { queue, received } = makeFakeQueue();
    const port = startServer(async () => allow(queue, 's3cret'));
    const client = await TestClient.connect(port);

    client.send(buildStartupPacket({ user: 'postgres', database: 'postgres' }));

    const challenge = await client.waitForMessages(1);

    expect(challenge[0]?.tag).toBe('R');
    expect(
      new DataView(
        challenge[0]?.body.buffer as ArrayBuffer,
        challenge[0]?.body.byteOffset
      ).getInt32(0)
    ).toBe(3);

    client.send(buildPasswordMessage('s3cret'));

    await client.waitForMessages(2);

    client.send(buildQueryMessage('SELECT 1'));

    const messages = await client.waitForMessages(3);

    expect(messages.map(message => message.tag)).toEqual(['R', 'Z', 'Z']);
    expect(received[1]).toContain('SELECT 1');
  });

  test('rejects a wrong password with SQLSTATE 28P01', async () => {
    const { queue } = makeFakeQueue();
    const port = startServer(async () => allow(queue, 's3cret'));
    const client = await TestClient.connect(port);

    client.send(buildStartupPacket({ user: 'postgres', database: 'postgres' }));
    await client.waitForMessages(1);

    client.send(buildPasswordMessage('wrong'));

    const messages = await client.waitForMessages(2);
    const error = messages[1];

    expect(error?.tag).toBe('E');
    expect(readErrorFields(error?.body ?? new Uint8Array(0)).C).toBe(SQLSTATE_INVALID_PASSWORD);
  });

  test('rejects an unknown database with SQLSTATE 3D000', async () => {
    const port = startServer(async () => ({
      allowed: false,
      rejection: {
        sqlState: SQLSTATE_INVALID_CATALOG_NAME,
        message: 'database "nope" does not exist',
      },
    }));
    const client = await TestClient.connect(port);

    client.send(buildStartupPacket({ user: 'postgres', database: 'nope' }));

    const messages = await client.waitForMessages(1);

    expect(readErrorFields(messages[0]?.body ?? new Uint8Array(0))).toMatchObject({
      C: SQLSTATE_INVALID_CATALOG_NAME,
      M: 'database "nope" does not exist',
    });
  });

  test('rejects an unknown user with SQLSTATE 28000', async () => {
    const port = startServer(async () => ({
      allowed: false,
      rejection: {
        sqlState: SQLSTATE_INVALID_AUTHORIZATION_SPECIFICATION,
        message: 'role "ghost" does not exist',
      },
    }));
    const client = await TestClient.connect(port);

    client.send(buildStartupPacket({ user: 'ghost', database: 'postgres' }));

    const messages = await client.waitForMessages(1);

    expect(readErrorFields(messages[0]?.body ?? new Uint8Array(0)).C).toBe(
      SQLSTATE_INVALID_AUTHORIZATION_SPECIFICATION
    );
  });

  test('rejects a startup packet with no user name', async () => {
    const { queue } = makeFakeQueue();
    const port = startServer(async () => allow(queue, ''));
    const client = await TestClient.connect(port);

    client.send(buildStartupPacket({ database: 'postgres' }));

    const messages = await client.waitForMessages(1);

    expect(readErrorFields(messages[0]?.body ?? new Uint8Array(0))).toMatchObject({
      C: SQLSTATE_INVALID_AUTHORIZATION_SPECIFICATION,
      M: 'no PostgreSQL user name specified in startup packet',
    });
  });

  test('rejects a frontend protocol other than 3.0', async () => {
    const { queue } = makeFakeQueue();
    const port = startServer(async () => allow(queue, ''));
    const client = await TestClient.connect(port);

    client.send(buildStartupPacket({ user: 'postgres' }, 131072));

    const messages = await client.waitForMessages(1);

    expect(readErrorFields(messages[0]?.body ?? new Uint8Array(0)).C).toBe(
      SQLSTATE_PROTOCOL_VIOLATION
    );
  });

  test('defaults the database to the user name when the client omits it', async () => {
    const databases: string[] = [];
    const { queue } = makeFakeQueue();
    const port = startServer(async (_instanceKey, database) => {
      databases.push(database);

      return allow(queue, '');
    });
    const client = await TestClient.connect(port);

    client.send(buildStartupPacket({ user: 'appuser' }));
    await client.waitForMessages(1);

    expect(databases).toEqual(['appuser']);
  });

  test('rejects a frame claiming an impossible length', async () => {
    const { queue } = makeFakeQueue();
    const port = startServer(async () => allow(queue, ''));
    const client = await TestClient.connect(port);
    const bogus = new Uint8Array(8);

    new DataView(bogus.buffer).setInt32(0, 2);
    client.send(bogus);

    const messages = await client.waitForMessages(1);

    expect(readErrorFields(messages[0]?.body ?? new Uint8Array(0)).C).toBe(
      SQLSTATE_PROTOCOL_VIOLATION
    );
  });

  test('rejects a post-authentication frame declaring an oversized length', async () => {
    const { queue } = makeFakeQueue();
    const port = startServer(async () => allow(queue, ''));
    const client = await TestClient.connect(port);

    client.send(buildStartupPacket({ user: 'postgres', database: 'postgres' }));
    await client.waitForMessages(1);

    // A frame header claiming 1 GiB, with none of the body sent. Without a cap
    // the server would hold everything received so far and keep growing as the
    // client dribbles bytes it never has to finish.
    const header = new Uint8Array(5);

    header[0] = 0x51; // 'Q'
    new DataView(header.buffer).setInt32(1, 1024 * 1024 * 1024);
    client.send(header);

    const messages = await client.waitForMessages(2);

    expect(readErrorFields(messages[1]?.body ?? new Uint8Array(0)).C).toBe(
      SQLSTATE_PROTOCOL_VIOLATION
    );
  });

  test('accepts a large but legitimate post-authentication frame', async () => {
    const { queue, received } = makeFakeQueue();
    const port = startServer(async () => allow(queue, ''));
    const client = await TestClient.connect(port);

    client.send(buildStartupPacket({ user: 'postgres', database: 'postgres' }));
    await client.waitForMessages(1);

    // Comfortably under the cap: a big INSERT must still go through.
    client.send(buildQueryMessage(`SELECT '${'x'.repeat(200_000)}'`));

    await client.waitForMessages(2);

    expect(received[1]?.length).toBeGreaterThan(200_000);
  });

  test('rejects a non-password reply to the authentication request', async () => {
    const { queue } = makeFakeQueue();
    const port = startServer(async () => allow(queue, 's3cret'));
    const client = await TestClient.connect(port);

    client.send(buildStartupPacket({ user: 'postgres', database: 'postgres' }));
    await client.waitForMessages(1);

    client.send(buildQueryMessage('SELECT 1'));

    const messages = await client.waitForMessages(2);

    expect(readErrorFields(messages[1]?.body ?? new Uint8Array(0))).toMatchObject({
      C: SQLSTATE_PROTOCOL_VIOLATION,
      M: 'expected a password message in response to the authentication request',
    });
  });

  test('detaches the connection from its database on Terminate', async () => {
    const detached: string[] = [];
    const { queue } = makeFakeQueue();

    (queue as unknown as { detach: (id: string) => Promise<void> }).detach = async id => {
      detached.push(id);
    };

    const port = startServer(async () => allow(queue, ''));
    const client = await TestClient.connect(port);

    client.send(buildStartupPacket({ user: 'postgres', database: 'postgres' }));
    await client.waitForMessages(1);

    client.send(buildTaggedMessage('X', new Uint8Array(0)));

    await Bun.sleep(50);

    expect(detached).toHaveLength(1);
  });

  test('reports a failing query as an internal error rather than hanging', async () => {
    const queue = {
      enqueue: async () => {
        throw new Error('backend exploded');
      },
      detach: async () => {},
    } as unknown as PGliteSessionQueue;
    const port = startServer(async () => allow(queue, ''));
    const client = await TestClient.connect(port);

    client.send(buildStartupPacket({ user: 'postgres', database: 'postgres' }));

    const messages = await client.waitForMessages(1);

    expect(readErrorFields(messages[0]?.body ?? new Uint8Array(0)).M).toBe('backend exploded');
  });

  test('keeps up with a client pipelining more than the read buffer holds', async () => {
    const { queue, received } = makeFakeQueue();
    const port = startServer(async () => allow(queue, ''));
    const client = await TestClient.connect(port);

    client.send(buildStartupPacket({ user: 'postgres', database: 'postgres' }));
    await client.waitForMessages(1);

    // Frames arrive faster than the single shared backend can run them, so the
    // unparsed buffer grows until reads are paused. Well past the pause
    // threshold here: every frame must still be processed, in order, which
    // only happens if reads are resumed again as the buffer drains.
    const frameCount = 200;
    const payload = 'x'.repeat(64 * 1024);

    for (let index = 0; index < frameCount; index++) {
      client.send(buildQueryMessage(`SELECT ${index}, '${payload}'`));
    }

    const messages = await client.waitForMessages(frameCount + 1, 20000);

    expect(messages).toHaveLength(frameCount + 1);
    // received[0] is the startup packet forwarded at authentication.
    expect(received).toHaveLength(frameCount + 1);
    // Order matters as much as arrival: a resumed read must not reorder work.
    expect(received[1]).toContain('SELECT 0,');
    expect(received[frameCount]).toContain(`SELECT ${frameCount - 1},`);
  });

  test('receives a single frame larger than the read-pause threshold', async () => {
    const { queue, received } = makeFakeQueue();
    const port = startServer(async () => allow(queue, ''));
    const client = await TestClient.connect(port);

    client.send(buildStartupPacket({ user: 'postgres', database: 'postgres' }));
    await client.waitForMessages(1);

    // One legitimate frame bigger than the pause threshold but under the
    // per-frame limit. Pausing while it is still arriving would stall the
    // connection forever: the bytes needed to consume it are exactly the ones
    // that would stop being read.
    const oversized = buildQueryMessage(`SELECT '${'y'.repeat(12 * 1024 * 1024)}'`);

    expect(oversized.length).toBeGreaterThan(8 * 1024 * 1024);

    client.send(oversized);

    const messages = await client.waitForMessages(2, 20000);

    expect(messages).toHaveLength(2);
    expect(received[1]?.length).toBeGreaterThan(12 * 1024 * 1024);
  });

  test('rejects a batch pushed over the limit by its terminating frame', async () => {
    const { queue } = makeFakeQueue();
    const port = startServer(async () => allow(queue, ''));
    const client = await TestClient.connect(port);

    client.send(buildStartupPacket({ user: 'postgres', database: 'postgres' }));
    await client.waitForMessages(1);

    // The batched frames stay UNDER the sequence limit on their own, so the
    // check in the batching branch never fires. Only counting the terminating
    // frame as well catches this — which is the whole point: a maximum-sized
    // terminator on top of an almost-full batch would otherwise be assembled,
    // and then copied again when the batch is concatenated.
    const chunk = 'z'.repeat(8 * 1024 * 1024);

    for (let index = 0; index < 7; index++) {
      client.send(buildTaggedMessage('P', buildParseBody(`stmt${index}`, `SELECT '${chunk}'`)));
    }

    client.send(buildQueryMessage(`SELECT '${'z'.repeat(10 * 1024 * 1024)}'`));

    const messages = await client.waitForMessages(2, 20000);

    expect(readErrorFields(messages[1]?.body ?? new Uint8Array(0)).C).toBe(
      SQLSTATE_PROTOCOL_VIOLATION
    );
  });

  test('listen is idempotent so a second call cannot double-bind the port', async () => {
    const { queue } = makeFakeQueue();
    const port = startServer(async () => allow(queue, ''));
    const server = servers[servers.length - 1];

    expect(server?.port).toBe(port);
    expect(() => server?.listen()).not.toThrow();
  });
});
