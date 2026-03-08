#!/usr/bin/env bash
#
# Render JSON findings into a markdown PR comment with executive summary.
#
# Usage: bash render-findings.sh <findings-json> <output-md> [summary-md] [repo] [head-sha]
#   findings-json: Path to the final findings JSON (from meta-review or aggregation)
#   output-md:     Path to write the rendered markdown comment
#   summary-md:    Optional path to executive summary markdown from meta-review
#   repo:          Optional GitHub repository (owner/repo) for clickable links
#   head-sha:      Optional PR head commit SHA for clickable links

set -euo pipefail

FINDINGS_JSON="${1:?Usage: render-findings.sh <findings-json> <output-md> [summary-md] [repo] [head-sha]}"
OUTPUT_MD="${2:?Usage: render-findings.sh <findings-json> <output-md> [summary-md] [repo] [head-sha]}"
SUMMARY_MD="${3:-}"
REPO="${4:-}"
HEAD_SHA="${5:-}"

# Count findings by severity tier
CRITICAL=$(jq '[.findings[] | select(.severity >= 0.9)] | length' "$FINDINGS_JSON")
HIGH=$(jq '[.findings[] | select(.severity >= 0.7 and .severity < 0.9)] | length' "$FINDINGS_JSON")
MODERATE=$(jq '[.findings[] | select(.severity >= 0.4 and .severity < 0.7)] | length' "$FINDINGS_JSON")
LOW=$(jq '[.findings[] | select(.severity >= 0.2 and .severity < 0.4)] | length' "$FINDINGS_JSON")
INFO=$(jq '[.findings[] | select(.severity < 0.2)] | length' "$FINDINGS_JSON")
TOTAL=$(jq '.findings | length' "$FINDINGS_JSON")

# Determine risk level
if [ "$CRITICAL" -gt 0 ]; then
  RISK="HIGH"
elif [ "$HIGH" -gt 0 ]; then
  RISK="MODERATE"
elif [ "$MODERATE" -gt 0 ]; then
  RISK="LOW"
else
  RISK="MINIMAL"
fi

# Build the markdown comment
{
  echo "## AI Code Review"
  echo ""

  # Executive summary
  if [ -n "$SUMMARY_MD" ] && [ -f "$SUMMARY_MD" ]; then
    cat "$SUMMARY_MD"
    echo ""
  fi

  echo "**Risk**: $RISK | **Findings**: $TOTAL total — $CRITICAL critical, $HIGH high, $MODERATE moderate, $LOW low, $INFO informational"
  echo ""

  if [ "$TOTAL" -eq 0 ]; then
    echo "No issues found. Code looks good."
    echo ""
  fi

  # Render findings grouped by severity tier
  render_tier() {
    local tier_name="$1"
    local min_sev="$2"
    local max_sev="$3"
    local count

    count=$(jq "[.findings[] | select(.severity >= $min_sev and .severity < $max_sev)] | length" "$FINDINGS_JSON")
    if [ "$count" -eq 0 ]; then
      return
    fi

    echo "### $tier_name ($count)"
    echo ""

    if [ -n "$REPO" ] && [ -n "$HEAD_SHA" ]; then
      jq -r --arg repo "$REPO" --arg sha "$HEAD_SHA" "
        [.findings[] | select(.severity >= $min_sev and .severity < $max_sev)]
        | sort_by(-.severity)[]
        | \"\(.emoji) **\(.title)** (\(.severity)/1.0)\n**File**: [\(.file)#L\(.line)](https://github.com/\(\$repo)/blob/\(\$sha)/\(.file)#L\(.line)) | **Category**: \(.category)\n\(.description)\n> **Suggestion**: \(.suggestion)\n\"
      " "$FINDINGS_JSON"
    else
      jq -r "
        [.findings[] | select(.severity >= $min_sev and .severity < $max_sev)]
        | sort_by(-.severity)[]
        | \"\(.emoji) **\(.title)** (\(.severity)/1.0)\n**File**: \(.file):\(.line) | **Category**: \(.category)\n\(.description)\n> **Suggestion**: \(.suggestion)\n\"
      " "$FINDINGS_JSON"
    fi

    echo "---"
    echo ""
  }

  render_tier "Critical Issues"  0.9 10.0
  render_tier "High Priority"    0.7 0.9
  render_tier "Moderate"         0.4 0.7
  render_tier "Low Priority"     0.2 0.4
  render_tier "Informational"    0.0 0.2

  echo "*Automated review via [GitHub Models](https://github.com/marketplace/models). Findings are suggestions — use your judgment.*"
} > "$OUTPUT_MD"

echo "Rendered $TOTAL findings to $OUTPUT_MD (risk: $RISK)"
