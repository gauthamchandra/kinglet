#!/usr/bin/env bash
# Cloud Agent install script for kinglet.
#
# Idempotent, non-interactive setup of the toolchain the repo's dev, test, lint,
# build, and terraform-validation flows need:
#   - Bun 1.3.4          (pinned in .tool-versions; runtime + package manager)
#   - valkey-server      (Memorystore data-plane unit + e2e tests spawn a real one)
#   - terraform 1.10.5   (terraform validation harness, run in KINGLET_MODE=bun)
# then installs project dependencies with the frozen lockfile.
#
# Bun and terraform ship as plain executables from their release hosts, so this
# pins each artifact's SHA-256 and verifies it before running or extracting it —
# a compromised upstream download fails the checksum instead of executing in an
# environment that holds repo source and credentials. (valkey comes from apt,
# whose repositories are GPG-signed, so it needs no extra check here.) Bump the
# checksums alongside BUN_VERSION / TERRAFORM_VERSION from the official
# SHASUMS256.txt / SHA256SUMS published with each release.
set -euo pipefail

BUN_VERSION="1.3.4"
TERRAFORM_VERSION="1.10.5"

# Root in a container build has no sudo; a Cloud Agent VM user has passwordless
# sudo. Resolve one wrapper that works in both.
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

log() { printf '\n=== %s ===\n' "$1"; }

# Fail unless $1 hashes to the expected $2. `sha256sum -c` exits non-zero on a
# mismatch, which set -e turns into an aborted install before the artifact runs.
verify_sha256() {
  local file="$1" expected="$2"
  echo "${expected}  ${file}" | sha256sum -c -
}

install_bun() {
  if command -v bun >/dev/null 2>&1 && [ "$(bun --version)" = "${BUN_VERSION}" ]; then
    echo "bun ${BUN_VERSION} already installed"
    return
  fi

  # Download the pinned release zip directly instead of piping bun.sh/install
  # into bash, so the payload is checksum-verified before anything executes.
  local asset sha
  case "$(uname -m)" in
    x86_64) asset="bun-linux-x64.zip"; sha="33c6996049e8d37e8b815959b14b05e5b6f496121352bf11bae7d047193c28bf" ;;
    aarch64 | arm64) asset="bun-linux-aarch64.zip"; sha="c46e841fed85347521915b1b3904d6d175d8e2fd915e18e01c111318219115a4" ;;
    *) echo "unsupported arch $(uname -m) for bun" >&2; return 1 ;;
  esac

  log "Installing Bun ${BUN_VERSION} (${asset})"
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL -o "${tmp}/${asset}" \
    "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${asset}"
  verify_sha256 "${tmp}/${asset}" "${sha}"
  unzip -oq "${tmp}/${asset}" -d "${tmp}"

  # Install onto a PATH dir for every later phase without editing shell profiles
  # (which the Cloud Agent does not source for install/start/terminals). bunx is
  # the same binary dispatched on argv[0], so a symlink is all it needs.
  ${SUDO} install -m 0755 "${tmp}/${asset%.zip}/bun" /usr/local/bin/bun
  ${SUDO} ln -sf /usr/local/bin/bun /usr/local/bin/bunx
  rm -rf "${tmp}"
}

install_valkey() {
  if command -v valkey-server >/dev/null 2>&1; then
    echo "valkey-server already installed: $(valkey-server --version | head -n1)"
    return
  fi

  log "Installing valkey-server"
  ${SUDO} apt-get update
  ${SUDO} DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends valkey-server
}

install_terraform() {
  if command -v terraform >/dev/null 2>&1 && terraform version | grep -q "v${TERRAFORM_VERSION}"; then
    echo "terraform ${TERRAFORM_VERSION} already installed"
    return
  fi

  log "Installing terraform ${TERRAFORM_VERSION}"
  local arch sha tmp
  case "$(uname -m)" in
    x86_64) arch="amd64"; sha="0566a24f5332098b15716ebc394be503f4094acba5ba529bf5eb0698ed5e2a90" ;;
    aarch64 | arm64) arch="arm64"; sha="0ca5d6977c7c46bfa4bbe030030b911e897cf0cb72bff5525fb76c10f1c3409a" ;;
    *) echo "unsupported arch $(uname -m) for terraform" >&2; return 1 ;;
  esac

  tmp="$(mktemp -d)"
  curl -fsSL -o "${tmp}/terraform.zip" \
    "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${arch}.zip"
  verify_sha256 "${tmp}/terraform.zip" "${sha}"
  # Extract only the binary so LICENSE.txt does not land in /usr/local/bin.
  ${SUDO} unzip -oq "${tmp}/terraform.zip" terraform -d /usr/local/bin
  rm -rf "${tmp}"
}

install_bun
install_valkey
install_terraform

log "Installing project dependencies (bun install --frozen-lockfile)"
# valkey is already installed above, so skip the postinstall auto-installer.
KINGLET_SKIP_VALKEY_SETUP=1 bun install --frozen-lockfile

log "Toolchain ready"
bun --version
valkey-server --version | head -n1
terraform version | head -n1
