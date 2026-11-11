import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SQL } from 'bun';
import { Logger } from '@/shared/utils/logger.ts';
import { isPortListening } from '@/shared/utils/port-allocator.ts';
import { isRealPostgresAvailable } from '../../../test-utils/postgres.ts';
import {
  classifyPostmasterArgs,
  classifyPsCommand,
  PostgresProcessManager,
  preferredServerBinDir,
} from './postgres-process-manager.ts';

describe('preferredServerBinDir', () => {
  test('prefers the newest server over an older pg_config bindir', () => {
    expect(
      preferredServerBinDir([
        { directory: '/usr/lib/postgresql/16/bin', version: 16, hasServer: true },
        { directory: '/usr/bin', version: null, hasServer: true },
        { directory: '/usr/lib/postgresql/18/bin', version: 18, hasServer: true },
      ])
    ).toBe('/usr/lib/postgresql/18/bin');
  });

  test('ignores a version directory that has no server binaries', () => {
    expect(
      preferredServerBinDir([
        { directory: '/usr/lib/postgresql/18/bin', version: 18, hasServer: false },
        { directory: '/usr/lib/postgresql/16/bin', version: 16, hasServer: true },
      ])
    ).toBe('/usr/lib/postgresql/16/bin');
  });

  test('uses an unversioned binary when no versioned server exists', () => {
    expect(
      preferredServerBinDir([{ directory: '/usr/local/bin', version: null, hasServer: true }])
    ).toBe('/usr/local/bin');
  });
});

describe('Postgres command construction', () => {
  test('reports an unavailable explicit binary directory', () => {
    const manager = new PostgresProcessManager(new Logger('test'), {
      binDir: '/nonexistent-kinglet-postgres-bin',
    });

    expect(manager.isPostgresAvailable()).toBe(false);
  });

  test('drops root privileges for initdb and postgres only', () => {
    const manager = new PostgresProcessManager(new Logger('test'), { templateDir: '/template' });
    const uid = spyOn(process, 'getuid').mockReturnValue(0);
    const commandBuilder = 'buildUnprivilegedCommand';

    try {
      expect(manager[commandBuilder]('/bin/postgres', ['-D', '/data'])).toEqual([
        'setpriv',
        '--reuid=bun',
        '--regid=bun',
        '--init-groups',
        '/bin/postgres',
        '-D',
        '/data',
      ]);
      expect(manager[commandBuilder]('/bin/initdb', ['-D', '/template'])).toEqual([
        'setpriv',
        '--reuid=bun',
        '--regid=bun',
        '--init-groups',
        '/bin/initdb',
        '-D',
        '/template',
      ]);
    } finally {
      uid.mockRestore();
    }
  });
});

describe('Postgres process cleanup', () => {
  test('classifies a postmaster without signaling an unreadable command', () => {
    const dataDir = '/tmp/kinglet/data';

    expect(classifyPostmasterArgs([], dataDir)).toBe('unknown');
    expect(classifyPostmasterArgs(['/usr/bin/bun', '-e', '1'], dataDir)).toBe('other');
    expect(
      classifyPostmasterArgs(['/usr/lib/postgresql/18/bin/postgres', '-D', dataDir], dataDir)
    ).toBe('match');
    expect(classifyPostmasterArgs(['postgres', '-D', '/other'], dataDir)).toBe('other');
    expect(classifyPostmasterArgs(['postgres'], dataDir)).toBe('unknown');
    expect(classifyPsCommand('', dataDir)).toBe('unknown');
    expect(classifyPsCommand('/usr/bin/bun -e 1', dataDir)).toBe('other');
    expect(
      classifyPsCommand(`/usr/lib/postgresql/18/bin/postgres -D ${dataDir} -c port=1`, dataDir)
    ).toBe('match');
    expect(classifyPsCommand('postgres -D /elsewhere', dataDir)).toBe('other');
    expect(classifyPsCommand('postgres -D /tmp/my data -c port=1', '/tmp/my data')).toBe('unknown');
    expect(classifyPsCommand('postgres -c note=-D /tmp/my data -D /other', '/tmp/my data')).toBe(
      'unknown'
    );
  });

  test('does not follow a socket symlink when changing permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-pg-link-'));
    const sentinel = join(root, 'sentinel');
    const link = join(root, 'link');

    await mkdir(sentinel);
    await chmod(sentinel, 0o755);
    await symlink(sentinel, link);
    const manager = new PostgresProcessManager(new Logger('postgres-test', 'error'));
    const prepare = manager as unknown as {
      prepareDirectoryForPostgres(directory: string): Promise<void>;
    };

    try {
      await expect(prepare.prepareDirectoryForPostgres(link)).rejects.toThrow(/permissions/);
      expect((await lstat(sentinel)).mode & 0o777).toBe(0o755);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('creates a private socket directory another manager can find', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-pg-sock-'));
    const dataDir = join(root, 'data');

    await mkdir(dataDir);
    const manager = new PostgresProcessManager(new Logger('postgres-test', 'error'));
    const created = manager as unknown as {
      createSocketDirectory(directory: string): Promise<string>;
      socketDirectory(directory: string): string;
    };
    const other = new PostgresProcessManager(new Logger('postgres-test', 'error')) as unknown as {
      socketDirectory(directory: string): string;
    };

    try {
      const socketDir = await created.createSocketDirectory(resolve(dataDir));
      const info = await lstat(socketDir);

      expect(socketDir.startsWith(join(resolve(tmpdir()), 'kpg-'))).toBe(true);
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o777).toBe(0o700);
      expect(other.socketDirectory(resolve(dataDir))).toBe(socketDir);
      expect(created.socketDirectory(resolve(dataDir))).toBe(socketDir);
    } finally {
      await manager.stop(dataDir);
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not remove a live server socket directory before the pid is identified', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-pg-live-'));
    const dataDir = resolve(join(root, 'data'));

    await mkdir(dataDir);
    const manager = new PostgresProcessManager(new Logger('postgres-test', 'error'));
    const created = manager as unknown as {
      createSocketDirectory(directory: string): Promise<string>;
    };
    const bystander = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)']);

    try {
      const socketDir = await created.createSocketDirectory(dataDir);

      await Bun.write(join(dataDir, 'postmaster.pid'), `${bystander.pid}\n${dataDir}\n`);
      await manager.stop(dataDir);
      expect((await lstat(socketDir)).isDirectory()).toBe(true);
    } finally {
      bystander.kill();
      await bystander.exited;
      await rm(join(dataDir, 'postmaster.pid'), { force: true });
      await manager.stop(dataDir);
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a start that refuses an unconfirmed pid leaves that server socket directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-pg-unknown-'));
    const dataDir = resolve(join(root, 'data'));

    const bin = join(root, 'bin');
    const sleep = Bun.which('sleep');

    await mkdir(dataDir);
    await mkdir(bin);

    if (sleep == null) throw new Error('sleep is required to impersonate a postmaster');

    // argv[0] is already postgres. `exec -a` inside bash is still `bash` in
    // /proc until the exec lands, and that window classifies the pid as other.
    await symlink(sleep, join(bin, 'postgres'));
    const manager = new PostgresProcessManager(new Logger('postgres-test', 'error'));
    const created = manager as unknown as {
      createSocketDirectory(directory: string): Promise<string>;
    };
    const postmaster = Bun.spawn([join(bin, 'postgres'), '30']);

    try {
      const socketDir = await created.createSocketDirectory(dataDir);

      await Bun.write(join(dataDir, 'postmaster.pid'), `${postmaster.pid}\n${dataDir}\n`);
      await expect(manager.start(dataDir, 1)).rejects.toThrow(/could not be confirmed/);
      expect(postmaster.exitCode).toBeNull();
      expect(postmaster.signalCode).toBeNull();
      expect((await lstat(socketDir)).isDirectory()).toBe(true);
    } finally {
      postmaster.kill();
      await postmaster.exited;
      await rm(join(dataDir, 'postmaster.pid'), { force: true });
      await manager.stop(dataDir);
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not signal a live process that is not the postmaster', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-pg-pid-'));
    const dataDir = join(root, 'data');
    await mkdir(dataDir);
    const manager = new PostgresProcessManager(new Logger('postgres-test', 'error'));
    const bystander = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)']);

    try {
      await Bun.write(join(dataDir, 'postmaster.pid'), `${bystander.pid}\n${resolve(dataDir)}\n`);
      await manager.stopStaleServer(dataDir);

      expect(bystander.exitCode).toBeNull();
      expect(bystander.signalCode).toBeNull();
      expect(await Bun.file(join(dataDir, 'postmaster.pid')).exists()).toBe(false);
    } finally {
      bystander.kill();
      await bystander.exited;
      await rm(root, { recursive: true, force: true });
    }
  });

  test('includes the child error output when initdb fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-pg-err-'));
    const binDir = join(root, 'bin');
    await mkdir(binDir);
    await Bun.write(
      join(binDir, 'initdb'),
      '#!/bin/sh\necho "initdb: data directory is not empty" >&2\nexit 1\n'
    );
    await Bun.write(join(binDir, 'postgres'), '#!/bin/sh\nexit 1\n');
    await chmod(join(binDir, 'initdb'), 0o755);
    await chmod(join(binDir, 'postgres'), 0o755);
    const manager = new PostgresProcessManager(new Logger('postgres-test', 'error'), {
      binDir,
      templateDir: join(root, 'template'),
    });

    try {
      await expect(manager.ensureInitialized(join(root, 'data'))).rejects.toThrow(
        'data directory is not empty'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!isRealPostgresAvailable)('PostgresProcessManager', () => {
  let root: string;
  let dataDir: string;
  let templateDir: string;
  let manager: PostgresProcessManager;
  const directories: string[] = [];

  async function freePort(): Promise<number> {
    const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const port = listener.port;
    listener.stop(true);

    return port;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kinglet-pg-'));
    dataDir = join(root, 'data');
    templateDir = join(root, 'template');
    manager = new PostgresProcessManager(new Logger('postgres-test', 'error'), {
      templateDir,
      readinessTimeoutMs: 2000,
    });
    directories.push(dataDir);
  });

  afterEach(async () => {
    for (const dir of directories.splice(0)) await manager.stop(dir);
    await rm(root, { recursive: true, force: true });
  });

  test('initializes, starts, queries and stops a real server', async () => {
    const port = await freePort();
    await manager.ensureInitialized(dataDir);
    await manager.start(dataDir, port);
    const sql = manager.openAdminConnection(dataDir, port);

    try {
      expect(await sql<{ value: number }[]>`select 1 as value`).toEqual([
        expect.objectContaining({ value: 1 }),
      ]);
      expect(await sql<{ password_encryption: string }[]>`show password_encryption`).toEqual([
        expect.objectContaining({ password_encryption: 'scram-sha-256' }),
      ]);
      expect(await isPortListening(port)).toBe(true);
    } finally {
      await sql.close();
    }

    await manager.stop(dataDir);
    expect(await isPortListening(port)).toBe(false);
    await manager.stop(dataDir);
  });

  test('a failed copy does not make the next start skip the rest of the cluster', async () => {
    await manager.ensureInitialized(dataDir);
    const broken = join(root, 'broken');
    const runnable = manager as unknown as {
      runCommand(command: string[]): Promise<void>;
    };
    const original = runnable.runCommand.bind(runnable);
    const copy = spyOn(runnable, 'runCommand').mockImplementation(async (command: string[]) => {
      if (command[0] !== 'cp') return original(command);

      const destination = command[command.length - 1];

      if (destination != null) {
        await mkdir(destination, { recursive: true });
        await Bun.write(join(destination, 'PG_VERSION'), '18\n');
      }

      throw new Error('cp failed');
    });

    try {
      await expect(manager.ensureInitialized(broken)).rejects.toThrow('cp failed');
      expect(await Bun.file(join(broken, 'PG_VERSION')).exists()).toBe(false);
    } finally {
      copy.mockRestore();
    }

    await manager.ensureInitialized(broken);
    expect(await Bun.file(join(broken, 'PG_VERSION')).exists()).toBe(true);
    expect(await Bun.file(join(broken, 'postgresql.conf')).exists()).toBe(true);
  });

  test('starts when the data directory path is longer than a unix socket name', async () => {
    const port = await freePort();
    const longData = join(root, 'p'.repeat(120), 'data');
    await manager.ensureInitialized(longData);
    await manager.start(longData, port);
    const sql = manager.openAdminConnection(longData, port);

    try {
      expect((await sql<{ value: number }[]>`select 1 as value`)[0]?.value).toBe(1);
    } finally {
      await sql.close();
      await manager.stop(longData);
    }
  });

  test('copies the initialized template without running initdb again', async () => {
    await manager.ensureInitialized(dataDir);
    await Bun.write(join(templateDir, 'template-marker'), 'copied');
    const second = join(root, 'second');
    await manager.ensureInitialized(second);

    expect(await Bun.file(join(second, 'PG_VERSION')).exists()).toBe(true);
    expect(await Bun.file(join(second, 'template-marker')).text()).toBe('copied');
    await Bun.write(join(second, 'keep'), 'existing');
    await manager.ensureInitialized(second);
    expect(await Bun.file(join(second, 'keep')).text()).toBe('existing');
  });

  test('does not mistake an occupied port for a ready child', async () => {
    const port = await freePort();
    await manager.ensureInitialized(dataDir);
    await manager.start(dataDir, port);
    const other = join(root, 'other');
    directories.push(other);
    await manager.ensureInitialized(other);
    await expect(manager.start(other, port)).rejects.toThrow();
    expect(await isPortListening(port)).toBe(true);
  });

  test('rejects an exited child even when another server answers the readiness probe', async () => {
    const port = await freePort();
    await manager.ensureInitialized(dataDir);
    await manager.start(dataDir, port);
    const deadChild = Bun.spawn([process.execPath, '-e', 'process.exit(0)']);
    await deadChild.exited;
    const waitForReadiness = 'waitForAdminConnection';
    const admin = spyOn(manager, 'openAdminConnection');

    try {
      await expect(manager[waitForReadiness](dataDir, port, deadChild)).rejects.toThrow(
        'exited before becoming ready'
      );
      expect(admin).not.toHaveBeenCalled();
    } finally {
      admin.mockRestore();
    }
  });

  test('kills and reaps a child when admin readiness times out', async () => {
    const port = await freePort();
    await manager.ensureInitialized(dataDir);
    const admin = spyOn(manager, 'openAdminConnection').mockImplementation(() => {
      throw new Error('admin unavailable');
    });

    try {
      await expect(manager.start(dataDir, port)).rejects.toThrow('readiness timeout');
      expect(admin).toHaveBeenCalled();
      expect(await isPortListening(port)).toBe(false);
      expect(await Bun.file(join(dataDir, 'postmaster.pid')).exists()).toBe(false);
    } finally {
      admin.mockRestore();
    }
  });

  test('reclaims an orphaned server and removes a dead stale pid file', async () => {
    const port = await freePort();
    await manager.ensureInitialized(dataDir);
    const postgres = (manager as unknown as { requireBinary(name: string): string }).requireBinary(
      'postgres'
    );
    const orphan = Bun.spawn(
      [postgres, '-D', dataDir, '-c', `port=${port}`, '-c', `unix_socket_directories=${dataDir}`],
      { stdout: 'ignore', stderr: 'ignore' }
    );

    try {
      for (let attempt = 0; attempt < 100 && !(await isPortListening(port)); attempt++) {
        await Bun.sleep(25);
      }
      expect(await isPortListening(port)).toBe(true);
      await manager.start(dataDir, port);
      const sql = manager.openAdminConnection(dataDir, port);

      try {
        expect((await sql`select 1 as value`)[0].value).toBe(1);
      } finally {
        await sql.close();
      }
    } finally {
      await manager.stop(dataDir);
      orphan.kill('SIGINT');
      await orphan.exited;
    }

    await Bun.write(join(dataDir, 'postmaster.pid'), '2147483647\n');
    await manager.stopStaleServer(dataDir);
    expect(await Bun.file(join(dataDir, 'postmaster.pid')).exists()).toBe(false);
  });

  test('accepts TCP logins with SCRAM passwords but rejects incorrect passwords', async () => {
    const port = await freePort();
    await manager.ensureInitialized(dataDir);
    await manager.start(dataDir, port);
    const admin = manager.openAdminConnection(dataDir, port);

    try {
      await admin`CREATE ROLE tcp_user LOGIN PASSWORD 'test-only-password'`;
      const tcp = new SQL({
        url: `postgres://tcp_user:test-only-password@127.0.0.1:${port}/postgres`,
        tls: false,
      });
      const wrong = new SQL({
        url: `postgres://tcp_user:incorrect@127.0.0.1:${port}/postgres`,
        tls: false,
        connectionTimeout: 1,
      });

      try {
        expect((await tcp`select current_user as name`)[0].name).toBe('tcp_user');
        // Bun's SQL queries are lazy; give the matcher a started native Promise.
        await expect(Promise.resolve(wrong`select 1`)).rejects.toThrow();
      } finally {
        await tcp.close({ timeout: 0 });
        await wrong.close({ timeout: 0 });
      }
    } finally {
      await admin.close({ timeout: 0 });
    }
  });
});
