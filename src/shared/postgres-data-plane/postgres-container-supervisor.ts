/**
 * A {@link PostgresSupervisor} that runs one Docker container per instance
 * data directory instead of a supervised child process.
 *
 * <p>Active only when {@code CLOUDSQL_POSTGRES_IMAGE} (or the equivalent
 * config field) names an image. With no image configured the default
 * {@link PostgresProcessManager} path is used. See ADR-019.
 *
 * <p>Known gap: this supervisor is wired for Cloud SQL only. AlloyDB
 * continues to use PGlite until it moves to {@code PostgresServerDataPlane}.
 *
 * <p>Known gap: running kinglet as root (uid 0) is not supported. The
 * postgres binary inside the container refuses to start as root, and the
 * host uid that should own the data directory depends on the image.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SQL } from 'bun';
import { isPortListening } from '@/shared/utils/port-allocator.ts';
import { type PostgresSupervisor, quoteLiteral } from './postgres-server-data-plane.ts';

/**
 * A function that runs a docker CLI command and returns the exit code and
 * captured stderr. Injected so unit tests can stub docker without a daemon.
 */
export type DockerCommandResult = { exitCode: number; stderr: string; stdout?: string };

export type DockerCommandRunner = (args: string[], stdin?: string) => Promise<DockerCommandResult>;

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

const ADMIN_PASSWORD_FILE = 'kinglet-admin.password';

function isMissingContainer(stderr: string): boolean {
  return /no such container/i.test(stderr);
}

function containerAdminUrl(password: string, port: number, database: string): string {
  return `postgres://kinglet_admin:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
}

function readAdminPassword(dataDir: string): string {
  try {
    const password = readFileSync(join(dataDir, ADMIN_PASSWORD_FILE), 'utf8').trim();

    if (password.length > 0) return password;
  } catch {
    // Missing file, handled below.
  }

  throw new Error(`Admin password for ${dataDir} is missing`);
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

async function readPipe(
  stream: ReadableStream<Uint8Array> | number | null | undefined
): Promise<string> {
  if (stream == null || typeof stream === 'number') return '';

  const chunks: string[] = [];
  const reader = stream.getReader();
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

  return chunks.join('');
}

async function spawnRunner(args: string[], stdin?: string): Promise<DockerCommandResult> {
  const child = Bun.spawn(args, {
    stdin: stdin == null ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readPipe(child.stdout),
    readPipe(child.stderr),
    child.exited,
  ]);

  return { exitCode, stderr: stderr.slice(-500), stdout: stdout.slice(-500) };
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

    if (!(await Bun.file(join(absDataDir, 'PG_VERSION')).exists())) {
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
        join(absDataDir, 'postgresql.auto.conf'),
        "password_encryption='scram-sha-256'\n"
      );
    }

    // A cluster created by the process manager trusts kinglet_admin only on
    // its Unix socket. Rewrite pg_hba every time so a later container start
    // can set a password over that socket and then require SCRAM on TCP.
    await this.adminPassword(absDataDir);
    await Bun.write(
      join(absDataDir, 'pg_hba.conf'),
      'local all kinglet_admin trust\n' +
        'host all all 0.0.0.0/0 scram-sha-256\n' +
        'host all all ::/0 scram-sha-256\n'
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

    await this.setAdminPassword(absDataDir, name);
    await this.waitForReady(absDataDir, port);
  }

  async stop(dataDir: string): Promise<void> {
    const name = containerNameForTest(resolve(dataDir));
    const stopped = await this.runner(['docker', 'stop', '-t', '5', name]);

    if (stopped.exitCode !== 0 && !isMissingContainer(stopped.stderr)) {
      throw new Error(
        `Failed to stop container ${name}` +
          (stopped.stderr.length > 0 ? `: ${stopped.stderr}` : '')
      );
    }

    if (isMissingContainer(stopped.stderr)) return;

    const removed = await this.runner(['docker', 'rm', '-f', name]);

    if (removed.exitCode !== 0 && !isMissingContainer(removed.stderr)) {
      throw new Error(
        `Failed to remove container ${name}` +
          (removed.stderr.length > 0 ? `: ${removed.stderr}` : '')
      );
    }
  }

  openAdminConnection(dataDir: string, port: number, database = 'template1'): SQL {
    const password = readAdminPassword(resolve(dataDir));

    return new SQL({
      url: containerAdminUrl(password, port, database),
      tls: false,
      connectionTimeout: 1,
      max: 1,
    });
  }

  private async adminPassword(dataDir: string): Promise<string> {
    const path = join(dataDir, ADMIN_PASSWORD_FILE);

    if (await Bun.file(path).exists()) {
      return (await Bun.file(path).text()).trim();
    }

    const password = randomBytes(24).toString('hex');

    await Bun.write(path, `${password}\n`);
    await chmod(path, 0o600);

    return password;
  }

  private async setAdminPassword(dataDir: string, name: string): Promise<void> {
    const password = await this.adminPassword(dataDir);
    const deadline = Date.now() + (this.options.readinessTimeoutMs ?? 30_000);
    let stderr = '';

    do {
      await this.assertContainerRunning(name);

      const statement = `ALTER ROLE kinglet_admin PASSWORD ${quoteLiteral(password)}`;
      const result = await this.runner(
        ['docker', 'exec', '-i', name, 'psql', '-U', 'kinglet_admin', '-d', 'template1'],
        statement
      );

      if (result.exitCode === 0) return;

      stderr = result.stderr;

      if ((this.options.readinessTimeoutMs ?? 30_000) === 0) break;

      await Bun.sleep(100);
    } while (Date.now() < deadline);

    throw new Error(
      `Failed to set the admin password in ${name}${stderr.length > 0 ? `: ${stderr}` : ''}`
    );
  }

  private async assertContainerRunning(name: string): Promise<void> {
    const result = await this.runner(['docker', 'inspect', '-f', '{{.State.Status}}', name]);
    const status = (result.stdout ?? '').trim();

    if (result.exitCode === 0 && status.length > 0 && status !== 'running') {
      throw new Error(`Container ${name} exited before it was ready (${status})`);
    }
  }

  private async waitForReady(dataDir: string, port: number): Promise<void> {
    const deadline = Date.now() + (this.options.readinessTimeoutMs ?? 30000);
    const name = containerNameForTest(dataDir);

    while (Date.now() < deadline) {
      await this.assertContainerRunning(name);

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
