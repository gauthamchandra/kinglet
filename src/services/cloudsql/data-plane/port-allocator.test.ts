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
});
