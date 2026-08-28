/**
 * Verify generated API reference docs match the codebase.
 *
 * Runs after `generate-docs.ts --api-only`. Stages new files with
 * `git add --intent-to-add` so untracked pages are included in the diff.
 */

import { join } from 'node:path';

const API_REFERENCE_DIR = join(import.meta.dir, '../docs/reference/api');

async function main(): Promise<void> {
  await Bun.$`git add --intent-to-add ${API_REFERENCE_DIR}`.quiet();

  const diff = await Bun.$`git diff --exit-code ${API_REFERENCE_DIR}`.quiet().nothrow();

  if (diff.exitCode !== 0) {
    console.error(
      'Generated API reference docs are out of date. Run `bun run docs:generate:api` and commit the changes under docs/reference/api/.'
    );
    process.exit(1);
  }

  const untracked = await Bun.$`git ls-files --others --exclude-standard ${API_REFERENCE_DIR}`
    .quiet()
    .text();

  if (untracked.trim().length > 0) {
    console.error('Untracked generated API reference files remain after staging:\n', untracked);
    process.exit(1);
  }

  console.log('Generated API reference docs are up to date.');
}

if (import.meta.main) {
  await main();
}
