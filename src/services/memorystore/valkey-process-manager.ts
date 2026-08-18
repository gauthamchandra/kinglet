/**
 * Valkey Process Manager - spawns and supervises real `valkey-server`
 * processes so Memorystore instances can be connected to over the
 * Valkey/RESP wire protocol, not just described via metadata.
 */

import type { Subprocess } from 'bun';
import type { Logger } from '@/shared/utils/logger.ts';
import { MemoryStoreError } from './types.ts';

export interface ValkeyEndpoint {
  address: string;
  port: number;
}

export interface ValkeyProcessManagerOptions {
  enabled: boolean;
  binaryPath?: string | undefined;
  portRangeStart: number;
  portRangeEnd: number;
}

const READINESS_TIMEOUT_MS = 5000;
const READINESS_POLL_INTERVAL_MS = 50;

// Every spawned server binds 0.0.0.0 (see the spawn args), so loopback always
// reaches it and is the only host worth probing.
const PROBE_HOST = '127.0.0.1';

// The address handed back to clients in `discoveryEndpoints`, which is a
// separate concern from the bind address: it has to be right from the
// CALLER's point of view, not this process's.
//
// Loopback covers both supported topologies — the emulator run directly on
// the developer's machine, and the emulator in Docker with the data-plane
// port range published. It is wrong for exactly one case: a client in a
// sibling container, which would dial itself. Deriving the address from the
// creating request's Host header would cover that too; until someone
// actually needs it, this stays a constant rather than a config knob.
const ADVERTISED_HOST = '127.0.0.1';

interface RunningServer {
  process: Subprocess;
  port: number;
}

export class ValkeyProcessManager {
  private logger: Logger;
  private options: ValkeyProcessManagerOptions;
  private serversByInstanceName = new Map<string, RunningServer>();
  private allocatedPorts = new Set<number>();
  // Degraded instances hold a port reservation without owning a process, so
  // they are invisible to serversByInstanceName. Tracking them here is what
  // lets deleting such an instance give the port back; without it a
  // create/delete loop walks the range and eventually exhausts it.
  private degradedPortsByInstanceName = new Map<string, number>();
  private hasLoggedDegradationWarning = false;

  constructor(logger: Logger, options: ValkeyProcessManagerOptions) {
    this.logger = logger;
    this.options = options;
  }

  isValkeyBinaryAvailable(): boolean {
    return this.resolveBinaryPath() != null;
  }

  /**
   * Start (or simulate) a `valkey-server` process for the given instance.
   *
   * <p>When the data plane is off, this always resolves to a deterministic
   * metadata-only endpoint (there are no real servers to collide with). When
   * the data plane is on, it either returns an endpoint backed by a live,
   * successfully-bound `valkey-server` for THIS instance, or throws a
   * {@link MemoryStoreError} — it never invents a fallback port that might
   * already be serving a different instance's data (see
   * {@link buildDegradedEndpoint}).
   */
  async startServerForInstance(instanceName: string): Promise<ValkeyEndpoint> {
    // A second start for a name that already has a running server or degraded
    // reservation (e.g. a createInstance retry) must release the previous one
    // first; otherwise the old process is orphaned and its port leaked, since
    // the map entry is about to be overwritten and can never be stopped.
    await this.stopServerForInstance(instanceName);

    if (!this.options.enabled) {
      return this.buildDegradedEndpoint(instanceName);
    }

    const binaryPath = this.resolveBinaryPath();

    if (binaryPath == null) {
      this.logDegradationWarningOnce();

      return this.buildDegradedEndpoint(instanceName);
    }

    const port = await this.allocateNextFreePort();

    if (port == null) {
      this.logger.warn(
        `No free ports available in range ${this.options.portRangeStart}-${this.options.portRangeEnd} for Memorystore instance`
      );

      return this.buildDegradedEndpoint(instanceName);
    }

    // Bind every interface, NOT the loopback address we advertise (see
    // ADVERTISED_HOST). Binding loopback would make the server listen only on
    // the container's own loopback interface, which Docker's published port
    // mapping can never reach — so the data plane would be dead in the one
    // environment it exists to serve.
    //
    // Binding beyond loopback also trips Valkey's protected mode, which refuses
    // non-loopback connections when no password is configured, so that has to
    // come off too. Both are safe here: the emulator is a local dev tool whose
    // reachability is already bounded by which ports the user published.
    const spawnArgs = [
      binaryPath,
      '--port',
      String(port),
      '--bind',
      '0.0.0.0',
      '--protected-mode',
      'no',
      '--save',
      '',
      '--appendonly',
      'no',
    ];

    const childProcess = Bun.spawn(spawnArgs, { stdout: 'ignore', stderr: 'ignore' });

    const isReady = await this.waitUntilPortIsListening(port, childProcess);

    if (!isReady) {
      // Await the exit, not just the signal: a not-ready child was never
      // recorded in serversByInstanceName, so if kill() were left un-awaited a
      // process slow to handle SIGTERM would stay alive yet untracked — neither
      // stopServerForInstance nor stopAllServers could ever reap it, and Bun
      // does not kill spawn children on parent exit. Reaping it here also frees
      // the port for real before buildDegradedEndpoint probes the range.
      childProcess.kill();
      await childProcess.exited;
      this.allocatedPorts.delete(port);

      this.logger.warn(
        `Memorystore instance's valkey-server never became ready on port ${port} within ${READINESS_TIMEOUT_MS}ms, falling back to a degraded endpoint`
      );

      return this.buildDegradedEndpoint(instanceName);
    }

    this.serversByInstanceName.set(instanceName, { process: childProcess, port });

    return { address: ADVERTISED_HOST, port };
  }

  async stopServerForInstance(instanceName: string): Promise<void> {
    const degradedPort = this.degradedPortsByInstanceName.get(instanceName);

    if (degradedPort != null) {
      this.allocatedPorts.delete(degradedPort);
      this.degradedPortsByInstanceName.delete(instanceName);
    }

    const server = this.serversByInstanceName.get(instanceName);

    if (!server) return;

    server.process.kill();
    await server.process.exited;

    this.allocatedPorts.delete(server.port);
    this.serversByInstanceName.delete(instanceName);
  }

  async stopAllServers(): Promise<void> {
    const instanceNames = new Set([
      ...this.serversByInstanceName.keys(),
      ...this.degradedPortsByInstanceName.keys(),
    ]);

    await Promise.all(
      [...instanceNames].map(instanceName => this.stopServerForInstance(instanceName))
    );
  }

  private resolveBinaryPath(): string | null {
    return Bun.which(this.options.binaryPath ?? 'valkey-server');
  }

  private logDegradationWarningOnce(): void {
    if (this.hasLoggedDegradationWarning) return;

    this.logger.warn(
      'valkey-server binary not found on PATH, Memorystore instances will expose metadata-only ' +
        'endpoints. Install valkey-server to get a connectable data plane, or set ' +
        'MEMORYSTORE_DATA_PLANE=false to silence this'
    );
    this.hasLoggedDegradationWarning = true;
  }

  /**
   * Build a metadata-only endpoint for when no live `valkey-server` backs
   * this instance.
   *
   * <p>With the data plane off, no real servers exist anywhere in the
   * configured range, so the plain deterministic hash port is safe to hand
   * out as-is. With the data plane on (a missing binary, an exhausted port
   * range, or a readiness timeout), a port already bound by a DIFFERENT
   * instance's live `valkey-server` must never be advertised here — a client
   * for this instance would silently read and write that other instance's
   * data. This searches forward from the hash port for one that is neither
   * claimed by this manager nor answering a live connection, and throws
   * rather than falling back to a colliding port if the whole range is
   * occupied.
   */
  private async buildDegradedEndpoint(instanceName: string): Promise<ValkeyEndpoint> {
    const hashPort = this.deriveDeterministicPort(instanceName);

    if (!this.options.enabled) {
      return { address: ADVERTISED_HOST, port: hashPort };
    }

    const port = await this.findUnusedPortStartingFrom(hashPort);

    if (port == null) {
      throw new MemoryStoreError(
        'FAILED_PRECONDITION',
        `Cannot provision a Memorystore data-plane endpoint for "${instanceName}": every port in ` +
          `${this.options.portRangeStart}-${this.options.portRangeEnd} is already in use by a live Valkey server`,
        instanceName
      );
    }

    // Held for as long as this instance advertises the address, so a later
    // successfully-spawned instance can never be allocated the port out from
    // under it. Released by stopServerForInstance when the instance goes away.
    this.allocatedPorts.add(port);
    this.degradedPortsByInstanceName.set(instanceName, port);

    return { address: ADVERTISED_HOST, port };
  }

  /**
   * Find a port in the configured range that is both unclaimed by this
   * manager and not already answering connections.
   *
   * <p>A live check (not just this manager's own bookkeeping) matters
   * because a foreign or orphaned process (e.g. a valkey-server left running
   * by a previous, ungracefully-killed emulator instance) could already be
   * listening on a port this manager has never allocated itself.
   */
  private async allocateNextFreePort(): Promise<number | null> {
    for (let port = this.options.portRangeStart; port <= this.options.portRangeEnd; port++) {
      if (this.allocatedPorts.has(port)) continue;

      // Claimed BEFORE the live-connection probe below (the only `await` in
      // this loop) so a concurrent allocateNextFreePort scanning the same
      // range can never observe this port as free too. Released again if the
      // probe turns out to be occupied by something this manager didn't
      // allocate.
      this.allocatedPorts.add(port);

      if (await this.isPortListening(port)) {
        this.allocatedPorts.delete(port);
        continue;
      }

      return port;
    }

    return null;
  }

  private async findUnusedPortStartingFrom(startPort: number): Promise<number | null> {
    const rangeSize = this.options.portRangeEnd - this.options.portRangeStart + 1;

    for (let offset = 0; offset < rangeSize; offset++) {
      const port =
        this.options.portRangeStart +
        ((startPort - this.options.portRangeStart + offset) % rangeSize);

      if (this.allocatedPorts.has(port)) continue;

      // Claimed BEFORE the live-connection probe (the only `await` in this
      // loop) so a concurrent degraded allocation scanning the same range can
      // never observe this port as free too, exactly as allocateNextFreePort
      // does. Released again if the probe finds it already occupied.
      this.allocatedPorts.add(port);

      if (await this.isPortListening(port)) {
        this.allocatedPorts.delete(port);
        continue;
      }

      return port;
    }

    return null;
  }

  private deriveDeterministicPort(instanceName: string): number {
    const rangeSize = this.options.portRangeEnd - this.options.portRangeStart + 1;
    let hash = 0;

    for (let i = 0; i < instanceName.length; i++) {
      hash = (hash * 31 + instanceName.charCodeAt(i)) >>> 0;
    }

    return this.options.portRangeStart + (hash % rangeSize);
  }

  private async waitUntilPortIsListening(
    port: number,
    childProcess: Subprocess,
    timeoutMs: number = READINESS_TIMEOUT_MS
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // A dead child can never legitimately answer on `port`; without this
      // check a foreign/orphaned process still listening on the same port
      // would make a dead spawn look "ready".
      if (childProcess.exitCode != null) return false;

      if (await this.isPortListening(port)) return true;

      await Bun.sleep(READINESS_POLL_INTERVAL_MS);
    }

    return false;
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
