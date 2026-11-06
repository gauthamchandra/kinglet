import { describe, expect, test } from 'bun:test';
import { mergeLcov } from './merge-lcov.ts';

describe('mergeLcov', () => {
  test('keeps records from both reports', () => {
    const merged = mergeLcov([
      ['TN:', 'SF:src/a.ts', 'FNF:1', 'FNH:1', 'DA:1,1', 'LF:1', 'LH:1', 'end_of_record'].join(
        '\n'
      ),
      ['TN:', 'SF:src/b.ts', 'FNF:2', 'FNH:0', 'DA:4,0', 'LF:1', 'LH:0', 'end_of_record'].join(
        '\n'
      ),
    ]);

    expect(merged).toContain('SF:src/a.ts');
    expect(merged).toContain('SF:src/b.ts');
    expect(merged.indexOf('SF:src/a.ts')).toBeLessThan(merged.indexOf('SF:src/b.ts'));
  });

  test('takes the higher hit count when both reports cover a line', () => {
    const merged = mergeLcov([
      [
        'TN:',
        'SF:src/a.ts',
        'FNF:2',
        'FNH:1',
        'DA:1,0',
        'DA:2,3',
        'LF:2',
        'LH:1',
        'end_of_record',
      ].join('\n'),
      [
        'TN:',
        'SF:src/a.ts',
        'FNF:2',
        'FNH:2',
        'DA:1,4',
        'DA:2,1',
        'LF:2',
        'LH:2',
        'end_of_record',
      ].join('\n'),
    ]);

    expect(merged).toContain('DA:1,4');
    expect(merged).toContain('DA:2,3');
    expect(merged).toContain('LF:2');
    expect(merged).toContain('LH:2');
    expect(merged).toContain('FNF:2');
    expect(merged).toContain('FNH:2');
  });

  test('returns an empty string when every report is empty', () => {
    expect(mergeLcov(['', 'not lcov'])).toBe('');
  });
});
