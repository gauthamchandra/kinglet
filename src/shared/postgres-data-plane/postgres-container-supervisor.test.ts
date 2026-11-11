import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  containerNameForTest,
  type DockerCommandRunner,
  PostgresContainerSupervisor,
} from './postgres-container-supervisor.ts';

function okRunner(calls: string[][] = []): DockerCommandRunner {
  return async (args: string[]) => {
    calls.push(args);

    return { exitCode: 0, stderr: '' };
  };
}

function failRunner(exitCode: number, stderr = ''): DockerCommandRunner {
  return async () => ({ exitCode, stderr });
}

describe('containerNameForTest', () => {
  test('is stable for the same resolved path', () => {
    const a = containerNameForTest('/tmp/kinglet-pg-abc/cloudsql/p/inst');
    const b = containerNameForTest('/tmp/kinglet-pg-abc/cloudsql/p/inst');

    expect(a).toBe(b);
  });

  test('differs for different paths', () => {
    const a = containerNameForTest('/tmp/kinglet-pg-abc/cloudsql/p/inst1');
    const b = containerNameForTest('/tmp/kinglet-pg-abc/cloudsql/p/inst2');

    expect(a).not.toBe(b);
  });

  test('starts with kinglet-pg-', () => {
    expect(containerNameForTest('/some/path')).toMatch(/^kinglet-pg-/);
  });
});

describe('PostgresContainerSupervisor.isPostgresAvailable', () => {
  test('returns false when docker is not on PATH', () => {
    const which = spyOn(Bun, 'which').mockReturnValue(null);

    try {
      const supervisor = new PostgresContainerSupervisor({
        image: 'postgres:18',
        runner: okRunner(),
      });

      expect(supervisor.isPostgresAvailable()).toBe(false);
    } finally {
      which.mockRestore();
    }
  });

  test('returns true when docker is on PATH', () => {
    const which = spyOn(Bun, 'which').mockReturnValue('/usr/bin/docker');

    try {
      const supervisor = new PostgresContainerSupervisor({
        image: 'postgres:18',
        runner: okRunner(),
      });

      expect(supervisor.isPostgresAvailable()).toBe(true);
    } finally {
      which.mockRestore();
    }
  });
});

describe('PostgresContainerSupervisor.ensureInitialized', () => {
  test('skips docker run when PG_VERSION already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-container-test-'));
    const calls: string[][] = [];

    try {
      await writeFile(join(root, 'PG_VERSION'), '18\n');
      const supervisor = new PostgresContainerSupervisor({
        image: 'postgres:18',
        runner: okRunner(calls),
      });

      await supervisor.ensureInitialized(root);

      expect(calls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('runs initdb via docker when directory is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-container-test-'));
    const calls: string[][] = [];

    try {
      await rm(root, { recursive: true, force: true });
      const supervisor = new PostgresContainerSupervisor({
        image: 'postgres:18',
        runner: okRunner(calls),
      });

      await supervisor.ensureInitialized(root);

      expect(calls).toHaveLength(1);
      const initCmd = calls[0];

      expect(initCmd).toBeDefined();
      expect(initCmd?.[0]).toBe('docker');
      expect(initCmd?.[1]).toBe('run');
      expect(initCmd).toContain('--rm');
      expect(initCmd).toContain('postgres:18');
      expect(initCmd).toContain('initdb');
      expect(initCmd).toContain('-U');
      expect(initCmd).toContain('kinglet_admin');
      expect(initCmd).toContain('-A');
      expect(initCmd).toContain('trust');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('passes --entrypoint empty string to bypass the docker entrypoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-container-test-'));
    const calls: string[][] = [];

    try {
      await rm(root, { recursive: true, force: true });
      const supervisor = new PostgresContainerSupervisor({
        image: 'postgres:18',
        runner: okRunner(calls),
      });

      await supervisor.ensureInitialized(root);

      const initCmd = calls[0];

      expect(initCmd).toBeDefined();
      const entryIdx = initCmd?.indexOf('--entrypoint') ?? -1;

      expect(entryIdx).toBeGreaterThanOrEqual(0);
      expect(initCmd?.[entryIdx + 1]).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('mounts the data directory into the container', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-container-test-'));
    const calls: string[][] = [];

    try {
      await rm(root, { recursive: true, force: true });
      const supervisor = new PostgresContainerSupervisor({
        image: 'postgres:18',
        runner: okRunner(calls),
      });

      await supervisor.ensureInitialized(root);

      const initCmd = calls[0];

      expect(initCmd).toBeDefined();

      const vIdx = initCmd?.indexOf('-v') ?? -1;

      expect(vIdx).toBeGreaterThanOrEqual(0);
      expect(initCmd?.[vIdx + 1]).toBe(`${resolve(root)}:/var/lib/postgresql/data`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('writes pg_hba.conf after initdb', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-container-test-'));

    try {
      await rm(root, { recursive: true, force: true });
      const supervisor = new PostgresContainerSupervisor({
        image: 'postgres:18',
        runner: okRunner(),
      });

      await supervisor.ensureInitialized(root);

      const hba = await Bun.file(join(root, 'pg_hba.conf')).text();

      expect(hba).toContain('kinglet_admin');
      expect(hba).toContain('trust');
      expect(hba).toContain('scram-sha-256');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('throws when docker initdb fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-container-test-'));

    try {
      await rm(root, { recursive: true, force: true });
      const supervisor = new PostgresContainerSupervisor({
        image: 'postgres:18',
        runner: failRunner(1, 'permission denied'),
      });

      const promise = supervisor.ensureInitialized(root);

      await expect(promise).rejects.toThrow(/initdb.*failed/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('PostgresContainerSupervisor.start', () => {
  test('removes any existing container then starts a new one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-container-test-'));
    const calls: string[][] = [];

    try {
      const supervisor = new PostgresContainerSupervisor({
        image: 'postgres:18',
        runner: okRunner(calls),
        readinessTimeoutMs: 0,
      });

      await supervisor.start(root, 54320).catch(() => {});

      const rmCall = calls.find(c => c[1] === 'rm');

      expect(rmCall).toBeDefined();
      expect(rmCall).toContain('-f');
      expect(rmCall).toContain(containerNameForTest(resolve(root)));

      const runCall = calls.find(c => c[1] === 'run' && c.includes('-d'));

      expect(runCall).toBeDefined();
      expect(runCall).toContain(containerNameForTest(resolve(root)));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('publishes the port bound to loopback only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-container-test-'));
    const calls: string[][] = [];

    try {
      const supervisor = new PostgresContainerSupervisor({
        image: 'postgres:18',
        runner: okRunner(calls),
        readinessTimeoutMs: 0,
      });

      await supervisor.start(root, 54321).catch(() => {});

      const runCall = calls.find(c => c[1] === 'run' && c.includes('-d'));

      expect(runCall).toBeDefined();
      const pIdx = runCall?.indexOf('-p') ?? -1;

      expect(pIdx).toBeGreaterThanOrEqual(0);
      expect(runCall?.[pIdx + 1]).toBe('127.0.0.1:54321:5432');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('mounts the data directory into the container', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-container-test-'));
    const calls: string[][] = [];

    try {
      const supervisor = new PostgresContainerSupervisor({
        image: 'postgres:18',
        runner: okRunner(calls),
        readinessTimeoutMs: 0,
      });

      await supervisor.start(root, 54322).catch(() => {});

      const runCall = calls.find(c => c[1] === 'run' && c.includes('-d'));

      expect(runCall).toBeDefined();
      const vIdx = runCall?.indexOf('-v') ?? -1;

      expect(vIdx).toBeGreaterThanOrEqual(0);
      expect(runCall?.[vIdx + 1]).toBe(`${resolve(root)}:/var/lib/postgresql/data`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('throws when docker run fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-container-test-'));

    try {
      const supervisor = new PostgresContainerSupervisor({
        image: 'postgres:18',
        runner: async (args: string[]) => {
          if (args[1] === 'run') return { exitCode: 1, stderr: 'no such image' };

          return { exitCode: 0, stderr: '' };
        },
      });

      const promise = supervisor.start(root, 54323);

      await expect(promise).rejects.toThrow(/failed/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('times out and stops the container when postgres is not ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-container-test-'));
    const calls: string[][] = [];

    try {
      const supervisor = new PostgresContainerSupervisor({
        image: 'postgres:18',
        runner: okRunner(calls),
        readinessTimeoutMs: 1,
      });

      const promise = supervisor.start(root, 54324);

      await expect(promise).rejects.toThrow(/ready/i);

      const stopCall = calls.find(c => c[1] === 'stop');

      expect(stopCall).toBeDefined();
      expect(stopCall).toContain(containerNameForTest(resolve(root)));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('PostgresContainerSupervisor.stop', () => {
  test('runs docker stop with the container name derived from the data directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-container-test-'));
    const calls: string[][] = [];

    try {
      const supervisor = new PostgresContainerSupervisor({
        image: 'postgres:18',
        runner: okRunner(calls),
      });

      await supervisor.stop(root);

      expect(calls).toHaveLength(1);
      const stopCall = calls[0];

      expect(stopCall?.[0]).toBe('docker');
      expect(stopCall?.[1]).toBe('stop');
      expect(stopCall).toContain(containerNameForTest(resolve(root)));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not throw when docker stop fails (container already stopped)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-container-test-'));

    try {
      const supervisor = new PostgresContainerSupervisor({
        image: 'postgres:18',
        runner: failRunner(1, 'No such container'),
      });

      await expect(supervisor.stop(root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('PostgresContainerSupervisor.openAdminConnection', () => {
  test('connects over TCP to the published port, not via unix socket', () => {
    const supervisor = new PostgresContainerSupervisor({
      image: 'postgres:18',
      runner: okRunner(),
    });
    const sql = supervisor.openAdminConnection('/some/data', 54325);

    expect(sql).toBeDefined();
    sql.close({ timeout: 0 }).catch(() => {});
  });
});
