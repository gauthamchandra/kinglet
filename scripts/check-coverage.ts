/**
 * Aggregate coverage gate.
 *
 * <p>Reads the lcov report produced by `bun test --coverage` and fails if overall line or
 * function coverage across <code>src/</code> falls below {@link THRESHOLD_PERCENT}.
 *
 * <p><b>Why this exists instead of bunfig's `coverageThreshold`:</b> Bun applies
 * `coverageThreshold` <i>per file</i>, not to the aggregate. Setting it to 0.8 fails the run
 * because individual files sit below that (e.g. `src/config/schema.ts` is ~45% function
 * coverage — it is mostly Zod schema declarations with few callable functions), even though
 * the project overall is above 94%. A per-file floor is a reasonable thing to want, but it is
 * a different policy from the 80% aggregate this project actually enforces, and adopting it
 * would mean either failing the build or setting the floor so low it means nothing.
 *
 * <p>lcov is parsed rather than the text table because the text reporter's column layout is a
 * human-readable format with no stability guarantee.
 */

const THRESHOLD_PERCENT = 80;
const LCOV_PATH = 'coverage/lcov.info';

interface CoverageTotals {
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
}

/**
 * Sum lcov counters across every record whose source file lives under `src/`.
 *
 * <p>The lcov report also contains `e2e/` and `test-utils/` records — bunfig's
 * `coverageExclude` filters the text table but not the lcov output — and neither is
 * production code, so neither should move the number the gate reads.
 */
function sumSourceCoverage(lcov: string): CoverageTotals {
  const totals: CoverageTotals = {
    linesFound: 0,
    linesHit: 0,
    functionsFound: 0,
    functionsHit: 0,
  };

  let insideSourceRecord = false;

  for (const line of lcov.split('\n')) {
    if (line.startsWith('SF:')) {
      insideSourceRecord = line.substring(3).startsWith('src/');
      continue;
    }

    if (!insideSourceRecord) {
      continue;
    }

    const [tag, rawValue] = line.split(':');
    const value = Number(rawValue);

    if (Number.isNaN(value)) {
      continue;
    }

    if (tag === 'LF') {
      totals.linesFound += value;
    } else if (tag === 'LH') {
      totals.linesHit += value;
    } else if (tag === 'FNF') {
      totals.functionsFound += value;
    } else if (tag === 'FNH') {
      totals.functionsHit += value;
    }
  }

  return totals;
}

function toPercent(hit: number, found: number): number {
  return found === 0 ? 100 : (hit / found) * 100;
}

async function main(): Promise<void> {
  const lcovFile = Bun.file(LCOV_PATH);

  if (!(await lcovFile.exists())) {
    console.error(
      `No coverage report at ${LCOV_PATH}. Run \`bun test --coverage\` before this check.`
    );
    process.exit(1);
  }

  const totals = sumSourceCoverage(await lcovFile.text());

  if (totals.linesFound === 0) {
    console.error(`${LCOV_PATH} contained no src/ records. Coverage cannot be verified.`);
    process.exit(1);
  }

  const linePercent = toPercent(totals.linesHit, totals.linesFound);
  const functionPercent = toPercent(totals.functionsHit, totals.functionsFound);

  console.log(`Lines:     ${linePercent.toFixed(2)}% (${totals.linesHit}/${totals.linesFound})`);
  console.log(
    `Functions: ${functionPercent.toFixed(2)}% (${totals.functionsHit}/${totals.functionsFound})`
  );

  const failures: string[] = [];

  if (linePercent < THRESHOLD_PERCENT) {
    failures.push(`line coverage ${linePercent.toFixed(2)}% is below ${THRESHOLD_PERCENT}%`);
  }

  if (functionPercent < THRESHOLD_PERCENT) {
    failures.push(
      `function coverage ${functionPercent.toFixed(2)}% is below ${THRESHOLD_PERCENT}%`
    );
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`::error::Coverage check failed: ${failure}`);
    }

    process.exit(1);
  }

  console.log(`Coverage check passed (threshold ${THRESHOLD_PERCENT}%).`);
}

await main();
