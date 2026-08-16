#!/usr/bin/env bun
/**
 * Test fixture that never opens its `--port` (so the readiness poll times out)
 * but does open a "beacon" listener on `--port + 1000`. The beacon lets
 * `valkey-process-manager.test.ts` observe whether the child was actually
 * reaped after a readiness failure: if the manager kills but never awaits the
 * exit, the beacon stays answering; once the child is reaped, it stops.
 *
 * Self-destructs after 30s so an abandoned run (an assertion throwing before
 * teardown) can never leave the beacon squatting a port indefinitely.
 */

const portArgIndex = process.argv.indexOf('--port');
const port = portArgIndex !== -1 ? Number(process.argv[portArgIndex + 1]) : 0;

Bun.listen({
  hostname: '0.0.0.0',
  port: port + 1000,
  socket: {
    data() {},
    open() {},
    close() {},
    error() {},
  },
});

setTimeout(() => process.exit(0), 30 * 1000);
