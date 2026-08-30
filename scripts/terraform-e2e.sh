#!/usr/bin/env bash
# Terraform validation harness: apply kinglet fixtures, assert zero-drift plan, destroy.
#
# Usage:
#   ./scripts/terraform-e2e.sh              # docker (default)
#   KINGLET_MODE=bun ./scripts/terraform-e2e.sh
#
# Environment:
#   KINGLET_PORT          HTTP port (default: 8765)
#   KINGLET_MODE          "docker" (default) or "bun"
#   TF_DIR                Terraform root (default: terraform/)
#   SKIP_DOCKER_BUILD     Set to 1 to reuse existing kinglet:terraform-validation image

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="${TF_DIR:-${ROOT_DIR}/terraform}"
KINGLET_PORT="${KINGLET_PORT:-8765}"
KINGLET_MODE="${KINGLET_MODE:-docker}"
KINGLET_ENDPOINT="http://127.0.0.1:${KINGLET_PORT}"
CONTAINER_NAME="kinglet-terraform-validation"
IMAGE_NAME="kinglet:terraform-validation"
STATE_DIR="$(mktemp -d)"
KINGLET_PID=""

cleanup() {
  local exit_code=$?

  if [[ -n "${KINGLET_PID}" ]] && kill -0 "${KINGLET_PID}" 2>/dev/null; then
    kill "${KINGLET_PID}" 2>/dev/null || true
    wait "${KINGLET_PID}" 2>/dev/null || true
  fi

  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "${CONTAINER_NAME}"; then
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  fi

  rm -rf "${STATE_DIR}"

  exit "${exit_code}"
}

trap cleanup EXIT INT TERM

log() {
  printf '==> %s\n' "$*"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

wait_for_health() {
  local url="${KINGLET_ENDPOINT}/health"
  local attempt

  for attempt in $(seq 1 60); do
    if curl -sf "${url}" >/dev/null 2>&1; then
      log "kinglet healthy at ${url}"
      return 0
    fi

    sleep 1
  done

  fail "Timed out waiting for kinglet health at ${url}"
}

start_kinglet_docker() {
  require_cmd docker

  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true

  if [[ "${SKIP_DOCKER_BUILD:-0}" != "1" ]]; then
    log "Building kinglet Docker image (${IMAGE_NAME})"
    docker build -t "${IMAGE_NAME}" "${ROOT_DIR}"
  fi

  log "Starting kinglet container on port ${KINGLET_PORT}"
  docker run -d \
    --name "${CONTAINER_NAME}" \
    -p "${KINGLET_PORT}:8765" \
    -e STORAGE_TYPE=memory \
    -e AUTH_MODE=bypass \
    -e MOCK_PROJECT_ID=kinglet-terraform-validation \
    -e SERVICES=pubsub,kms,workflows \
    -e MEMORYSTORE_DATA_PLANE=false \
    "${IMAGE_NAME}" >/dev/null
}

start_kinglet_bun() {
  require_cmd bun

  log "Starting kinglet via bun on port ${KINGLET_PORT}"
  (
    cd "${ROOT_DIR}"
    STORAGE_TYPE=memory \
    AUTH_MODE=bypass \
    MOCK_PROJECT_ID=kinglet-terraform-validation \
    SERVICES=pubsub,kms,workflows \
    MEMORYSTORE_DATA_PLANE=false \
    HTTP_PORT="${KINGLET_PORT}" \
    bun run src/index.ts
  ) &
  KINGLET_PID=$!
}

start_kinglet() {
  case "${KINGLET_MODE}" in
    docker) start_kinglet_docker ;;
    bun) start_kinglet_bun ;;
    *) fail "Unknown KINGLET_MODE: ${KINGLET_MODE} (expected docker or bun)" ;;
  esac

  wait_for_health
}

run_terraform() {
  require_cmd terraform

  export TF_DATA_DIR="${STATE_DIR}/.terraform"
  local state_file="${STATE_DIR}/terraform.tfstate"

  log "terraform init"
  (
    cd "${TF_DIR}"
    terraform init -input=false -no-color
  )

  log "terraform apply"
  (
    cd "${TF_DIR}"
    terraform apply \
      -input=false \
      -auto-approve \
      -no-color \
      -state="${state_file}" \
      -var="kinglet_endpoint=${KINGLET_ENDPOINT}"
  )

  log "terraform plan (expect no drift — exit 0)"
  set +e
  (
    cd "${TF_DIR}"
    terraform plan \
      -input=false \
      -detailed-exitcode \
      -no-color \
      -state="${state_file}" \
      -var="kinglet_endpoint=${KINGLET_ENDPOINT}"
  )
  local plan_exit=$?
  set -e

  if [[ "${plan_exit}" -ne 0 ]]; then
    fail "Post-apply plan detected drift (exit ${plan_exit}); expected 0"
  fi

  log "terraform destroy"
  (
    cd "${TF_DIR}"
    terraform destroy \
      -input=false \
      -auto-approve \
      -no-color \
      -state="${state_file}" \
      -var="kinglet_endpoint=${KINGLET_ENDPOINT}"
  )

  log "terraform state list after destroy (expect empty)"
  local remaining_state
  remaining_state="$(
    cd "${TF_DIR}"
    terraform state list -state="${state_file}"
  )"

  if [[ -n "${remaining_state}" ]]; then
    fail "Terraform state not empty after destroy:\n${remaining_state}"
  fi
}

main() {
  require_cmd curl
  log "Terraform validation harness (mode=${KINGLET_MODE}, endpoint=${KINGLET_ENDPOINT})"
  start_kinglet
  run_terraform
  log "Terraform validation passed"
}

main "$@"
