#!/usr/bin/env bash
#
# Annotate a unified diff with new-file line numbers.
#
# Adds [Lnn] annotations so LLMs can trivially report accurate line numbers:
#   Context lines:  [L40] code here
#   Added lines:    +[L42] code here
#   Removed lines:  unchanged (no new-file line exists)
#
# Usage: bash annotate-diff.sh <input-diff> <output-diff>

set -euo pipefail

INPUT="${1:?Usage: annotate-diff.sh <input-diff> <output-diff>}"
OUTPUT="${2:?Usage: annotate-diff.sh <input-diff> <output-diff>}"

awk '
  /^diff --git / { in_hunk = 0; print; next }
  /^(---|[+][+][+]|index |old mode|new mode|new file|deleted file|similarity|dissimilarity|rename|copy|Binary)/ {
    print; next
  }
  /^@@/ {
    # Parse +NEW from hunk header: @@ -old,count +new,count @@
    s = $0
    sub(/.*\+/, "", s)
    sub(/[, ].*/, "", s)
    new_line = s + 0
    in_hunk = 1
    print
    next
  }
  in_hunk && /^\+/ {
    printf "+[L%d]%s\n", new_line, substr($0, 2)
    new_line++
    next
  }
  in_hunk && /^-/ {
    print
    next
  }
  in_hunk && /^ / {
    printf "[L%d]%s\n", new_line, substr($0, 2)
    new_line++
    next
  }
  in_hunk && /^\\/ { print; next }
  { print }
' "$INPUT" > "$OUTPUT"

echo "Annotated diff written to $OUTPUT"
