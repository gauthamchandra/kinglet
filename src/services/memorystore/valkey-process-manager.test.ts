/**
 * Unit tests for ValkeyProcessManager
 *
 * (a) exercises the binary-absent degradation path
 * (b) exercises the real spawn/lifecycle path against a checked-in stand-in
 *     binary (a tiny Bun script that opens a real TCP listener), so CI does
 *     not need the genuine valkey-server binary for coverage
 * (c) exercises the real valkey-server binary when present, skipped otherwise
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { Logger } from '@/shared/utils/logger.ts';
import { isRealValkeyBinaryAvailable } from '../../../test-utils/valkey.ts';
import { MemoryStoreError } from './types.ts';
import { ValkeyProcessManager } from './valkey-process-manager.ts';

const FIXTURES_DIR = join(import.meta.dir, '__fixtures__');
const FAKE_VALKEY_SERVER = join(FIXTURES_DIR, 'fake-valkey-server.ts');
const FAKE_VALKEY_SERVER_HANGS = join(FIXTURES_DIR, 'fake-valkey-server-hangs.ts');
const FAKE_VALKEY_SERVER_EXITS_IMMEDIATELY = join(
  FIXTURES_DIR,
  'fake-valkey-server-exits-immediately.ts'
);
const FAKE_VALKEY_SERVER_HANGS_WITH_BEACON = join(
  FIXTURES_DIR,
  'fake-valkey-server-hangs-with-beacon.ts'
);

async function isPortListening(port: number, host = '127.0.0.1'): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: host,
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

describe('ValkeyProcessManager', () => {
  describe('binary-absent degradation path', () => {
    let logger: Logger;
    let warnSpy: ReturnType<typeof spyOn>;
    let manager: ValkeyProcessManager;

    beforeEach(() => {
      logger = new Logger('test', 'error');
      warnSpy = spyOn(logger, 'warn');

      manager = new ValkeyProcessManager(logger, {
        enabled: true,
        binaryPath: '/nonexistent/path/to/valkey-server',
        portRangeStart: 18000,
        portRangeEnd: 18010,
      });
    });

    test('isValkeyBinaryAvailable_givenNonexistentBinaryPath_returnsFalse', () => {
      expect(manager.isValkeyBinaryAvailable()).toBe(false);
    });

    test('startServerForInstance_givenNoBinaryAvailable_fallsBackToADeterministicMetadataOnlyEndpointRatherThanNothing', async () => {
      const endpoint = await manager.startServerForInstance(
        'projects/p/locations/us-central1/instances/i'
      );

      // A missing binary must degrade to the SAME shape of endpoint the
      // "data plane disabled" path returns, not an empty result: client code
      // reading `discoveryEndpoints[0].address` must never see nothing just
      // because the binary happened to be unavailable on this host.
      expect(endpoint.address).toBe('127.0.0.1');
      expect(endpoint.port).toBeGreaterThanOrEqual(18000);
      expect(endpoint.port).toBeLessThanOrEqual(18010);
    });

    test('startServerForInstance_givenNoBinaryAvailable_logsTheDegradationWarningExactlyOnceAcrossTwoCalls', async () => {
      await manager.startServerForInstance('projects/p/locations/us-central1/instances/a');
      await manager.startServerForInstance('projects/p/locations/us-central1/instances/b');

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    /**
     * A degraded instance reserves a port without owning a process, so it is
     * invisible to the running-server bookkeeping that stopServerForInstance
     * consults. Until the reservation was released too, create/delete cycles
     * walked the range and eventually failed every further create.
     */
    test('stopServerForInstance_givenADegradedInstance_releasesItsPortForReuse', async () => {
      const instanceName = 'projects/p/locations/us-central1/instances/recycled';
      const first = await manager.startServerForInstance(instanceName);

      await manager.stopServerForInstance(instanceName);

      const second = await manager.startServerForInstance(instanceName);

      expect(second.port).toBe(first.port);
    });

    test('startServerForInstance_calledTwiceForTheSameInstanceWithoutAnInterveningStop_reusesThePortInsteadOfLeakingAStaleReservation', async () => {
      const instanceName = 'projects/p/locations/us-central1/instances/retried';

      const first = await manager.startServerForInstance(instanceName);
      const second = await manager.startServerForInstance(instanceName);

      // A retry (e.g. createInstance re-run after a persistence failure) must
      // release the previous reservation for this name before re-allocating,
      // otherwise the first port is leaked and the range drains one port per
      // retry.
      expect(second.port).toBe(first.port);
    });

    test('startServerForInstance_givenConcurrentDegradedAllocationsInASingleFreePort_neverHandsTheSamePortToTwoInstances', async () => {
      const tightManager = new ValkeyProcessManager(new Logger('test', 'error'), {
        enabled: true,
        binaryPath: '/nonexistent/path/to/valkey-server',
        portRangeStart: 18800,
        portRangeEnd: 18800,
      });

      // A check-then-act race in the degraded allocator (probing the port
      // before claiming it) would let both concurrent calls observe the one
      // free port as available and both claim it, advertising the same port to
      // two instances.
      const results = await Promise.allSettled([
        tightManager.startServerForInstance('projects/p/locations/us-central1/instances/deg-a'),
        tightManager.startServerForInstance('projects/p/locations/us-central1/instances/deg-b'),
      ]);

      expect(results.filter(r => r.status === 'fulfilled').length).toBe(1);
      expect(results.filter(r => r.status === 'rejected').length).toBe(1);
    });

    test('startServerForInstance_acrossMoreCreateDeleteCyclesThanThePortRangeHolds_neverExhaustsTheRange', async () => {
      for (let cycle = 0; cycle < 25; cycle++) {
        const instanceName = `projects/p/locations/us-central1/instances/cycle-${cycle}`;

        const endpoint = await manager.startServerForInstance(instanceName);

        expect(endpoint.port).toBeGreaterThanOrEqual(18000);

        await manager.stopServerForInstance(instanceName);
      }
    });
  });

  describe('spawn and lifecycle path against a stand-in binary', () => {
    let manager: ValkeyProcessManager;

    beforeEach(() => {
      manager = new ValkeyProcessManager(new Logger('test', 'error'), {
        enabled: true,
        binaryPath: FAKE_VALKEY_SERVER,
        portRangeStart: 18100,
        portRangeEnd: 18110,
      });
    });

    afterEach(async () => {
      await manager.stopAllServers();
    });

    test('isValkeyBinaryAvailable_givenConfiguredBinaryPath_returnsTrue', () => {
      expect(manager.isValkeyBinaryAvailable()).toBe(true);
    });

    test('startServerForInstance_spawnsAProcessAndReturnsALiveEndpointWithinTheConfiguredPortRange', async () => {
      const endpoint = await manager.startServerForInstance(
        'projects/p/locations/us-central1/instances/i'
      );

      expect(endpoint.address).toBe('127.0.0.1');
      expect(endpoint.port).toBeGreaterThanOrEqual(18100);
      expect(endpoint.port).toBeLessThanOrEqual(18110);
    });

    /**
     * Binding the server to the advertised loopback address instead of every
     * interface shipped once and made the containerised data plane
     * unreachable: valkey listened only on the container's loopback, so
     * Docker's published port mapping had nothing to forward to. The bind
     * address and the advertised address are separate concerns even when they
     * look alike, and this pins them apart.
     */
    test('startServerForInstance_bindsEveryInterfaceRatherThanTheAdvertisedLoopbackHost', async () => {
      const spawnSpy = spyOn(Bun, 'spawn');

      await manager.startServerForInstance('projects/p/locations/us-central1/instances/bound');

      const spawnArgs = spawnSpy.mock.calls[0]?.[0] as string[];

      expect(spawnArgs).toContain('--bind');
      expect(spawnArgs[spawnArgs.indexOf('--bind') + 1]).toBe('0.0.0.0');
      expect(spawnArgs[spawnArgs.indexOf('--protected-mode') + 1]).toBe('no');

      spawnSpy.mockRestore();
    });

    test('startServerForInstance_givenTwoInstances_allocatesTwoDistinctPorts', async () => {
      const first = await manager.startServerForInstance(
        'projects/p/locations/us-central1/instances/a'
      );
      const second = await manager.startServerForInstance(
        'projects/p/locations/us-central1/instances/b'
      );

      expect(first.port).not.toBe(second.port);
    });

    test('stopServerForInstance_terminatesTheChildProcessSoItsPortStopsAcceptingConnections', async () => {
      const instanceName = 'projects/p/locations/us-central1/instances/reusable';
      const first = await manager.startServerForInstance(instanceName);

      expect(await isPortListening(first.port)).toBe(true);

      await manager.stopServerForInstance(instanceName);

      // A manager that only forgets the port in its internal map, without
      // killing the child process, would leave the old fake server still
      // listening here — which would in turn let a later re-allocation of
      // this same port falsely appear "ready" against the STALE process.
      expect(await isPortListening(first.port)).toBe(false);
    });

    test('stopServerForInstance_freesThePortForReuseByANewlySpawnedProcess', async () => {
      const instanceName = 'projects/p/locations/us-central1/instances/reusable';
      const first = await manager.startServerForInstance(instanceName);

      await manager.stopServerForInstance(instanceName);

      const second = await manager.startServerForInstance(instanceName);

      expect(first.port).toBe(second.port);
      expect(await isPortListening(second.port)).toBe(true);
    });

    test('stopAllServers_afterStartingTwoInstances_terminatesEveryChildProcess', async () => {
      const first = await manager.startServerForInstance(
        'projects/p/locations/us-central1/instances/a'
      );
      const second = await manager.startServerForInstance(
        'projects/p/locations/us-central1/instances/b'
      );

      await manager.stopAllServers();

      expect(await isPortListening(first.port)).toBe(false);
      expect(await isPortListening(second.port)).toBe(false);
    });

    test('startServerForInstance_givenAProcessThatNeverOpensAPort_timesOutAndFallsBackToADeterministicEndpointInsteadOfHanging', async () => {
      const hangingManager = new ValkeyProcessManager(new Logger('test', 'error'), {
        enabled: true,
        binaryPath: FAKE_VALKEY_SERVER_HANGS,
        portRangeStart: 18200,
        portRangeEnd: 18201,
      });

      const endpoint = await hangingManager.startServerForInstance(
        'projects/p/locations/us-central1/instances/never-ready'
      );

      expect(endpoint.address).toBe('127.0.0.1');
      expect(endpoint.port).toBeGreaterThanOrEqual(18200);
      expect(endpoint.port).toBeLessThanOrEqual(18201);

      await hangingManager.stopAllServers();
    }, 10000);

    test('startServerForInstance_givenAForeignListenerAlreadyOnTheFirstPortInRange_skipsItAndAllocatesTheNextFreePort', async () => {
      const squattedPort = 18100;
      const foreignListener = Bun.listen({
        hostname: '127.0.0.1',
        port: squattedPort,
        socket: { data() {}, open() {}, close() {}, error() {} },
      });

      try {
        const endpoint = await manager.startServerForInstance(
          'projects/p/locations/us-central1/instances/must-not-adopt-foreign-listener'
        );

        // A manager that only consulted its own allocation bookkeeping (and
        // never live-checked the port) would hand this instance the
        // ALREADY-OCCUPIED squattedPort, and the readiness poll would then
        // see the foreign listener answering and falsely call it "ready".
        expect(endpoint.port).not.toBe(squattedPort);
        expect(endpoint.port).toBeGreaterThanOrEqual(18100);
        expect(endpoint.port).toBeLessThanOrEqual(18110);
      } finally {
        foreignListener.stop(true);
      }
    });

    test('startServerForInstance_givenConcurrentCallsForDifferentInstances_neverAllocatesTheSamePortTwice', async () => {
      const concurrentManager = new ValkeyProcessManager(new Logger('test', 'error'), {
        enabled: true,
        binaryPath: FAKE_VALKEY_SERVER,
        portRangeStart: 18700,
        portRangeEnd: 18710,
      });

      // A check-then-act race in port allocation (checking isPortListening
      // before claiming the port) would let both of these concurrent calls
      // observe the same candidate port as free and both claim it, handing
      // one instance's client a "live" endpoint that is really the other
      // instance's Valkey server.
      const [first, second] = await Promise.all([
        concurrentManager.startServerForInstance(
          'projects/p/locations/us-central1/instances/concurrent-a'
        ),
        concurrentManager.startServerForInstance(
          'projects/p/locations/us-central1/instances/concurrent-b'
        ),
      ]);

      expect(first.port).not.toBe(second.port);

      await concurrentManager.stopAllServers();
    });

    test('startServerForInstance_givenEveryPortInRangeAlreadyLiveWithOtherInstances_throwsInsteadOfAdvertisingACollidingPort', async () => {
      const tightManager = new ValkeyProcessManager(new Logger('test', 'error'), {
        enabled: true,
        binaryPath: FAKE_VALKEY_SERVER,
        portRangeStart: 18600,
        portRangeEnd: 18601,
      });

      await tightManager.startServerForInstance('projects/p/locations/us-central1/instances/alpha');
      await tightManager.startServerForInstance('projects/p/locations/us-central1/instances/beta');

      // Both ports in the range are now live with OTHER instances' Valkey
      // servers. The degraded-endpoint fallback must never hand this third
      // instance one of those ports — doing so would silently point a
      // client for "gamma" at "alpha" or "beta"'s dataset.
      const promise = tightManager.startServerForInstance(
        'projects/p/locations/us-central1/instances/gamma'
      );

      await expect(promise).rejects.toBeInstanceOf(MemoryStoreError);
      await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');

      await tightManager.stopAllServers();
    });

    test('startServerForInstance_whenReadinessTimesOut_reapsTheChildInsteadOfLeavingItOrphaned', async () => {
      const spawnPort = 18800;
      const orphanProneManager = new ValkeyProcessManager(new Logger('test', 'error'), {
        enabled: true,
        binaryPath: FAKE_VALKEY_SERVER_HANGS_WITH_BEACON,
        portRangeStart: spawnPort,
        portRangeEnd: spawnPort,
      });

      await orphanProneManager.startServerForInstance(
        'projects/p/locations/us-central1/instances/orphan-check'
      );

      // The child opens a beacon on spawnPort + 1000 but never on its --port, so
      // readiness times out. A readiness failure that killed the child without
      // awaiting its exit would leave the beacon still answering; a properly
      // reaped child takes the beacon down before startServerForInstance returns.
      expect(await isPortListening(spawnPort + 1000)).toBe(false);

      await orphanProneManager.stopAllServers();
    }, 10000);

    test('startServerForInstance_givenAChildThatExitsImmediately_bailsOutOfTheReadinessPollInsteadOfWaitingForTheFullTimeout', async () => {
      const crashingManager = new ValkeyProcessManager(new Logger('test', 'error'), {
        enabled: true,
        binaryPath: FAKE_VALKEY_SERVER_EXITS_IMMEDIATELY,
        portRangeStart: 18400,
        portRangeEnd: 18401,
      });

      const startedAt = Date.now();
      const endpoint = await crashingManager.startServerForInstance(
        'projects/p/locations/us-central1/instances/crashes-on-launch'
      );
      const elapsedMs = Date.now() - startedAt;

      // READINESS_TIMEOUT_MS is 5000; noticing the dead child instead of
      // blindly polling until the deadline should resolve far sooner.
      expect(elapsedMs).toBeLessThan(2000);
      expect(endpoint.address).toBe('127.0.0.1');
      expect(endpoint.port).toBeGreaterThanOrEqual(18400);
      expect(endpoint.port).toBeLessThanOrEqual(18401);

      await crashingManager.stopAllServers();
    });
  });

  describe('real valkey-server binary', () => {
    test.skipIf(!isRealValkeyBinaryAvailable)(
      'startServerForInstance_givenTheRealValkeyBinary_respondsToPing',
      async () => {
        const manager = new ValkeyProcessManager(new Logger('test', 'error'), {
          enabled: true,
          portRangeStart: 18300,
          portRangeEnd: 18310,
        });

        const endpoint = await manager.startServerForInstance(
          'projects/p/locations/us-central1/instances/real'
        );

        const client = new Bun.RedisClient(`redis://${endpoint.address}:${endpoint.port}`);

        try {
          const pong = await client.send('PING', []);

          expect(pong).toBe('PONG');
        } finally {
          client.close();
          await manager.stopAllServers();
        }
      }
    );
  });
});
