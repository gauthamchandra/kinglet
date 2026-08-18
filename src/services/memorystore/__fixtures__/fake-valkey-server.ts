#!/usr/bin/env bun
/**
 * Test fixture standing in for the real `valkey-server` binary.
 *
 * Accepts a `--port` argument and opens a real TCP listener on it, so
 * `valkey-process-manager.test.ts` can exercise Bun.spawn, port allocation,
 * and the TCP readiness poll without requiring valkey-server to be
 * installed in CI.
 */

const portArgIndex = process.argv.indexOf('--port');
const port = portArgIndex !== -1 ? Number(process.argv[portArgIndex + 1]) : 0;

Bun.listen({
  hostname: '0.0.0.0',
  port,
  socket: {
    data(socket) {
      socket.write('+PONG\r\n');
    },
    open() {},
    close() {},
    error() {},
  },
});

// The listener above already holds the event loop open, so this is purely a
// self-destruct: if the parent ever fails to kill this child (an assertion
// throwing before stopAllServers, a crashed test run), a repeating timer would
// leave it squatting a port indefinitely. A bounded timeout puts a ceiling on
// that, and is far longer than any test that uses this fixture.
setTimeout(() => process.exit(0), 5 * 60 * 1000);
