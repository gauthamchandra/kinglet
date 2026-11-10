/**
 * The database flags that link `pg_stat_statements` into an instance.
 *
 * <p>PGlite preloads the module when it is handed to `PGlite.create`, and a
 * database built without it cannot `CREATE EXTENSION pg_stat_statements`
 * later. The flag is per instance, so the choice is made when that instance's
 * databases are opened and again when the flag flips (which restarts them).
 *
 * <p>Only the string `on` enables the module. Tuning flags such as
 * `pg_stat_statements.track` are stored by the control plane and not applied.
 */

export const CLOUDSQL_PG_STAT_STATEMENTS_FLAG = 'cloudsql.enable_pg_stat_statements';

export const ALLOYDB_PG_STAT_STATEMENTS_FLAG = 'alloydb.enable_pg_stat_statements';

/** Passed into the data plane when an instance's databases are opened. */
export interface PgStatStatementsOptions {
  pgStatStatements: boolean;
}

/**
 * Cloud SQL stores flags as sqladmin's `{name, value}` array on
 * `settings.databaseFlags`.
 */
export function cloudSqlPgStatStatementsEnabled(settings: unknown): boolean {
  if (settings == null || typeof settings !== 'object' || Array.isArray(settings)) return false;

  const flags = (settings as Record<string, unknown>).databaseFlags;

  if (!Array.isArray(flags)) return false;

  return flags.some(flag => isOn(flag, CLOUDSQL_PG_STAT_STATEMENTS_FLAG));
}

/** AlloyDB stores flags as a string map on the instance. */
export function alloyDbPgStatStatementsEnabled(databaseFlags: unknown): boolean {
  if (databaseFlags == null || typeof databaseFlags !== 'object' || Array.isArray(databaseFlags)) {
    return false;
  }

  return (databaseFlags as Record<string, unknown>)[ALLOYDB_PG_STAT_STATEMENTS_FLAG] === 'on';
}

function isOn(flag: unknown, name: string): boolean {
  if (flag == null || typeof flag !== 'object' || Array.isArray(flag)) return false;

  const entry = flag as Record<string, unknown>;

  return entry.name === name && entry.value === 'on';
}
