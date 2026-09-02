#!/usr/bin/env bash
# Terraform validation harness — runs manifest-driven Bun tests (TDD entry point).
#
# Usage:
#   ./scripts/terraform-e2e.sh                    # all cases, docker kinglet (CI default)
#   KINGLET_MODE=bun ./scripts/terraform-e2e.sh   # all cases, local bun kinglet
#   ./scripts/terraform-e2e.sh tasks              # single case by manifest id
#
# Prefer running cases directly during development (Bun 1.4+):
#   bun test terraform/terraform.test.ts -t "tasks" --path-ignore-patterns 'e2e/**'
#
# Environment:
#   KINGLET_MODE          "docker" (default) or "bun"
#   KINGLET_PORT          HTTP port (optional; auto-selected when unset)
#   SKIP_DOCKER_BUILD     Set to 1 to reuse existing kinglet:terraform-validation image

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KINGLET_MODE="${KINGLET_MODE:-docker}"
export KINGLET_MODE

BUN_ARGS=()
if bun test --help 2>&1 | grep -q 'path-ignore-patterns'; then
  BUN_ARGS+=(--path-ignore-patterns 'e2e/**')
fi

if [[ $# -gt 0 ]]; then
  BUN_ARGS+=(-t "$1")
fi

cd "${ROOT_DIR}"
if [[ ${#BUN_ARGS[@]} -gt 0 ]]; then
  exec bun test terraform/terraform.test.ts "${BUN_ARGS[@]}"
else
  exec bun test terraform/terraform.test.ts
fi
