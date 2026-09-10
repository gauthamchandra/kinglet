/**
 * Tests for PGliteSessionQueue
 */

import { describe, expect, test } from 'bun:test';
import type { ProtocolBackend } from './pglite-session-queue.ts';
import { PGliteSessionQueue } from './pglite-session-queue.ts';

interface FakeBackendOptions {
  onMessage?: (message: string) => void;
  fail?: (message: string) => Error | null;
}

/**
 * A stand-in for PGlite that records the SQL text of each simple-query frame
 * and treats BEGIN/COMMIT/ROLLBACK as transaction boundaries, so the queue's
 * ordering can be asserted without booting wasm Postgres.
 */
class FakeBackend implements ProtocolBackend {
  readonly executed: string[] = [];
  private inTransaction = false;
  private options: FakeBackendOptions;

  constructor(options: FakeBackendOptions = {}) {
    this.options = options;
  }

  async runExclusive<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }

  async execProtocolRawStream(
    message: Uint8Array,
    options: { onRawData: (data: Uint8Array) => void }
  ): Promise<void> {
    const sql = new TextDecoder().decode(message.subarray(5, message.length - 1));

    this.options.onMessage?.(sql);

    const failure = this.options.fail?.(sql);

    if (failure) throw failure;

    this.executed.push(sql);

    if (sql === 'BEGIN') this.inTransaction = true;
    if (sql === 'COMMIT' || sql === 'ROLLBACK') this.inTransaction = false;

    options.onRawData(new TextEncoder().encode(`ok:${sql}`));
  }

  isInTransaction(): boolean {
    return this.inTransaction;
  }
}

function query(sql: string): Uint8Array {
  const body = new TextEncoder().encode(sql);
  const message = new Uint8Array(6 + body.length);

  message[0] = 0x51; // 'Q'
  new DataView(message.buffer).setInt32(1, 5 + body.length);
  message.set(body, 5);

  return message;
}

describe('PGliteSessionQueue', () => {
  test('runs queued messages in FIFO order and streams each response back', async () => {
    const backend = new FakeBackend();
    const queue = new PGliteSessionQueue(backend);
    const received: string[] = [];
    const collect = (data: Uint8Array) => {
      received.push(new TextDecoder().decode(data));
    };

    await Promise.all([
      queue.enqueue('a', query('SELECT 1'), collect),
      queue.enqueue('b', query('SELECT 2'), collect),
      queue.enqueue('a', query('SELECT 3'), collect),
    ]);

    expect(backend.executed).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
    expect(received).toEqual(['ok:SELECT 1', 'ok:SELECT 2', 'ok:SELECT 3']);
  });

  test('holds other connections until the open transaction finishes', async () => {
    const backend = new FakeBackend();
    const queue = new PGliteSessionQueue(backend);

    await queue.enqueue('a', query('BEGIN'), () => {});

    // Queued while 'a' owns the transaction: it must not run before COMMIT,
    // or it would silently execute inside that transaction.
    const outsider = queue.enqueue('b', query('SELECT outside'), () => {});

    await queue.enqueue('a', query('INSERT inside'), () => {});

    expect(backend.executed).toEqual(['BEGIN', 'INSERT inside']);

    await queue.enqueue('a', query('COMMIT'), () => {});
    await outsider;

    expect(backend.executed).toEqual(['BEGIN', 'INSERT inside', 'COMMIT', 'SELECT outside']);
  });

  test('rolls back and releases the queue when the owner detaches mid-transaction', async () => {
    const backend = new FakeBackend();
    const queue = new PGliteSessionQueue(backend);

    await queue.enqueue('a', query('BEGIN'), () => {});

    const outsider = queue.enqueue('b', query('SELECT outside'), () => {});

    await queue.detach('a');
    await outsider;

    expect(backend.executed).toEqual(['BEGIN', 'ROLLBACK', 'SELECT outside']);
    expect(backend.isInTransaction()).toBe(false);
  });

  test('detaching a connection outside a transaction runs no rollback', async () => {
    const backend = new FakeBackend();
    const queue = new PGliteSessionQueue(backend);

    await queue.enqueue('a', query('SELECT 1'), () => {});
    await queue.detach('a');

    expect(backend.executed).toEqual(['SELECT 1']);
  });

  test('rejects a detached connection queued messages that never ran', async () => {
    const backend = new FakeBackend();
    const queue = new PGliteSessionQueue(backend);

    await queue.enqueue('a', query('BEGIN'), () => {});

    const abandoned = queue.enqueue('b', query('SELECT outside'), () => {});

    await queue.detach('b');

    await expect(abandoned).rejects.toThrow('detached before its message ran');
    expect(backend.executed).toEqual(['BEGIN']);
  });

  test('rejects the caller but keeps draining when a message fails', async () => {
    const backend = new FakeBackend({
      fail: sql => (sql === 'BOOM' ? new Error('backend exploded') : null),
    });
    const queue = new PGliteSessionQueue(backend);

    const failing = queue.enqueue('a', query('BOOM'), () => {});
    const following = queue.enqueue('a', query('SELECT 1'), () => {});

    await expect(failing).rejects.toThrow('backend exploded');
    await following;

    expect(backend.executed).toEqual(['SELECT 1']);
  });

  test('clears the transaction owner when a failed message left no transaction open', async () => {
    const backend = new FakeBackend({
      fail: sql => (sql === 'BOOM' ? new Error('backend exploded') : null),
    });
    const queue = new PGliteSessionQueue(backend);

    await expect(queue.enqueue('a', query('BOOM'), () => {})).rejects.toThrow('backend exploded');

    // A stale owner would wedge every other connection behind a transaction
    // that is not actually open.
    await queue.enqueue('b', query('SELECT 1'), () => {});

    expect(backend.executed).toEqual(['SELECT 1']);
  });
});
