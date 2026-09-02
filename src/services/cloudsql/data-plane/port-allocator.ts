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
  async allocate(preferredPort?: number): Promise<number | null> {
    // A restart should come back on the address clients are already using.
    // Without this, restarting an instance would scan from the start of the
    // range and could silently move it onto a port freed by some other
    // instance in the meantime.
    if (preferredPort != null && (await this.claim(preferredPort))) {
      return preferredPort;
    }

    for (let port = this.options.portRangeStart; port <= this.options.portRangeEnd; port++) {
      if (await this.claim(port)) return port;
    }

    return null;
  }

  /**
   * Take a port if it is free, reporting whether it was taken.
   *
   * <p>The port is claimed BEFORE the liveness probe — the only `await` here —
   * so a concurrent allocate() scanning the same range cannot see it as free
   * too. The claim is given back if the probe finds it occupied.
   */
  private async claim(port: number): Promise<boolean> {
    if (port < this.options.portRangeStart || port > this.options.portRangeEnd) return false;

    if (this.allocatedPorts.has(port)) return false;

    this.allocatedPorts.add(port);

    if (await this.isPortListening(port)) {
      this.allocatedPorts.delete(port);

      return false;
    }

    return true;
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
