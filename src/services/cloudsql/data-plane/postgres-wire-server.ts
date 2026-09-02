/**
 * A Postgres frontend/backend protocol listener in front of PGlite.
 *
 * <p>One server listens on one TCP port for one emulated instance and routes
 * each connection to a database on that instance, so an instance's endpoint
 * behaves like a real Postgres endpoint: a connection string picks the
 * database, and the emulator's user records decide whether the connection is
 * allowed.
 *
 * <p>This is deliberately hand-rolled rather than delegated to
 * `@electric-sql/pglite-socket` or `pg-gateway`. The former serves exactly one
 * PGlite on a port with no hook for authentication or for routing by database
 * name, and keeps its multiplexer private; the latter is pre-1.0 and has no
 * multiplexer at all. Both would leave the two things this server exists to do
 * unimplemented, in exchange for a dependency.
 *
 * <p>Only the startup exchange is interpreted. Once a connection is
 * authenticated every byte is passed through to PGlite untouched, so the
 * emulator inherits the real Postgres protocol — extended query, COPY,
 * NOTIFY — rather than reimplementing it.
 *
 * <p>Nothing here is Cloud-SQL-specific, so AlloyDB can reuse it.
 */

import type { Socket, TCPSocketListener } from 'bun';
import type { PGliteSessionQueue } from './pglite-session-queue.ts';

const PROTOCOL_VERSION_3_0 = 196608;
const SSL_REQUEST_CODE = 80877103;
const CANCEL_REQUEST_CODE = 80877102;
const GSSENC_REQUEST_CODE = 80877104;

// Postgres caps a startup packet at 10000 bytes. Enforcing it stops a client
// that sends a bogus length from making this server buffer without limit.
const MAX_STARTUP_MESSAGE_LENGTH = 10000;

const AUTHENTICATION_CLEARTEXT_PASSWORD = 3;

const PASSWORD_MESSAGE_TAG = 0x70; // 'p'
const TERMINATE_MESSAGE_TAG = 0x58; // 'X'

// SQLSTATEs the startup exchange can end in, all of them classes a Postgres
// client already knows how to report.
export const SQLSTATE_INVALID_CATALOG_NAME = '3D000';
export const SQLSTATE_INVALID_AUTHORIZATION_SPECIFICATION = '28000';
export const SQLSTATE_INVALID_PASSWORD = '28P01';
export const SQLSTATE_PROTOCOL_VIOLATION = '08P01';
const SQLSTATE_INTERNAL_ERROR = 'XX000';

export interface StartupMessage {
  kind: 'startup';
  protocolVersion: number;
  parameters: Record<string, string>;
}

export type ParsedStartupPacket =
  | StartupMessage
  | { kind: 'ssl-request' }
  | { kind: 'gssenc-request' }
  | { kind: 'cancel-request' };

export interface ResolvedConnection {
  queue: PGliteSessionQueue;
  /** The user's stored password; empty means the instance accepts them without one. */
  password: string;
}

export interface ConnectionRejection {
  sqlState: string;
  message: string;
}

export type ConnectionResolution =
  | { allowed: true; connection: ResolvedConnection }
  | { allowed: false; rejection: ConnectionRejection };

export type ResolveConnection = (
  instanceKey: string,
  database: string,
  user: string
) => Promise<ConnectionResolution>;

export interface PostgresWireServerOptions {
  /** Identifies the emulated instance this server fronts, passed to `resolveConnection`. */
  instanceKey: string;
  port: number;
  resolveConnection: ResolveConnection;
}

/** Frame a backend message: a one-byte tag, a length covering itself, a body. */
function buildBackendMessage(tag: string, body: Uint8Array): Uint8Array {
  const message = new Uint8Array(5 + body.length);

  message[0] = tag.charCodeAt(0);
  new DataView(message.buffer).setInt32(1, 4 + body.length);
  message.set(body, 5);

  return message;
}

export function buildErrorResponse(sqlState: string, message: string): Uint8Array {
  const encoder = new TextEncoder();
  const fields = [`SFATAL`, `VFATAL`, `C${sqlState}`, `M${message}`];
  const encoded = fields.map(field => encoder.encode(field));
  const bodyLength = encoded.reduce((total, field) => total + field.length + 1, 0) + 1;
  const body = new Uint8Array(bodyLength);

  let offset = 0;

  for (const field of encoded) {
    body.set(field, offset);
    offset += field.length + 1; // the trailing NUL is already zero
  }

  return buildBackendMessage('E', body);
}

function buildAuthenticationRequest(kind: number): Uint8Array {
  const body = new Uint8Array(4);

  new DataView(body.buffer).setInt32(0, kind);

  return buildBackendMessage('R', body);
}

/**
 * Parse a startup packet: the only frame in the protocol with no type byte,
 * distinguished instead by a magic version code.
 */
export function parseStartupPacket(packet: Uint8Array): ParsedStartupPacket {
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

  if (packet.length < 8) {
    throw new Error('Startup packet is shorter than its fixed header');
  }

  const code = view.getInt32(4);

  if (code === SSL_REQUEST_CODE) return { kind: 'ssl-request' };
  if (code === GSSENC_REQUEST_CODE) return { kind: 'gssenc-request' };
  if (code === CANCEL_REQUEST_CODE) return { kind: 'cancel-request' };

  const parameters: Record<string, string> = {};
  const decoder = new TextDecoder();

  let offset = 8;

  // Key/value C-strings until the empty key that terminates the list.
  while (offset < packet.length && packet[offset] !== 0) {
    const keyEnd = packet.indexOf(0, offset);

    if (keyEnd < 0) throw new Error('Unterminated parameter name in startup packet');

    const key = decoder.decode(packet.subarray(offset, keyEnd));
    const valueEnd = packet.indexOf(0, keyEnd + 1);

    if (valueEnd < 0) throw new Error('Unterminated parameter value in startup packet');

    parameters[key] = decoder.decode(packet.subarray(keyEnd + 1, valueEnd));
    offset = valueEnd + 1;
  }

  return { kind: 'startup', protocolVersion: code, parameters };
}

type ConnectionPhase = 'startup' | 'password' | 'streaming' | 'closed';

interface ConnectionState {
  id: string;
  phase: ConnectionPhase;
  buffer: Uint8Array;
  /** Set once the client is processing a batch of frames, so reads never interleave. */
  isProcessing: boolean;
  user: string;
  database: string;
  startupPacket: Uint8Array | null;
  connection: ResolvedConnection | null;
}

let nextConnectionId = 1;

export class PostgresWireServer {
  private options: PostgresWireServerOptions;
  private listener: TCPSocketListener<ConnectionState> | null = null;

  constructor(options: PostgresWireServerOptions) {
    this.options = options;
  }

  listen(): void {
    if (this.listener) return;

    this.listener = Bun.listen<ConnectionState>({
      // Bind every interface, not the loopback address clients are told to
      // use: binding loopback would make the listener unreachable through
      // Docker's published port mapping, which is one of the two topologies
      // this data plane exists to serve.
      hostname: '0.0.0.0',
      port: this.options.port,
      socket: {
        open: socket => {
          socket.data = {
            id: `conn-${nextConnectionId++}`,
            phase: 'startup',
            buffer: new Uint8Array(0),
            isProcessing: false,
            user: '',
            database: '',
            startupPacket: null,
            connection: null,
          };
        },
        data: (socket, chunk) => {
          socket.data.buffer = concat(socket.data.buffer, chunk);

          void this.processBuffered(socket);
        },
        close: socket => {
          void this.releaseConnection(socket.data);
        },
        error: socket => {
          void this.releaseConnection(socket.data);
        },
      },
    });
  }

  get port(): number {
    return this.options.port;
  }

  stop(): void {
    this.listener?.stop(true);
    this.listener = null;
  }

  /**
   * Consume as many complete frames as the buffer holds.
   *
   * <p>Guarded by `isProcessing` because handling a frame is asynchronous
   * (resolving a database, running a query) while Bun keeps delivering `data`
   * callbacks meanwhile. Without the guard two overlapping runs would each
   * pull frames off the same buffer and hand PGlite a client's messages out of
   * order.
   */
  private async processBuffered(socket: Socket<ConnectionState>): Promise<void> {
    const state = socket.data;

    if (state.isProcessing) return;

    state.isProcessing = true;

    try {
      while (state.phase !== 'closed') {
        const frame = this.takeNextFrame(socket);

        if (!frame) return;

        await this.handleFrame(socket, frame);
      }
    } catch (error) {
      this.fail(
        socket,
        SQLSTATE_INTERNAL_ERROR,
        error instanceof Error ? error.message : 'Unexpected data-plane error'
      );
    } finally {
      state.isProcessing = false;
    }
  }

  /**
   * Split one complete frame off the front of the buffer, or return null while
   * the frame is still arriving. Startup packets are length-prefixed with no
   * tag; every later frame carries a leading tag byte.
   */
  private takeNextFrame(socket: Socket<ConnectionState>): Uint8Array | null {
    const state = socket.data;
    const isStartup = state.phase === 'startup';
    const headerSize = isStartup ? 4 : 5;

    if (state.buffer.length < headerSize) return null;

    const view = new DataView(
      state.buffer.buffer,
      state.buffer.byteOffset,
      state.buffer.byteLength
    );
    const declaredLength = view.getInt32(isStartup ? 0 : 1);
    const frameLength = isStartup ? declaredLength : declaredLength + 1;

    if (declaredLength < 4 || (isStartup && declaredLength > MAX_STARTUP_MESSAGE_LENGTH)) {
      this.fail(socket, SQLSTATE_PROTOCOL_VIOLATION, `Invalid message length ${declaredLength}`);

      return null;
    }

    if (state.buffer.length < frameLength) return null;

    const frame = state.buffer.slice(0, frameLength);

    state.buffer = state.buffer.slice(frameLength);

    return frame;
  }

  private async handleFrame(socket: Socket<ConnectionState>, frame: Uint8Array): Promise<void> {
    const state = socket.data;

    if (state.phase === 'startup') return this.handleStartupFrame(socket, frame);
    if (state.phase === 'password') return this.handlePasswordFrame(socket, frame);

    if (frame[0] === TERMINATE_MESSAGE_TAG) {
      await this.releaseConnection(state);
      socket.end();

      return;
    }

    await this.forward(socket, frame);
  }

  private async handleStartupFrame(
    socket: Socket<ConnectionState>,
    frame: Uint8Array
  ): Promise<void> {
    const state = socket.data;

    let packet: ParsedStartupPacket;

    try {
      packet = parseStartupPacket(frame);
    } catch (error) {
      this.fail(
        socket,
        SQLSTATE_PROTOCOL_VIOLATION,
        error instanceof Error ? error.message : 'Malformed startup packet'
      );

      return;
    }

    // No TLS: refusing negotiation makes a client fall back to plaintext,
    // which is what `sslmode=disable` / `tls: false` already expects locally.
    if (packet.kind === 'ssl-request' || packet.kind === 'gssenc-request') {
      socket.write(new Uint8Array([0x4e])); // 'N'

      return;
    }

    // Query cancellation would have to reach into a running PGlite call, which
    // the single-backend model gives no way to interrupt. Closing is honest:
    // the client's cancel simply does not take effect.
    if (packet.kind === 'cancel-request') {
      state.phase = 'closed';
      socket.end();

      return;
    }

    if (packet.protocolVersion !== PROTOCOL_VERSION_3_0) {
      this.fail(
        socket,
        SQLSTATE_PROTOCOL_VIOLATION,
        `Unsupported frontend protocol ${packet.protocolVersion}; kinglet speaks 3.0`
      );

      return;
    }

    const user = packet.parameters.user ?? '';

    if (user === '') {
      this.fail(
        socket,
        SQLSTATE_INVALID_AUTHORIZATION_SPECIFICATION,
        'no PostgreSQL user name specified in startup packet'
      );

      return;
    }

    state.user = user;
    // Postgres defaults the database to the user name when the client omits it.
    state.database = packet.parameters.database ?? user;
    state.startupPacket = frame;

    const resolution = await this.options.resolveConnection(
      this.options.instanceKey,
      state.database,
      state.user
    );

    if (!resolution.allowed) {
      this.fail(socket, resolution.rejection.sqlState, resolution.rejection.message);

      return;
    }

    state.connection = resolution.connection;

    if (resolution.connection.password !== '') {
      // Cleartext is the only method offered: SCRAM and MD5 both need the
      // stored verifier, and the admin API stores what the caller supplied.
      // The exchange never leaves loopback in the topologies this serves.
      state.phase = 'password';
      socket.write(buildAuthenticationRequest(AUTHENTICATION_CLEARTEXT_PASSWORD));

      return;
    }

    await this.beginStreaming(socket);
  }

  private async handlePasswordFrame(
    socket: Socket<ConnectionState>,
    frame: Uint8Array
  ): Promise<void> {
    const state = socket.data;

    if (frame[0] !== PASSWORD_MESSAGE_TAG) {
      this.fail(
        socket,
        SQLSTATE_PROTOCOL_VIOLATION,
        'expected a password message in response to the authentication request'
      );

      return;
    }

    // Body is one NUL-terminated string after the tag and length.
    const supplied = new TextDecoder().decode(frame.subarray(5, Math.max(5, frame.length - 1)));

    if (supplied !== state.connection?.password) {
      this.fail(
        socket,
        SQLSTATE_INVALID_PASSWORD,
        `password authentication failed for user "${state.user}"`
      );

      return;
    }

    await this.beginStreaming(socket);
  }

  /**
   * Hand the client's own startup packet to PGlite and let its reply — the
   * authentication-ok, parameter statuses, backend key and ready-for-query the
   * client is waiting for — flow straight back.
   */
  private async beginStreaming(socket: Socket<ConnectionState>): Promise<void> {
    const state = socket.data;
    const startupPacket = state.startupPacket;

    if (!startupPacket) {
      this.fail(socket, SQLSTATE_INTERNAL_ERROR, 'startup packet was lost before authentication');

      return;
    }

    state.phase = 'streaming';

    await this.forward(socket, startupPacket);
  }

  private async forward(socket: Socket<ConnectionState>, bytes: Uint8Array): Promise<void> {
    const state = socket.data;
    const connection = state.connection;

    if (!connection) {
      this.fail(socket, SQLSTATE_INTERNAL_ERROR, 'no database is attached to this connection');

      return;
    }

    try {
      await connection.queue.enqueue(state.id, bytes, data => {
        // A client that hung up mid-response leaves the queue still streaming;
        // dropping the remainder is the only thing left to do with it.
        if (state.phase !== 'closed') socket.write(data);
      });
    } catch (error) {
      this.fail(
        socket,
        SQLSTATE_INTERNAL_ERROR,
        error instanceof Error ? error.message : 'Query execution failed'
      );
    }
  }

  private fail(socket: Socket<ConnectionState>, sqlState: string, message: string): void {
    const state = socket.data;

    if (state.phase === 'closed') return;

    state.phase = 'closed';

    socket.write(buildErrorResponse(sqlState, message));
    socket.end();

    void this.releaseConnection(state);
  }

  private async releaseConnection(state: ConnectionState): Promise<void> {
    const connection = state.connection;

    state.phase = 'closed';
    state.connection = null;

    // Rolls back a transaction this connection left open, which would
    // otherwise block every other connection to the same database.
    await connection?.queue.detach(state.id);
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);

  combined.set(left);
  combined.set(right, left.length);

  return combined;
}
