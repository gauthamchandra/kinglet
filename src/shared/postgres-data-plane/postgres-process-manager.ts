import { constants, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
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
const SOCKET_RECORD = 'kinglet.socket-dir';

export class PostgresProcessManager {
  private servers = new Map<string, Subprocess>();
  private socketDirs = new Map<string, string>();
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
    const parent = dirname(dataDir);
    await mkdir(parent, { recursive: true });
    // Publish only a finished copy. PG_VERSION is copied before the rest of the
    // cluster, so a partial directory must not count as initialized.
    const staging = await mkdtemp(join(parent, '.kinglet-pg-'));

    try {
      await this.runCommand(['cp', '-r', `${templateDir}/.`, staging]);
      await this.prepareDirectoryForPostgres(staging);
      await rm(dataDir, { recursive: true, force: true });
      await rename(staging, dataDir);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async start(dataDir: string, port: number): Promise<void> {
    dataDir = resolve(dataDir);
    await this.stop(dataDir);
    await this.stopStaleServer(dataDir);
    await this.prepareDirectoryForPostgres(dataDir);
    const socketDir = await this.createSocketDirectory(dataDir);

    const stderr = new StderrTail();
    const child = Bun.spawn(
      this.buildUnprivilegedCommand(this.requireBinary('postgres'), [
        '-D',
        dataDir,
        '-c',
        `port=${port}`,
        '-c',
        'listen_addresses=*',
        '-c',
        `unix_socket_directories=${socketDir}`,
      ]),
      { stdout: 'ignore', stderr: 'pipe' }
    );
    const drained = this.collectStderr(child.stderr, stderr);

    try {
      await this.waitForAdminConnection(dataDir, port, child);
      this.servers.set(dataDir, child);
    } catch (error) {
      child.kill('SIGINT');
      await child.exited;
      await drained;
      const message = error instanceof Error ? error.message : 'Postgres did not become ready';
      this.logger.warn(`Postgres on port ${port} did not become ready; its child has been stopped`);
      await this.removeSocketDirectory(dataDir);
      throw new Error(withDetail(message, stderr.text()));
    }
  }

  async stop(dataDir: string): Promise<void> {
    dataDir = resolve(dataDir);
    const child = this.servers.get(dataDir);

    if (child != null) {
      child.kill('SIGINT');
      await child.exited;
      this.servers.delete(dataDir);
    }

    await this.removeSocketDirectory(dataDir);
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

      const identity = await this.postmasterIdentity(pid, dataDir);

      if (identity === 'unknown') {
        throw new Error('Refusing to stop a Postgres pid whose process could not be confirmed');
      }

      if (identity === 'other') {
        this.logger.warn(
          'A reused pid was recorded for this data directory; the live process was left running'
        );
      } else {
        this.signalPid(pid, 'SIGQUIT');

        if (!(await this.waitForPidExit(pid))) {
          this.signalPid(pid, 'SIGKILL');

          if (!(await this.waitForPidExit(pid))) {
            throw new Error('Stale Postgres process did not exit; pid file has been retained');
          }
        }

        this.logger.warn(
          'Stopped an orphaned Postgres server; its data directory can be restarted'
        );
      }
    }

    await rm(join(dataDir, 'postmaster.pid'), { force: true });
  }

  openAdminConnection(dataDir: string, port: number): SQL {
    // Bun 1.3.4 needs the socket filename, not its directory or a URL host parameter.
    return new SQL({
      url: `postgres://kinglet_admin:x@localhost:${port}/postgres`,
      path: join(this.socketDirectory(resolve(dataDir)), `.s.PGSQL.${port}`),
      tls: false,
      connectionTimeout: 1,
    });
  }

  private resolveBinDir(): string | null {
    if (this.options.binDir != null) return resolve(this.options.binDir);

    return preferredServerBinDir(this.binDirCandidates());
  }

  private binDirCandidates(): PostgresBinCandidate[] {
    const candidates: PostgresBinCandidate[] = [];
    const configured = this.readPgConfig('--bindir');

    if (configured != null) candidates.push(this.describeBinDir(configured));

    const postgres = Bun.which('postgres');

    if (postgres != null) candidates.push(this.describeBinDir(dirname(postgres)));

    // PGDG keeps each major version here and does not put the server on PATH.
    // A distro pg_config can point at an older client while 18 is installed beside it.
    try {
      for (const version of readdirSync('/usr/lib/postgresql')) {
        const major = Number(version);

        if (!Number.isInteger(major)) continue;

        candidates.push(this.describeBinDir(join('/usr/lib/postgresql', version, 'bin'), major));
      }
    } catch {
      // No PGDG layout on this machine.
    }

    return candidates;
  }

  private describeBinDir(directory: string, version?: number): PostgresBinCandidate {
    const hasServer = ['postgres', 'initdb'].every(
      name => Bun.which(join(directory, name)) != null
    );
    const parsed = version ?? postgresMajorVersion(directory);

    return {
      directory,
      version: parsed != null && Number.isInteger(parsed) ? parsed : null,
      hasServer,
    };
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
    let handle: Awaited<ReturnType<typeof open>>;

    try {
      // O_NOFOLLOW refuses a symlink, so chmod cannot land on a directory the
      // caller did not create.
      handle = await open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
    } catch (error) {
      throw new Error(`Refusing to change permissions for ${directory}`, { cause: error });
    }

    try {
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }

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

  private async createSocketDirectory(dataDir: string): Promise<string> {
    // A hash of the data directory is predictable in a shared tmp. mkdtemp
    // creates a new 0700 directory that no other user could have planted.
    await this.removeSocketDirectory(dataDir);
    const directory = await mkdtemp(join(tmpdir(), 'kpg-'));

    await this.prepareDirectoryForPostgres(directory);
    this.socketDirs.set(dataDir, directory);
    await Bun.write(join(dataDir, SOCKET_RECORD), `${directory}\n`);

    return directory;
  }

  private async removeSocketDirectory(dataDir: string): Promise<void> {
    const recorded = this.socketDirs.get(dataDir) ?? readSocketRecord(dataDir);

    this.socketDirs.delete(dataDir);
    await rm(join(dataDir, SOCKET_RECORD), { force: true });

    if (recorded == null || !isPrivateSocketPath(recorded)) return;

    let info: Awaited<ReturnType<typeof lstat>>;

    try {
      info = await lstat(recorded);
    } catch {
      return;
    }

    if (info.isSymbolicLink()) {
      await rm(recorded, { force: true });

      return;
    }

    if (info.isDirectory()) await rm(recorded, { recursive: true, force: true });
  }

  private socketDirectory(dataDir: string): string {
    const cached = this.socketDirs.get(dataDir);

    if (cached != null) return cached;

    const recorded = readSocketRecord(dataDir);

    if (recorded == null || !isPrivateSocketDirectory(recorded)) {
      throw new Error('Postgres admin socket directory is not recorded');
    }

    this.socketDirs.set(dataDir, recorded);

    return recorded;
  }

  private async postmasterIdentity(
    pid: number,
    dataDir: string
  ): Promise<'match' | 'other' | 'unknown'> {
    if (process.platform === 'linux')
      return classifyPostmasterArgs(await linuxCommandArgs(pid), dataDir);

    // macOS has no /proc. ps is the identity check, and a failed read stays unknown
    // so an unconfirmed pid is never signaled.
    if (process.platform === 'darwin') return classifyPsCommand(darwinCommandLine(pid), dataDir);

    return 'unknown';
  }

  private async runCommand(command: string[]): Promise<void> {
    const stderr = new StderrTail();
    const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'pipe' });
    const drained = this.collectStderr(child.stderr, stderr);
    const exitCode = await child.exited;
    await drained;

    if (exitCode !== 0) {
      throw new Error(withDetail(`Postgres setup command ${command[0]} failed`, stderr.text()));
    }
  }

  private collectStderr(
    stream: ReadableStream<Uint8Array> | number | null | undefined,
    stderr: StderrTail
  ): Promise<void> {
    if (stream == null || typeof stream === 'number') return Promise.resolve();

    const reader = stream.getReader();
    const decoder = new TextDecoder();

    return (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) return;

          if (value != null) stderr.append(decoder.decode(value, { stream: true }));
        }
      } catch {
        // The pipe closes when the child exits.
      }
    })();
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

class StderrTail {
  private value = '';

  append(chunk: string): void {
    this.value = (this.value + chunk).slice(-500);
  }

  text(): string {
    return this.value.trim();
  }
}

function withDetail(message: string, detail: string): string {
  return detail.length === 0 ? message : `${message}: ${detail}`;
}

function readSocketRecord(dataDir: string): string | null {
  try {
    const recorded = readFileSync(join(dataDir, SOCKET_RECORD), 'utf8').trim();

    return recorded.length === 0 ? null : recorded;
  } catch {
    return null;
  }
}

function socketPrefix(): string {
  return `${resolve(tmpdir())}${sep}kpg-`;
}

function isPrivateSocketPath(directory: string): boolean {
  return resolve(directory).startsWith(socketPrefix());
}

function isPrivateSocketDirectory(directory: string): boolean {
  const resolved = resolve(directory);

  if (!resolved.startsWith(socketPrefix())) return false;

  try {
    return lstatSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

async function linuxCommandArgs(pid: number): Promise<readonly string[]> {
  try {
    // /proc entries do not report as existing through Bun.file.exists().
    const cmdline = await Bun.file(`/proc/${pid}/cmdline`).text();

    if (cmdline.length === 0) return [];

    return cmdline.split('\0').filter(argument => argument.length > 0);
  } catch {
    return [];
  }
}

function darwinCommandLine(pid: number): string {
  const result = Bun.spawnSync(['ps', '-ww', '-o', 'args=', '-p', String(pid)], {
    stderr: 'ignore',
  });

  if (result.exitCode !== 0) return '';

  return result.stdout.toString();
}

/** `match` is this data directory's postmaster. `unknown` must not be signaled. */
export function classifyPostmasterArgs(
  args: readonly string[],
  dataDir: string
): 'match' | 'other' | 'unknown' {
  const executable = args[0];

  if (executable == null || executable.length === 0) return 'unknown';

  if (basename(executable) !== 'postgres') return 'other';

  const dataFlag = args.indexOf('-D');
  const recorded = dataFlag >= 0 ? args[dataFlag + 1] : undefined;

  if (recorded == null || recorded.length === 0) return 'unknown';

  return resolve(recorded) === resolve(dataDir) ? 'match' : 'other';
}

/** Parse `ps -o args=` without signaling when the data directory cannot be proved. */
export function classifyPsCommand(text: string, dataDir: string): 'match' | 'other' | 'unknown' {
  const trimmed = text.trim();

  if (trimmed.length === 0) return 'unknown';

  const executable = trimmed.split(/\s+/)[0];

  if (executable == null || basename(executable) !== 'postgres') return 'other';

  // ps joins arguments with spaces and does not quote them, so a data directory
  // that itself contains whitespace cannot be proved to be the -D argument.
  if (/\s/.test(dataDir)) return 'unknown';

  return classifyPostmasterArgs(trimmed.split(/\s+/), dataDir);
}

export interface PostgresBinCandidate {
  directory: string;
  version: number | null;
  hasServer: boolean;
}

/** Highest installed server. An unversioned PATH entry is only the fallback. */
export function preferredServerBinDir(candidates: readonly PostgresBinCandidate[]): string | null {
  const servers = candidates.filter(candidate => candidate.hasServer);
  const versioned = servers.filter(candidate => candidate.version != null);
  const pool = versioned.length > 0 ? versioned : servers;
  let best = pool[0];

  if (best == null) return null;

  for (const candidate of pool.slice(1)) {
    if ((candidate.version ?? -1) > (best.version ?? -1)) best = candidate;
  }

  return best.directory;
}

function postgresMajorVersion(directory: string): number | null {
  const match = directory.match(/postgresql(?:@|[/\\])(\d+)/);

  if (match?.[1] == null) return null;

  const version = Number(match[1]);

  return Number.isInteger(version) ? version : null;
}
