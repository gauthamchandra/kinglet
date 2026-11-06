import { describe, expect, test } from 'bun:test';
import {
  collectTestFiles,
  isPgliteCoverageTest,
  shouldRetryCrashedSuite,
} from './test-coverage-check.ts';

describe('isPgliteCoverageTest', () => {
  test('keeps every postgres data-plane test in the heavy process', () => {
    expect(isPgliteCoverageTest('src/shared/postgres-data-plane/extensions.test.ts')).toBe(true);
    expect(
      isPgliteCoverageTest('src/shared/postgres-data-plane/pglite-database-manager.test.ts')
    ).toBe(true);
  });

  test('keeps the service files that boot a real data plane in the heavy process', () => {
    expect(isPgliteCoverageTest('src/services/cloudsql/index.test.ts')).toBe(true);
    expect(isPgliteCoverageTest('src/services/alloydb/index.test.ts')).toBe(true);
  });

  test('leaves the rest of the suite in the main process', () => {
    expect(isPgliteCoverageTest('src/services/cloudsql/service.test.ts')).toBe(false);
    expect(isPgliteCoverageTest('src/index.test.ts')).toBe(false);
    expect(isPgliteCoverageTest('test-utils/dev-dependencies.test.ts')).toBe(false);
  });
});

describe('shouldRetryCrashedSuite', () => {
  test('retries one Bun panic or segfault', () => {
    expect(shouldRetryCrashedSuite(132, 1)).toBe(true);
    expect(shouldRetryCrashedSuite(139, 1)).toBe(true);
  });

  test('does not retry a normal failure or a second crash', () => {
    expect(shouldRetryCrashedSuite(1, 1)).toBe(false);
    expect(shouldRetryCrashedSuite(132, 2)).toBe(false);
  });
});

describe('collectTestFiles', () => {
  test('splits the tree with no file in both suites', async () => {
    const { light, heavy } = await collectTestFiles();

    expect(heavy).toContain('src/services/cloudsql/index.test.ts');
    expect(heavy).toContain('src/services/alloydb/index.test.ts');
    expect(heavy).toContain('src/shared/postgres-data-plane/extensions.test.ts');
    expect(light).toContain('src/index.test.ts');
    expect(light.some(path => heavy.includes(path))).toBe(false);
    expect(light.length).toBeGreaterThan(0);
    expect(heavy.length).toBeGreaterThan(0);
  });
});
