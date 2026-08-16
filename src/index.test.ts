/**
 * Process-level tests for the emulator's shutdown/exit-code behavior.
 *
 * These spawn `src/index.ts` as a real subprocess rather than importing it
 * in-process: the module registers `process.on('SIGINT'/'SIGTERM'/
 * 'uncaughtException'/'unhandledRejection', ...)` handlers at import time,
 * which would otherwise hijack the test runner's own process.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');
const INDEX_ENTRYPOINT = join(REPO_ROOT, 'src', 'index.ts');
const THROW_AFTER_STARTUP_FIXTURE = join(
  REPO_ROOT,
  'src',
  '__fixtures__',
  'throw-after-startup.ts'
);

describe('src/index.ts shutdown', () => {
  test('uncaughtException_afterStartup_exitsNonZeroInsteadOfLookingLikeACleanStop', async () => {
    const child = Bun.spawn(['bun', '--preload', THROW_AFTER_STARTUP_FIXTURE, INDEX_ENTRYPOINT], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: '0', SERVICES: 'secrets', LOG_LEVEL: 'error' },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    const exitCode = await child.exited;

    expect(exitCode).toBe(1);
  }, 10000);

  test('sigterm_exitsZeroAsACleanStop', async () => {
    const child = Bun.spawn(['bun', INDEX_ENTRYPOINT], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: '0', SERVICES: 'secrets', LOG_LEVEL: 'error' },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    // Give the emulator a moment to finish starting before asking it to stop.
    await Bun.sleep(300);
    child.kill('SIGTERM');

    const exitCode = await child.exited;

    expect(exitCode).toBe(0);
  }, 10000);
});
