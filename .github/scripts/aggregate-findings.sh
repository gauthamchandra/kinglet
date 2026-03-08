#!/usr/bin/env bash
#
# Aggregate and deduplicate findings from all expert review jobs.
#
# Merges all *-findings.json files into a single array, then deduplicates
# by finding ID (file:line:category), keeping the entry with the highest
# severity score when duplicates exist.
#
# Usage: bash aggregate-findings.sh <findings-dir> <output-file>
#   findings-dir: Directory containing *-findings.json files from expert jobs
#   output-file:  Path to write the deduplicated aggregated JSON

set -euo pipefail

FINDINGS_DIR="${1:?Usage: aggregate-findings.sh <findings-dir> <output-file>}"
OUTPUT_FILE="${2:?Usage: aggregate-findings.sh <findings-dir> <output-file>}"

# Merge all findings arrays into one, handling missing/empty files gracefully
MERGED=$(
  for f in "$FINDINGS_DIR"/*-findings.json; do
    if [ -f "$f" ]; then
      # Extract the findings array, defaulting to empty if malformed
      jq -c '.findings // []' "$f" 2>/dev/null || echo '[]'
    fi
  done | jq -s 'add // []'
)

# Deduplicate by id, keeping the entry with the highest severity
DEDUPED=$(
  echo "$MERGED" | jq '
    group_by(.id)
    | map(sort_by(-.severity) | first)
    | sort_by(-.severity)
  '
)

# Write the final aggregated findings
echo "$DEDUPED" | jq '{ "findings": . }' > "$OUTPUT_FILE"

TOTAL=$(echo "$DEDUPED" | jq 'length')
UNIQUE_BEFORE=$(echo "$MERGED" | jq 'length')
DUPES_REMOVED=$((UNIQUE_BEFORE - TOTAL))

echo "Aggregation complete:"
echo "  Total findings from experts: $UNIQUE_BEFORE"
echo "  Duplicates removed:          $DUPES_REMOVED"
echo "  Final unique findings:       $TOTAL"
