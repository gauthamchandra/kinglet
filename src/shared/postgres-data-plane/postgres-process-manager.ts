import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SQL, type Subprocess } from 'bun';
import type { Logger } from '@/shared/utils/logger.ts';
import { isPortListening } from '@/shared/utils/port-allocator.ts';

interface PostgresProcessManagerOptions {
  binDir?: string;
  templateDir?: string;
  readinessTimeoutMs?: number;
}

/**
 * Owns at most one child per data directory. Only a live child with a working
 * admin connection is ready; failed starts and stops always await child exit.
 * The template is initialized once and never started, so copies are clean clusters.
 * Lifecycle calls for the same directory must be serialized by the caller.
 */
export class PostgresProcessManager {
  private servers = new Map<string, Subprocess>();
  private templateInitialization: Promise<string> | undefined;

  constructor(
    private logger: Logger,
    private options: PostgresProcessManagerOptions = {}
  ) {}

  isPostgresAvailable(): boolean {
    const binDir = this.resolveBinDir();

    return (
      binDir != null && ['postgres', 'initdb'].every(name => Bun.which(join(binDir, name)) != null)
    );
  }

  async ensureInitialized(dataDir: string): Promise<void> {
    dataDir = resolve(dataDir);

    if (await Bun.file(join(dataDir, 'PG_VERSION')).exists()) return;

    this.templateInitialization ??= this.initializeTemplate().catch(error => {
      this.templateInitialization = undefined;
      throw error;
    });

    const templateDir = await this.templateInitialization;
    await mkdir(dataDir, { recursive: true });
    await this.runCommand(['cp', '-r', `${templateDir}/.`, dataDir]);
    await this.prepareDirectoryForPostgres(dataDir);
  }

  async start(dataDir: string, port: number): Promise<void> {
    dataDir = resolve(dataDir);
    await this.stop(dataDir);
    await this.stopStaleServer(dataDir);
    await this.prepareDirectoryForPostgres(dataDir);

    const child = Bun.spawn(
      this.buildUnprivilegedCommand(this.requireBinary('postgres'), [
        '-D',
        dataDir,
        '-c',
        `port=${port}`,
        '-c',
        'listen_addresses=*',
        '-c',
        `unix_socket_directories=${dataDir}`,
      ]),
      { stdout: 'ignore', stderr: 'ignore' }
    );

    try {
      await this.waitForAdminConnection(dataDir, port, child);
      this.servers.set(dataDir, child);
    } catch (error) {
      child.kill('SIGINT');
      await child.exited;
      this.logger.warn(`Postgres on port ${port} did not become ready; its child has been stopped`);
      throw error;
    }
  }

  async stop(dataDir: string): Promise<void> {
    dataDir = resolve(dataDir);
    const child = this.servers.get(dataDir);

    if (child == null) return;

    child.kill('SIGINT');
    await child.exited;
    this.servers.delete(dataDir);
  }

  async stopStaleServer(dataDir: string): Promise<void> {
    dataDir = resolve(dataDir);
    const pidFile = Bun.file(join(dataDir, 'postmaster.pid'));

    if (!(await pidFile.exists())) return;

    const [pidLine, recordedDirectory] = (await pidFile.text()).split('\n');
    const pid = Number(pidLine);

    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
      throw new Error('Refusing to signal an invalid Postgres pid');
    }

    if (this.isPidAlive(pid)) {
      if (recordedDirectory !== dataDir) {
        throw new Error('Refusing to stop a Postgres pid belonging to a different data directory');
      }

      this.signalPid(pid, 'SIGQUIT');

      if (!(await this.waitForPidExit(pid))) {
        this.signalPid(pid, 'SIGKILL');

        if (!(await this.waitForPidExit(pid))) {
          throw new Error('Stale Postgres process did not exit; pid file has been retained');
        }
      }

      this.logger.warn('Stopped an orphaned Postgres server; its data directory can be restarted');
    }

    await rm(join(dataDir, 'postmaster.pid'), { force: true });
  }

  openAdminConnection(dataDir: string, port: number): SQL {
    // Bun 1.3.4 needs the socket filename, not its directory or a URL host parameter.
    return new SQL({
      url: `postgres://kinglet_admin:x@localhost:${port}/postgres`,
      path: join(resolve(dataDir), `.s.PGSQL.${port}`),
      tls: false,
      connectionTimeout: 1,
    });
  }

  private resolveBinDir(): string | null {
    if (this.options.binDir != null) return resolve(this.options.binDir);

    const configured = this.readPgConfig('--bindir');

    if (configured != null) return configured;

    const postgres = Bun.which('postgres');

    return postgres == null ? null : dirname(postgres);
  }

  private readPgConfig(option: string): string | null {
    const pgConfig = Bun.which('pg_config');

    if (pgConfig == null) return null;

    const result = Bun.spawnSync([pgConfig, option], { stderr: 'ignore' });
    const value = result.stdout.toString().trim();

    return result.exitCode === 0 && value.length > 0 ? value : null;
  }

  private requireBinary(name: string): string {
    const binDir = this.resolveBinDir();
    const binary = binDir == null ? null : Bun.which(join(binDir, name));

    if (binary == null) throw new Error(`Postgres binary ${name} is unavailable`);

    return binary;
  }

  private buildUnprivilegedCommand(binary: string, args: string[]): string[] {
    const command = [binary, ...args];

    return process.getuid?.() === 0
      ? ['setpriv', '--reuid=bun', '--regid=bun', '--init-groups', ...command]
      : command;
  }

  private async prepareDirectoryForPostgres(directory: string): Promise<void> {
    await chmod(directory, 0o700);

    if (process.getuid?.() === 0) {
      await this.runCommand(['chown', '-R', 'bun:bun', directory]);
    }
  }

  private async initializeTemplate(): Promise<string> {
    const templateDir =
      this.options.templateDir == null
        ? await mkdtemp(join(tmpdir(), 'kinglet-pg-template-'))
        : resolve(this.options.templateDir);
    await mkdir(templateDir, { recursive: true });
    await this.prepareDirectoryForPostgres(templateDir);

    if (!(await Bun.file(join(templateDir, 'PG_VERSION')).exists())) {
      await this.runCommand(
        this.buildUnprivilegedCommand(this.requireBinary('initdb'), [
          '-D',
          templateDir,
          '-U',
          'kinglet_admin',
          '-A',
          'trust',
          '--no-sync',
          '-E',
          'UTF8',
          '--locale=C',
        ])
      );
    }

    await Bun.write(
      join(templateDir, 'pg_hba.conf'),
      'local all kinglet_admin trust\nhost all all 0.0.0.0/0 scram-sha-256\nhost all all ::/0 scram-sha-256\n'
    );
    const shareDir = this.readPgConfig('--sharedir');
    const hasStatisticsExtension =
      shareDir != null &&
      (await Bun.file(join(shareDir, 'extension', 'pg_stat_statements.control')).exists());
    await Bun.write(
      join(templateDir, 'postgresql.auto.conf'),
      "password_encryption='scram-sha-256'\n" +
        (hasStatisticsExtension ? "shared_preload_libraries='pg_stat_statements'\n" : '')
    );
    await this.prepareDirectoryForPostgres(templateDir);

    return templateDir;
  }

  private async runCommand(command: string[]): Promise<void> {
    const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' });

    if ((await child.exited) !== 0) {
      throw new Error(`Postgres setup command ${command[0]} failed`);
    }
  }

  private async waitForAdminConnection(
    dataDir: string,
    port: number,
    child: Subprocess
  ): Promise<void> {
    const deadline = Date.now() + (this.options.readinessTimeoutMs ?? 5000);

    while (Date.now() < deadline) {
      if (child.exitCode != null || child.signalCode != null) {
        throw new Error('Postgres exited before becoming ready');
      }

      if (await isPortListening(port)) {
        let sql: SQL | undefined;

        try {
          sql = this.openAdminConnection(dataDir, port);
          await sql`select 1`;

          if (child.exitCode == null && child.signalCode == null) return;
        } catch {
          // The listener opens before Postgres finishes recovery and accepts queries.
        } finally {
          await sql?.close({ timeout: 0 });
        }
      }

      await Bun.sleep(50);
    }

    throw new Error('Postgres did not become ready before the readiness timeout');
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);

      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'ESRCH') return false;

      throw error;
    }
  }

  private signalPid(pid: number, signal: 'SIGQUIT' | 'SIGKILL'): void {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as { code?: string }).code !== 'ESRCH') throw error;
    }
  }

  private async waitForPidExit(pid: number): Promise<boolean> {
    const deadline = Date.now() + 2000;

    while (this.isPidAlive(pid)) {
      if (Date.now() >= deadline) return false;

      await Bun.sleep(25);
    }

    return true;
  }
}
