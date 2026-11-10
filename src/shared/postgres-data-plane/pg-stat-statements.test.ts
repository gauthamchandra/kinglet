/**
 * Tests for the pg_stat_statements enable-flag parsers
 */

import { describe, expect, test } from 'bun:test';
import {
  ALLOYDB_PG_STAT_STATEMENTS_FLAG,
  alloyDbPgStatStatementsEnabled,
  CLOUDSQL_PG_STAT_STATEMENTS_FLAG,
  cloudSqlPgStatStatementsEnabled,
} from './pg-stat-statements.ts';

describe('cloudSqlPgStatStatementsEnabled', () => {
  test('is on only for the string on', () => {
    expect(
      cloudSqlPgStatStatementsEnabled({
        databaseFlags: [{ name: CLOUDSQL_PG_STAT_STATEMENTS_FLAG, value: 'on' }],
      })
    ).toBe(true);
    expect(
      cloudSqlPgStatStatementsEnabled({
        databaseFlags: [{ name: CLOUDSQL_PG_STAT_STATEMENTS_FLAG, value: 'off' }],
      })
    ).toBe(false);
    expect(
      cloudSqlPgStatStatementsEnabled({
        databaseFlags: [{ name: CLOUDSQL_PG_STAT_STATEMENTS_FLAG, value: 'ON' }],
      })
    ).toBe(false);
  });

  test('ignores a missing list and unrelated flags', () => {
    expect(cloudSqlPgStatStatementsEnabled(undefined)).toBe(false);
    expect(cloudSqlPgStatStatementsEnabled({})).toBe(false);
    expect(cloudSqlPgStatStatementsEnabled({ databaseFlags: 'on' })).toBe(false);
    expect(
      cloudSqlPgStatStatementsEnabled({
        databaseFlags: [
          { name: 'max_connections', value: '100' },
          null,
          { name: CLOUDSQL_PG_STAT_STATEMENTS_FLAG, value: 'on' },
        ],
      })
    ).toBe(true);
  });
});

describe('alloyDbPgStatStatementsEnabled', () => {
  test('is on only for the string on', () => {
    expect(alloyDbPgStatStatementsEnabled({ [ALLOYDB_PG_STAT_STATEMENTS_FLAG]: 'on' })).toBe(true);
    expect(alloyDbPgStatStatementsEnabled({ [ALLOYDB_PG_STAT_STATEMENTS_FLAG]: 'off' })).toBe(
      false
    );
    expect(alloyDbPgStatStatementsEnabled({ max_connections: '100' })).toBe(false);
    expect(alloyDbPgStatStatementsEnabled(undefined)).toBe(false);
    expect(alloyDbPgStatStatementsEnabled(['on'])).toBe(false);
  });
});
