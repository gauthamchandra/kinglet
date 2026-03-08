#!/usr/bin/env bash
#
# Parse the JSON output from the router LLM and set GitHub Actions outputs.
# Extracts boolean flags for each expert category from the model's response.
#
# Usage: ROUTER_RESPONSE="..." bash parse-router-output.sh

set -euo pipefail

RESPONSE="${ROUTER_RESPONSE:?ROUTER_RESPONSE env var must be set}"

# Strip DeepSeek R1 <think>...</think> reasoning blocks
RESPONSE=$(printf '%s\n' "$RESPONSE" | sed '/<think>/,/<\/think>/d')

# Strip any markdown fencing the model might have added despite instructions
RESPONSE=$(printf '%s' "$RESPONSE" | sed 's/^```json//; s/^```//; s/```$//' | tr -d '\n')

# Parse JSON booleans with jq, defaulting to true on parse failure (fail-open)
parse_field() {
  local field="$1"
  local value
  value=$(echo "$RESPONSE" | jq -r ".$field // true" 2>/dev/null) || value="true"
  echo "$value"
}

SECURITY=$(parse_field "security")
BUN_COMPLIANCE=$(parse_field "bun_compliance")
ARCHITECTURE=$(parse_field "architecture")
TEST_QUALITY=$(parse_field "test_quality")

echo "security=$SECURITY" >> "$GITHUB_OUTPUT"
echo "bun-compliance=$BUN_COMPLIANCE" >> "$GITHUB_OUTPUT"
echo "architecture=$ARCHITECTURE" >> "$GITHUB_OUTPUT"
echo "test-quality=$TEST_QUALITY" >> "$GITHUB_OUTPUT"

echo "Router classified experts:"
echo "  security:       $SECURITY"
echo "  bun-compliance: $BUN_COMPLIANCE"
echo "  architecture:   $ARCHITECTURE"
echo "  test-quality:   $TEST_QUALITY"
echo "  general:        true (always active)"
