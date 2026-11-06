/**
 * Fail when a numbered local aliases an existing binding to the same expression.
 */

import { Glob } from 'bun';
import { findCopyPasteAliases } from './lib/copy-paste-aliases.ts';

const ROOTS = ['src', 'scripts', 'e2e', 'test-utils'];

async function main(): Promise<void> {
  const findings = [];

  for (const root of ROOTS) {
    const glob = new Glob(`${root}/**/*.ts`);

    for await (const fileName of glob.scan('.')) {
      const sourceText = await Bun.file(fileName).text();

      findings.push(...findCopyPasteAliases(sourceText, fileName));
    }
  }

  if (findings.length === 0) {
    console.log('No copy-paste numbered aliases found.');

    return;
  }

  for (const finding of findings) {
    console.error(
      `${finding.fileName}:${finding.line} ${finding.alias} rebinds ${finding.original} to the same expression`
    );
  }

  process.exit(1);
}

if (import.meta.main) {
  await main();
}
