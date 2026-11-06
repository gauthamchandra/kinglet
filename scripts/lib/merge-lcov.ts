/**
 * Combine lcov reports from separate `bun test --coverage` processes.
 *
 * <p>Bun 1.3.4 writes one process-wide report and does not emit per-function
 * hits, only `FNF`/`FNH`. Line hits are merged by taking the max count per
 * line. Function totals use the max of each side, which under-counts a
 * function hit in only one run when both runs cover the same file.
 */

interface LcovRecord {
  sourceFile: string;
  lines: Map<number, number>;
  functionsFound: number;
  functionsHit: number;
}

export function mergeLcov(reports: string[]): string {
  const byFile = new Map<string, LcovRecord>();

  for (const report of reports) {
    for (const record of parseLcov(report)) {
      const existing = byFile.get(record.sourceFile);

      if (existing == null) {
        byFile.set(record.sourceFile, record);
        continue;
      }

      for (const [line, hits] of record.lines) {
        existing.lines.set(line, Math.max(existing.lines.get(line) ?? 0, hits));
      }

      existing.functionsFound = Math.max(existing.functionsFound, record.functionsFound);
      existing.functionsHit = Math.min(
        existing.functionsFound,
        Math.max(existing.functionsHit, record.functionsHit)
      );
    }
  }

  const files = [...byFile.keys()].sort();
  const chunks: string[] = [];

  for (const file of files) {
    const record = byFile.get(file);

    if (record == null) {
      continue;
    }

    chunks.push(formatRecord(record));
  }

  return chunks.length === 0 ? '' : `${chunks.join('\n')}\n`;
}

function parseLcov(report: string): LcovRecord[] {
  const records: LcovRecord[] = [];
  let current: LcovRecord | undefined;

  for (const line of report.split('\n')) {
    if (line.startsWith('SF:')) {
      current = {
        sourceFile: line.substring(3),
        lines: new Map(),
        functionsFound: 0,
        functionsHit: 0,
      };
      continue;
    }

    if (current == null) {
      continue;
    }

    if (line === 'end_of_record') {
      records.push(current);
      current = undefined;
      continue;
    }

    if (line.startsWith('DA:')) {
      const [rawLine, rawHits] = line.substring(3).split(',');
      const lineNumber = Number(rawLine);
      const hits = Number(rawHits);

      if (Number.isInteger(lineNumber) && Number.isInteger(hits)) {
        current.lines.set(lineNumber, hits);
      }

      continue;
    }

    if (line.startsWith('FNF:')) {
      current.functionsFound = Number(line.substring(4)) || 0;
    } else if (line.startsWith('FNH:')) {
      current.functionsHit = Number(line.substring(4)) || 0;
    }
  }

  return records;
}

function formatRecord(record: LcovRecord): string {
  const lineNumbers = [...record.lines.keys()].sort((left, right) => left - right);
  let linesHit = 0;
  const daLines: string[] = [];

  for (const lineNumber of lineNumbers) {
    const hits = record.lines.get(lineNumber) ?? 0;

    if (hits > 0) {
      linesHit += 1;
    }

    daLines.push(`DA:${lineNumber},${hits}`);
  }

  return [
    'TN:',
    `SF:${record.sourceFile}`,
    `FNF:${record.functionsFound}`,
    `FNH:${record.functionsHit}`,
    ...daLines,
    `LF:${lineNumbers.length}`,
    `LH:${linesHit}`,
    'end_of_record',
  ].join('\n');
}
