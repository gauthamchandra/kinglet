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

// PORT=0 is rejected by the config schema (min 1), so grab a real free port.
function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
  const port = server.port;

  server.stop(true);

  if (port == null) {
    throw new Error('Bun.serve did not report a port');
  }

  return port;
}

// Proves the child bound its port and finished starting; a bind failure
// (another process grabbed the port) would fail here instead of being
// mistaken for the exit code under test.
async function waitForHealth<T>(port: number, timeoutMs = 10_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);

      if (response.ok) {
        return (await response.json()) as T;
      }
    } catch {
      // still starting
    }

    await Bun.sleep(100);
  }

  return undefined;
}

describe('src/index.ts shutdown', () => {
  test('uncaughtException_afterStartup_exitsNonZeroInsteadOfLookingLikeACleanStop', async () => {
    const child = Bun.spawn(['bun', '--preload', THROW_AFTER_STARTUP_FIXTURE, INDEX_ENTRYPOINT], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: String(freePort()), SERVICES: 'secrets', LOG_LEVEL: 'error' },
      stdout: 'ignore',
      stderr: 'pipe',
    });

    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('test-injected fatal crash');
  }, 10000);

  test('sigterm_exitsZeroAsACleanStop', async () => {
    const port = freePort();
    const child = Bun.spawn(['bun', INDEX_ENTRYPOINT], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: String(port), SERVICES: 'secrets', LOG_LEVEL: 'error' },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    const health = await waitForHealth<{ status?: string }>(port);

    expect(health?.status).toBe('ok');
    child.kill('SIGTERM');

    const exitCode = await child.exited;

    expect(exitCode).toBe(0);
  }, 10000);

  test('health reports the Cloud Armor evaluation server when compute is enabled', async () => {
    const httpPort = freePort();
    const evaluationPort = freePort();

    const child = Bun.spawn(['bun', INDEX_ENTRYPOINT], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HTTP_PORT: String(httpPort),
        COMPUTE_LISTENER_PORT: String(evaluationPort),
        SERVICES: 'compute',
        MEMORYSTORE_DATA_PLANE: 'false',
        CLOUDSQL_DATA_PLANE: 'false',
        LOG_LEVEL: 'error',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    try {
      type HealthPayload = {
        status?: string;
        kingletCloudArmorEvaluationServer?: {
          started?: boolean;
          port?: number;
          bind?: string;
        };
      };
      const body = await waitForHealth<HealthPayload>(httpPort);

      expect(body).toBeDefined();
      expect(body?.status).toBe('ok');
      expect(body?.kingletCloudArmorEvaluationServer?.started).toBe(true);
      expect(body?.kingletCloudArmorEvaluationServer?.port).toBe(evaluationPort);
      expect(body?.kingletCloudArmorEvaluationServer?.bind).toBe('127.0.0.1');
    } finally {
      child.kill('SIGTERM');
      await child.exited;
    }
  }, 15000);
});
