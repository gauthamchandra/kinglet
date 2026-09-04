/**
 * Tests for PortAllocator
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { TCPSocketListener } from 'bun';
import { PortAllocator } from './port-allocator.ts';

const TEST_PORT_BASE = 46100;

let nextRangeStart = TEST_PORT_BASE;
let squatters: TCPSocketListener<undefined>[] = [];

function nextRange(size = 3): { portRangeStart: number; portRangeEnd: number } {
  const portRangeStart = nextRangeStart;

  nextRangeStart += size + 1;

  return { portRangeStart, portRangeEnd: portRangeStart + size - 1 };
}

/** Occupy a port with a foreign listener this allocator knows nothing about. */
function squat(port: number): void {
  squatters.push(
    Bun.listen({
      hostname: '127.0.0.1',
      port,
      socket: { data() {}, open() {}, close() {}, error() {} },
    })
  );
}

afterEach(() => {
  for (const squatter of squatters) squatter.stop(true);

  squatters = [];
});

describe('PortAllocator', () => {
  test('allocates sequentially from the start of the range', async () => {
    const range = nextRange();
    const allocator = new PortAllocator(range);

    expect(await allocator.allocate()).toBe(range.portRangeStart);
    expect(await allocator.allocate()).toBe(range.portRangeStart + 1);
    expect(await allocator.allocate()).toBe(range.portRangeStart + 2);
  });

  test('skips a port a foreign process is already listening on', async () => {
    const range = nextRange();

    squat(range.portRangeStart);

    const allocator = new PortAllocator(range);

    expect(await allocator.allocate()).toBe(range.portRangeStart + 1);
  });

  test('prefers a given port over the start of the range', async () => {
    const range = nextRange();
    const allocator = new PortAllocator(range);
    const preferred = range.portRangeStart + 2;

    expect(await allocator.allocate({ preferredPort: preferred })).toBe(preferred);
  });

  test('falls back to the range when the preferred port is taken', async () => {
    const range = nextRange();
    const allocator = new PortAllocator(range);
    const preferred = range.portRangeStart + 1;

    await allocator.allocate({ preferredPort: preferred });

    expect(await allocator.allocate({ preferredPort: preferred })).toBe(range.portRangeStart);
  });

  test('hands a released port back out again', async () => {
    const range = nextRange();
    const allocator = new PortAllocator(range);
    const first = await allocator.allocate();

    await allocator.allocate();

    expect(first).toBe(range.portRangeStart);

    allocator.release(range.portRangeStart);

    expect(await allocator.allocate()).toBe(range.portRangeStart);
  });

  test('returns null once the range is exhausted', async () => {
    const range = nextRange(2);
    const allocator = new PortAllocator(range);

    await allocator.allocate();
    await allocator.allocate();

    expect(await allocator.allocate()).toBeNull();
  });

  test('gives concurrent callers distinct ports', async () => {
    const range = nextRange();
    const allocator = new PortAllocator(range);
    const ports = await Promise.all([
      allocator.allocate(),
      allocator.allocate(),
      allocator.allocate(),
    ]);

    expect(new Set(ports).size).toBe(3);
  });

  describe('allocateBound', () => {
    test('returns the port and whatever the caller bound to it', async () => {
      const range = nextRange();
      const allocator = new PortAllocator(range);
      const allocated = await allocator.allocateBound(port => `bound:${port}`);

      expect(allocated).toEqual({
        port: range.portRangeStart,
        bound: `bound:${range.portRangeStart}`,
      });
    });

    test('moves on from a port that refuses to bind', async () => {
      const range = nextRange();
      const allocator = new PortAllocator(range);
      const refused: number[] = [];

      // A port can probe free and still refuse: the probe reaches loopback
      // while a listener binds every interface. That must cost the caller the
      // port, not the whole allocation.
      const allocated = await allocator.allocateBound(
        port => {
          if (port < range.portRangeStart + 2) throw new Error('EADDRINUSE');

          return port;
        },
        { onBindFailure: port => refused.push(port) }
      );

      expect(allocated?.port).toBe(range.portRangeStart + 2);
      expect(refused).toEqual([range.portRangeStart, range.portRangeStart + 1]);
    });

    test('returns null when nothing in the range can be bound', async () => {
      const range = nextRange(2);
      const allocator = new PortAllocator(range);

      expect(
        await allocator.allocateBound(() => {
          throw new Error('EADDRINUSE');
        })
      ).toBeNull();
    });

    test('gives back the ports that refused, so a later call can retry them', async () => {
      const range = nextRange();
      const allocator = new PortAllocator(range);

      await allocator.allocateBound(() => {
        throw new Error('EADDRINUSE');
      });

      // Whatever made binding fail may be gone by the next attempt; holding
      // the ports forever would shrink the range for the process's lifetime.
      expect(await allocator.allocate()).toBe(range.portRangeStart);
    });
  });
});
