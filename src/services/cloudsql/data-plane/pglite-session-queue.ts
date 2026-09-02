/**
 * Per-database serialiser for raw Postgres protocol traffic.
 *
 * <p>PGlite is a single embedded Postgres: one wasm instance, one backend, no
 * ability to serve two connections at once. A wire server that fans several
 * client sockets at the same database therefore has to interleave them itself,
 * and interleaving raw protocol bytes is only safe at message boundaries — so
 * every message runs to completion, alone, before the next one starts.
 *
 * <p>The subtle part is transactions. `BEGIN` leaves state on the one backend
 * that outlives the message that opened it, so any message from a DIFFERENT
 * connection admitted before `COMMIT` would silently execute inside that
 * connection's transaction. While the backend reports itself in a transaction
 * this queue therefore admits only the connection that opened it, and holds
 * everyone else — a correctness constraint, not a fairness policy.
 *
 * <p>Nothing here is Cloud-SQL-specific, so AlloyDB can reuse it.
 */

/**
 * The slice of PGlite this queue drives, narrowed to what it calls so tests
 * can substitute a fake backend.
 */
export interface ProtocolBackend {
  runExclusive<T>(callback: () => Promise<T>): Promise<T>;
  execProtocolRawStream(
    message: Uint8Array,
    options: { onRawData: (data: Uint8Array) => void }
  ): Promise<void>;
  isInTransaction(): boolean;
}

interface QueuedMessage {
  connectionId: string;
  bytes: Uint8Array;
  onData: (data: Uint8Array) => void;
  resolve: () => void;
  reject: (error: unknown) => void;
}

// A bare `ROLLBACK` simple-query frame ('Q'), sent on behalf of a connection
// that vanished mid-transaction. Built once because it never varies.
const ROLLBACK_QUERY_MESSAGE = buildSimpleQueryMessage('ROLLBACK');

function buildSimpleQueryMessage(sql: string): Uint8Array {
  const body = new TextEncoder().encode(sql);
  const message = new Uint8Array(6 + body.length);

  message[0] = 0x51; // 'Q'
  new DataView(message.buffer).setInt32(1, 5 + body.length);
  message.set(body, 5);

  return message;
}

export class PGliteSessionQueue {
  private backend: ProtocolBackend;
  private pending: QueuedMessage[] = [];
  private isDraining = false;
  // The connection whose BEGIN is still open, or null when the backend is not
  // in a transaction. Read after every message, since a message is what opens
  // and closes one.
  private transactionOwnerId: string | null = null;

  constructor(backend: ProtocolBackend) {
    this.backend = backend;
  }

  /**
   * Queue one client protocol message and resolve once the backend's entire
   * response has been handed to `onData`.
   */
  enqueue(
    connectionId: string,
    bytes: Uint8Array,
    onData: (data: Uint8Array) => void
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ connectionId, bytes, onData, resolve, reject });

      void this.drain();
    });
  }

  /**
   * Release a connection that has gone away.
   *
   * <p>A socket dropped between `BEGIN` and `COMMIT` would otherwise strand
   * the single backend inside a transaction nobody can ever finish, blocking
   * every other connection to this database forever. Rolling back is both what
   * frees them and what a real Postgres backend does when a client disconnects
   * mid-transaction.
   */
  async detach(connectionId: string): Promise<void> {
    // Anything this connection queued but never got to run: fail it now rather
    // than leave its enqueue() promise pending forever.
    const abandoned = this.pending.filter(message => message.connectionId === connectionId);

    this.pending = this.pending.filter(message => message.connectionId !== connectionId);

    for (const message of abandoned) {
      message.reject(new Error(`Connection ${connectionId} detached before its message ran`));
    }

    if (this.transactionOwnerId !== connectionId) return;

    await this.enqueue(connectionId, ROLLBACK_QUERY_MESSAGE, () => {});
  }

  private async drain(): Promise<void> {
    if (this.isDraining) return;

    this.isDraining = true;

    try {
      while (true) {
        const next = this.takeNextRunnableMessage();

        if (!next) return;

        await this.run(next);
      }
    } finally {
      this.isDraining = false;
    }
  }

  /**
   * Pick the next message that is safe to run, or null when the queue is empty
   * or every queued message belongs to a connection that must wait for an open
   * transaction to finish.
   */
  private takeNextRunnableMessage(): QueuedMessage | null {
    const index =
      this.transactionOwnerId == null
        ? 0
        : this.pending.findIndex(message => message.connectionId === this.transactionOwnerId);

    if (index < 0 || index >= this.pending.length) return null;

    const [message] = this.pending.splice(index, 1);

    return message ?? null;
  }

  private async run(message: QueuedMessage): Promise<void> {
    try {
      await this.backend.runExclusive(async () => {
        await this.backend.execProtocolRawStream(message.bytes, { onRawData: message.onData });
      });

      message.resolve();
    } catch (error) {
      message.reject(error);
    } finally {
      // Recomputed after every message, successful or not: the failed one may
      // still have opened or aborted a transaction, and a stale owner would
      // wedge the queue.
      this.transactionOwnerId = this.backend.isInTransaction() ? message.connectionId : null;
    }
  }
}
