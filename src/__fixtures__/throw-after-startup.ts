/**
 * Preload fixture for index.test.ts: throws an uncaught exception shortly
 * after the emulator finishes starting, so the test can assert on the
 * resulting process exit code without needing to inject a fault into a
 * running request handler.
 */

setTimeout(() => {
  throw new Error('test-injected fatal crash');
}, 300);
