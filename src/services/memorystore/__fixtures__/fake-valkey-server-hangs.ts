#!/usr/bin/env bun
/**
 * Test fixture that spawns successfully but never opens a listening port,
 * so `valkey-process-manager.test.ts` can assert the TCP readiness poll
 * times out instead of hanging forever.
 */

// Stays alive without ever listening, so the readiness poll has something to
// time out against. Bounded rather than a repeating timer: this fixture exists
// to be abandoned mid-readiness, so an unbounded keep-alive is exactly the
// thing most likely to be orphaned. 30s comfortably outlives the 5s readiness
// timeout while guaranteeing the process reaps itself.
setTimeout(() => process.exit(0), 30 * 1000);
