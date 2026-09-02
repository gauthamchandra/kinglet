/**
 * Sequential TCP port allocation for data-plane listeners.
 *
 * <p>Allocation is sequential from the start of the range rather than derived
 * from a hash of the instance name, because the first port in the range is the
 * one that matters: a developer with a single emulated instance should find it
 * at the port their Postgres client already defaults to.
 *
 * <p>Nothing here is Cloud-SQL-specific, so AlloyDB can reuse it.
 */

// Every listener binds 0.0.0.0, so loopback always reaches it and is the only
// host worth probing.
const PROBE_HOST = '127.0.0.1';

export interface PortAllocatorOptions {
  portRangeStart: number;
  portRangeEnd: number;
}

export class PortAllocator {
  private options: PortAllocatorOptions;
  private allocatedPorts = new Set<number>();

  constructor(options: PortAllocatorOptions) {
    this.options = options;
  }

  /**
   * Claim the lowest port in the range that is neither already claimed here
   * nor answering connections, or null when the range is exhausted.
   *
   * <p>The live probe matters on top of this allocator's own bookkeeping: a
   * foreign process — the developer's own local Postgres on 5432 is the
   * obvious one — may already own a port this allocator has never handed out.
   */
  async allocate(): Promise<number | null> {
    for (let port = this.options.portRangeStart; port <= this.options.portRangeEnd; port++) {
      if (this.allocatedPorts.has(port)) continue;

      // Claimed BEFORE the probe below (the only `await` in this loop) so a
      // concurrent allocate() scanning the same range cannot observe the same
      // port as free. Released again if the probe finds it occupied.
      this.allocatedPorts.add(port);

      if (await this.isPortListening(port)) {
        this.allocatedPorts.delete(port);
        continue;
      }

      return port;
    }

    return null;
  }

  release(port: number): void {
    this.allocatedPorts.delete(port);
  }

  private async isPortListening(port: number): Promise<boolean> {
    try {
      const socket = await Bun.connect({
        hostname: PROBE_HOST,
        port,
        socket: {
          data() {},
          open() {},
          close() {},
          error() {},
        },
      });

      socket.end();

      return true;
    } catch {
      return false;
    }
  }
}
