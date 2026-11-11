/**
 * A {@link PostgresSupervisor} that runs one Docker container per instance
 * data directory instead of a supervised child process.
 *
 * <p>Active only when {@code CLOUDSQL_POSTGRES_IMAGE} (or the equivalent
 * config field) names an image. With no image configured the default
 * {@link PostgresProcessManager} path is used. See ADR-019.
 *
 * <p>Known gap: this supervisor is wired for Cloud SQL only, matching the
 * existing ADR-019 follow-up. AlloyDB continues to use PGlite until it
 * moves to {@code PostgresServerDataPlane}.
 *
 * <p>Known gap: running kinglet as root (uid 0) is not supported by this
 * supervisor. The postgres binary inside the container refuses to start as
 * root, and the host-uid mapping required to hand the data directory over
 * to the container's postgres user is image-specific. Non-root use
 * (the typical developer case) works without restriction.
 */

import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SQL } from 'bun';
import { isPortListening } from '@/shared/utils/port-allocator.ts';
import type { PostgresSupervisor } from './postgres-server-data-plane.ts';

/**
 * A function that runs a docker CLI command and returns the exit code and
 * captured stderr. Injected so unit tests can stub docker without a daemon.
 */
export type DockerCommandRunner = (args: string[]) => Promise<{ exitCode: number; stderr: string }>;

export interface PostgresContainerSupervisorOptions {
  /** The image to run for each Postgres instance (e.g. `postgres:18`). */
  image: string;
  /**
   * Override the docker command runner. Defaults to {@link spawnRunner}.
   * Tests inject a stub here so no Docker daemon is required.
   */
  runner?: DockerCommandRunner;
  /** How long to wait for Postgres to accept connections (ms). Default 30 000. */
  readinessTimeoutMs?: number;
}

/**
 * Derive a stable container name from a data directory path. The name is
 * prefixed with `kinglet-pg-` followed by a 16-character hex digest of the
 * resolved path, so a restart finds the same container.
 *
 * Exported as `containerNameForTest` so tests can assert on the expected
 * name without duplicating the derivation logic.
 */
export function containerNameForTest(dataDir: string): string {
  const hash = createHash('sha256').update(resolve(dataDir)).digest('hex').substring(0, 16);

  return `kinglet-pg-${hash}`;
}

function containerUser(): string {
  const uid = process.getuid?.();

  if (uid == null || uid === 0) {
    // postgres refuses to start as root; defer to the container's postgres user.
    return 'postgres';
  }

  const gid = process.getgid?.() ?? uid;

  return `${uid}:${gid}`;
}

async function spawnRunner(args: string[]): Promise<{ exitCode: number; stderr: string }> {
  const chunks: string[] = [];
  const child = Bun.spawn(args, { stdout: 'ignore', stderr: 'pipe' });

  const stderrStream = child.stderr;

  if (stderrStream != null && typeof stderrStream !== 'number') {
    const reader = stderrStream.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        if (value != null) chunks.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // Pipe closes when child exits.
    }
  }

  const exitCode = await child.exited;

  return { exitCode, stderr: chunks.join('').slice(-500) };
}

export class PostgresContainerSupervisor implements PostgresSupervisor {
  private readonly runner: DockerCommandRunner;

  constructor(private readonly options: PostgresContainerSupervisorOptions) {
    this.runner = options.runner ?? spawnRunner;
  }

  isPostgresAvailable(): boolean {
    return Bun.which('docker') != null;
  }

  async ensureInitialized(dataDir: string): Promise<void> {
    const absDataDir = resolve(dataDir);

    if (await Bun.file(join(absDataDir, 'PG_VERSION')).exists()) return;

    await mkdir(absDataDir, { recursive: true });

    const { exitCode, stderr } = await this.runner([
      'docker',
      'run',
      '--rm',
      '--user',
      containerUser(),
      '--entrypoint',
      '',
      '-v',
      `${absDataDir}:/var/lib/postgresql/data`,
      this.options.image,
      'initdb',
      '-D',
      '/var/lib/postgresql/data',
      '-U',
      'kinglet_admin',
      '-A',
      'trust',
      '--no-sync',
      '-E',
      'UTF8',
      '--locale=C',
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `initdb via container image ${this.options.image} failed` +
          (stderr.length > 0 ? `: ${stderr}` : '')
      );
    }

    await Bun.write(
      join(absDataDir, 'pg_hba.conf'),
      // TCP trust for the admin user; scram-sha-256 for all others.
      // No local/ unix-socket line: the socket stays inside the container.
      'host all kinglet_admin 0.0.0.0/0 trust\n' +
        'host all all 0.0.0.0/0 scram-sha-256\n' +
        'host all all ::/0 scram-sha-256\n'
    );

    await Bun.write(
      join(absDataDir, 'postgresql.auto.conf'),
      "password_encryption='scram-sha-256'\n"
    );
  }

  async start(dataDir: string, port: number): Promise<void> {
    const absDataDir = resolve(dataDir);
    const name = containerNameForTest(absDataDir);

    // Remove any stopped (or crashed) container with this name before starting.
    await this.runner(['docker', 'rm', '-f', name]);

    const { exitCode, stderr } = await this.runner([
      'docker',
      'run',
      '-d',
      '--name',
      name,
      '--user',
      containerUser(),
      '--entrypoint',
      '',
      '-v',
      `${absDataDir}:/var/lib/postgresql/data`,
      '-p',
      `127.0.0.1:${port}:5432`,
      this.options.image,
      'postgres',
      '-D',
      '/var/lib/postgresql/data',
      '-c',
      'port=5432',
      '-c',
      'listen_addresses=*',
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `Container start for image ${this.options.image} failed` +
          (stderr.length > 0 ? `: ${stderr}` : '')
      );
    }

    await this.waitForReady(absDataDir, port);
  }

  async stop(dataDir: string): Promise<void> {
    const absDataDir = resolve(dataDir);
    const name = containerNameForTest(absDataDir);

    const { exitCode } = await this.runner(['docker', 'stop', '-t', '5', name]);

    if (exitCode !== 0) {
      // The container may already be stopped or removed; treat as a no-op.
    }
  }

  openAdminConnection(_dataDir: string, port: number, database = 'template1'): SQL {
    // Container mode uses TCP; the unix socket stays inside the container.
    return new SQL({
      url: `postgres://kinglet_admin:x@127.0.0.1:${port}/${encodeURIComponent(database)}`,
      tls: false,
      connectionTimeout: 1,
      max: 1,
    });
  }

  private async waitForReady(dataDir: string, port: number): Promise<void> {
    const deadline = Date.now() + (this.options.readinessTimeoutMs ?? 30000);

    while (Date.now() < deadline) {
      if (await isPortListening(port)) {
        const sql = this.openAdminConnection(dataDir, port);

        try {
          await sql`select 1`;

          return;
        } catch {
          // Postgres is listening but not yet ready for queries.
        } finally {
          await sql.close({ timeout: 0 });
        }
      }

      await Bun.sleep(100);
    }

    await this.runner(['docker', 'stop', '-t', '5', containerNameForTest(dataDir)]);

    throw new Error(`Container Postgres on port ${port} did not become ready before the timeout`);
  }
}
