#!/usr/bin/env bun
/**
 * Test fixture standing in for a `valkey-server` that fails to bind (e.g.
 * "bind: Address already in use") and exits immediately without ever
 * opening a port, so `valkey-process-manager.test.ts` can assert the
 * readiness poll bails out as soon as the child dies instead of polling
 * until the full timeout elapses.
 */

process.exit(1);
