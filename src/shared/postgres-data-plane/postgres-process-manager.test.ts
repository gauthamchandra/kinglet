import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import { Logger } from '@/shared/utils/logger.ts';
import { isPortListening } from '@/shared/utils/port-allocator.ts';
import { isRealPostgresAvailable } from '../../../test-utils/postgres.ts';
import { PostgresProcessManager } from './postgres-process-manager.ts';

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
    const binDir = Bun.spawnSync(['pg_config', '--bindir']).stdout.toString().trim();
    const orphan = Bun.spawn(
      [
        join(binDir, 'postgres'),
        '-D',
        dataDir,
        '-c',
        `port=${port}`,
        '-c',
        `unix_socket_directories=${dataDir}`,
      ],
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
