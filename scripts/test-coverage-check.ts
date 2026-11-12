/**
 * Coverage gate for CI.
 *
 * <p>Real-Postgres tests spawn child processes and hold disk state; running
 * them in a second process keeps that overhead off the rest of the suite.
 * The two lcov reports are merged before the aggregate gate.
 */

import { mkdir } from 'node:fs/promises';
import { Glob } from 'bun';
import { mergeLcov } from './lib/merge-lcov.ts';

const HEAVY_FILES = new Set([
  'src/services/alloydb/index.test.ts',
  'src/services/cloudsql/index.test.ts',
]);

const ROOTS = ['src', 'test-utils', 'scripts'];

/** Postgres data-plane tests and service wiring tests run in the heavy process. */
export function isHeavyCoverageTest(path: string): boolean {
  return path.startsWith('src/shared/postgres-data-plane/') || HEAVY_FILES.has(path);
}

export async function collectTestFiles(): Promise<{ light: string[]; heavy: string[] }> {
  const light: string[] = [];
  const heavy: string[] = [];
  const glob = new Glob('**/*.test.ts');

  for (const root of ROOTS) {
    for await (const relative of glob.scan({ cwd: root, onlyFiles: true })) {
      const path = `${root}/${relative}`;

      if (isHeavyCoverageTest(path)) {
        heavy.push(path);
      } else {
        light.push(path);
      }
    }
  }

  light.sort();
  heavy.sort();

  return { light, heavy };
}

/** Bun's panic handler exits 132. A segfault is 139. Both are Bun crashes, not test failures. */
export function shouldRetryCrashedSuite(exitCode: number, attempt: number): boolean {
  return attempt === 1 && (exitCode === 132 || exitCode === 139);
}

async function runSuite(label: string, files: string[], attempt = 1): Promise<string> {
  console.log(`\n== ${label} (${files.length} files) ==`);

  const child = Bun.spawn(['bun', 'test', '--coverage', ...files], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;

  if (exitCode !== 0) {
    if (shouldRetryCrashedSuite(exitCode ?? 1, attempt)) {
      console.error(`${label} crashed (exit ${exitCode}); retrying once`);

      return runSuite(label, files, attempt + 1);
    }

    process.exit(exitCode ?? 1);
  }

  return Bun.file('coverage/lcov.info').text();
}

async function main(): Promise<void> {
  const { light, heavy } = await collectTestFiles();

  if (light.length === 0 || heavy.length === 0) {
    console.error('Expected both a main suite and a Postgres suite');
    process.exit(1);
  }

  await mkdir('coverage', { recursive: true });

  const lightReport = await runSuite('main suite', light);
  const heavyReport = await runSuite('Postgres suite', heavy);
  const merged = mergeLcov([lightReport, heavyReport]);

  await Bun.write('coverage/lcov.info', merged);

  const gate = Bun.spawn(['bun', 'run', 'scripts/check-coverage.ts'], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const gateExit = await gate.exited;

  process.exit(gateExit ?? 1);
}

if (import.meta.main) {
  await main();
}
