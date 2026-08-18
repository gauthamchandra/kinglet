/**
 * Shared parsing for list-endpoint pagination query parameters.
 *
 * <p>GCP list APIs treat an unspecified or zero `pageSize` as "use the server
 * default" and reject negatives; this emulator collapses all of those to
 * `undefined` (no explicit limit) so a malformed value can never reach a
 * storage provider whose `if (limit)` check would otherwise drop the
 * `LIMIT`/`OFFSET` clause and return the whole table.
 */
/**
 * Rows a list endpoint returns when the caller names no `pageSize`.
 *
 * <p>Matches the limit every repository in this emulator falls back to, so a
 * handler that has to resolve the default itself — rather than handing an
 * absent `pageSize` down to a repository that would — stays consistent with
 * the rest of the API instead of quietly returning an unbounded list.
 */
export const DEFAULT_LIST_PAGE_SIZE = 100;

export function parsePageSize(raw: unknown): number | undefined {
  if (raw == null || raw === '') return undefined;

  const parsed = parseInt(String(raw), 10);

  return !Number.isNaN(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Resolve a pageToken to a non-negative row offset.
 *
 * <p>pageTokens are opaque offset strings in this emulator; a malformed one
 * (non-numeric or negative) means "start from the beginning" rather than a
 * bogus slice that could produce a self-referential nextPageToken.
 */
export function parseOffsetToken(raw: unknown): number {
  if (raw == null || raw === '') return 0;

  const parsed = parseInt(String(raw), 10);

  return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
}
