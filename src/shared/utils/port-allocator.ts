/**
 * TCP port allocation for services that expose a real listener per emulated
 * resource.
 *
 * <p>Allocation is sequential from the start of the range rather than derived
 * from a hash of the resource's name, because the first port in the range is
 * the one that matters: a developer with a single emulated instance should
 * find it at the port their client already defaults to.
 *
 * <p>Two things make this more than a counter. A port has to be probed,
 * because a foreign process — the developer's own Postgres on 5432 is the
 * obvious one — may hold a port this allocator never handed out. And a port
 * that probes free can still refuse to bind: the probe reaches loopback while
 * a listener typically binds every interface, and the two can disagree. So
 * {@link PortAllocator.allocateBound} treats a failed bind as proof the port
 * is unusable and moves on, rather than failing the caller outright.
 */

// Every listener binds 0.0.0.0, so loopback always reaches it and is the only
// host worth probing.
const PROBE_HOST = '127.0.0.1';

export interface PortAllocatorOptions {
  portRangeStart: number;
  portRangeEnd: number;
}

export interface AllocateOptions {
  /**
   * Tried before the range is scanned. A restarting resource passes the port
   * it was already on, so clients keep the address they hold.
   */
  preferredPort?: number | undefined;
  /**
   * Called when a port was claimed but the caller could not bind it, so a
   * caller that cares can report why a resource landed somewhere unexpected.
   */
  onBindFailure?: ((port: number, error: unknown) => void) | undefined;
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
  async allocate(options: AllocateOptions = {}): Promise<number | null> {
    const { preferredPort } = options;

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

  /**
   * Claim a port and hand it to {@code bind}, moving on to the next one
   * whenever binding fails, and returning null once the range is exhausted.
   *
   * <p>This belongs here rather than in each caller: "find me a port I can
   * actually use" is the allocator's job, and only the allocator can hold the
   * ports that refused to bind so a retry does not immediately pick one of
   * them again.
   */
  async allocateBound<T>(
    bind: (port: number) => T,
    options: AllocateOptions = {}
  ): Promise<{ port: number; bound: T } | null> {
    const portsThatRefusedToBind: number[] = [];

    try {
      while (true) {
        const port = await this.allocate(options);

        if (port == null) return null;

        try {
          return { port, bound: bind(port) };
        } catch (error) {
          // Kept claimed until every attempt is done, so the next allocate()
          // cannot hand back the port that just refused.
          portsThatRefusedToBind.push(port);
          options.onBindFailure?.(port, error);
        }
      }
    } finally {
      for (const port of portsThatRefusedToBind) this.release(port);
    }
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
