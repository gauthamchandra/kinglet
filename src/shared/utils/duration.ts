/**
 * GCP-style duration string parsing.
 *
 * GCP APIs represent durations as strings like "5s", "0.100s", "3600s".
 * This module provides a single parser shared across all service emulations.
 */

/**
 * Parse a GCP-style duration string (e.g., "5s", "0.100s") into seconds.
 */
export function parseDurationSeconds(duration: string): number {
  const match = duration.match(/^(\d+(?:\.\d+)?)s$/);

  if (!match) {
    throw new Error(`Invalid duration format: "${duration}". Expected format like "5s" or "3600s"`);
  }

  return parseFloat(match[1] as string);
}
