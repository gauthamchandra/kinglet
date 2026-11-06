/**
 * Coverage gate for CI.
 *
 * <p>Bun 1.3.4 runs the suite in one process, and `--max-concurrency` only
 * applies to `test.concurrent` / `--concurrent`, which this suite does not
 * use. PGlite keeps a large wasm heap after `close()`. Running those tests
 * in a second process keeps that heap off the rest of the suite. The two
 * lcov reports are merged before the aggregate gate.
 */

import { mkdir } from 'node:fs/promises';
import { Glob } from 'bun';
import { mergeLcov } from './lib/merge-lcov.ts';

const HEAVY_FILES = new Set([
  'src/services/alloydb/index.test.ts',
  'src/services/cloudsql/index.test.ts',
]);

const ROOTS = ['src', 'test-utils', 'scripts'];

/** PGlite boots live in these files. They run in their own process. */
export function isPgliteCoverageTest(path: string): boolean {
  return path.startsWith('src/shared/postgres-data-plane/') || HEAVY_FILES.has(path);
}

export async function collectTestFiles(): Promise<{ light: string[]; heavy: string[] }> {
  const light: string[] = [];
  const heavy: string[] = [];
  const glob = new Glob('**/*.test.ts');

  for (const root of ROOTS) {
    for await (const relative of glob.scan({ cwd: root, onlyFiles: true })) {
      const path = `${root}/${relative}`;

      if (isPgliteCoverageTest(path)) {
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

async function runSuite(label: string, files: string[]): Promise<string> {
  console.log(`\n== ${label} (${files.length} files) ==`);

  const child = Bun.spawn(['bun', 'test', '--coverage', ...files], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;

  if (exitCode !== 0) {
    process.exit(exitCode ?? 1);
  }

  return Bun.file('coverage/lcov.info').text();
}

async function main(): Promise<void> {
  const { light, heavy } = await collectTestFiles();

  if (light.length === 0 || heavy.length === 0) {
    console.error('Expected both a main suite and a PGlite suite');
    process.exit(1);
  }

  await mkdir('coverage', { recursive: true });

  const lightReport = await runSuite('main suite', light);
  const heavyReport = await runSuite('PGlite suite', heavy);
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
