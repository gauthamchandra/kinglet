/**
 * Shared parsing for list-endpoint pagination query parameters.
 *
 * <p>GCP list APIs treat an unspecified or zero `pageSize` as "use the server
 * default" and reject negatives; this emulator collapses all of those to
 * `undefined` (no explicit limit) so a malformed value can never reach a
 * storage provider whose `if (limit)` check would otherwise drop the
 * `LIMIT`/`OFFSET` clause and return the whole table.
 */
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
