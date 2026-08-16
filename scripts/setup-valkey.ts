#!/usr/bin/env bun
/**
 * Make a real `valkey-server` available so the Memorystore data-plane suites
 * actually run instead of skipping themselves.
 *
 * <p>Valkey publishes no prebuilt binaries — every GitHub release is source
 * only — so there is no vendored-binary path and installation has to go
 * through a system package manager. That matters because on Linux those
 * managers need root, and a `bun install` that silently escalates privileges
 * (or blocks on a password prompt in a non-interactive shell) is not something
 * a contributor should have to accept to install dependencies.
 *
 * <p>So this runs in one of two modes:
 *
 * <ul>
 *   <li><b>auto</b> (the `postinstall` hook) — installs only where it can do so
 *       without prompting for a password: Homebrew on macOS, or a root shell
 *       such as a Docker build. Anywhere else it prints the exact command and
 *       exits 0. It never fails `bun install`.</li>
 *   <li><b>explicit</b> (`bun run setup:valkey`) — the contributor asked for
 *       this, so it may use `sudo`, and it exits non-zero if the install
 *       genuinely fails.</li>
 * </ul>
 *
 * <p>Set `KINGLET_SKIP_VALKEY_SETUP=1` to opt out entirely.
 */

import { readlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ValkeyInstallPlan {
  packageManager: string;
  // Only set for managers whose install cannot fetch its own package index.
  // A fresh Debian host or slim image carries an empty or stale apt index, so
  // installing without refreshing it first fails with "Unable to locate
  // package" even though valkey-server sits in main.
  refreshIndexCommand?: string[];
  command: string[];
  requiresRoot: boolean;
}

// Package naming is not consistent across distributions: Debian splits the
// server out as `valkey-server`, while the others ship a single `valkey`.
const INSTALL_PLANS_BY_PACKAGE_MANAGER: Record<string, ValkeyInstallPlan> = {
  brew: { packageManager: 'brew', command: ['brew', 'install', 'valkey'], requiresRoot: false },
  'apt-get': {
    packageManager: 'apt-get',
    refreshIndexCommand: ['apt-get', 'update'],
    command: ['apt-get', 'install', '-y', '--no-install-recommends', 'valkey-server'],
    requiresRoot: true,
  },
  dnf: { packageManager: 'dnf', command: ['dnf', 'install', '-y', 'valkey'], requiresRoot: true },
  pacman: {
    packageManager: 'pacman',
    command: ['pacman', '-S', '--noconfirm', 'valkey'],
    requiresRoot: true,
  },
  // Alpine has the same empty-index problem as Debian, but answers it with a
  // flag rather than a second command: `--no-cache` fetches the index for this
  // install and leaves nothing behind.
  apk: {
    packageManager: 'apk',
    command: ['apk', 'add', '--no-cache', 'valkey'],
    requiresRoot: true,
  },
};

// Ordered by how likely it is to be the right one for the host, so a machine
// with both brew and apt (a Linuxbrew setup) does not get the root-requiring
// path when a passwordless one exists.
const PACKAGE_MANAGER_PREFERENCE = ['brew', 'apt-get', 'dnf', 'pacman', 'apk'];

export function isValkeyInstalled(): boolean {
  return Bun.which('valkey-server') != null;
}

export function findInstallPlan(
  lookUpCommand: (name: string) => string | null = name => Bun.which(name)
): ValkeyInstallPlan | null {
  for (const packageManager of PACKAGE_MANAGER_PREFERENCE) {
    if (lookUpCommand(packageManager) != null) {
      return INSTALL_PLANS_BY_PACKAGE_MANAGER[packageManager] ?? null;
    }
  }

  return null;
}

function isRunningAsRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * Whether `auto` mode may run this plan without a password prompt.
 *
 * <p>A plan needing root is only safe to run automatically when we already are
 * root (a Docker build). Escalating with `sudo` on a contributor's laptop is
 * reserved for the explicit `setup:valkey` entry point.
 */
function canInstallWithoutPrompting(plan: ValkeyInstallPlan): boolean {
  return !plan.requiresRoot || isRunningAsRoot();
}

function planSteps(plan: ValkeyInstallPlan): string[][] {
  return plan.refreshIndexCommand ? [plan.refreshIndexCommand, plan.command] : [plan.command];
}

function withRootIfNeeded(plan: ValkeyInstallPlan, command: string[]): string[] {
  return plan.requiresRoot && !isRunningAsRoot() ? ['sudo', ...command] : command;
}

function describeManualInstall(plan: ValkeyInstallPlan | null): string {
  if (plan == null) {
    return process.platform === 'win32'
      ? '  Valkey has no native Windows build — use WSL, or run kinglet via Docker.'
      : '  No supported package manager found. See https://valkey.io/topics/installation/';
  }

  const steps = planSteps(plan).map(step => withRootIfNeeded(plan, step).join(' '));

  return `  ${steps.join(' && ')}`;
}

/**
 * Whether a Homebrew symlink target belongs to the redis keg.
 *
 * <p>Homebrew's valkey formula declares `conflicts_with "redis" (because both
 * install redis-* binaries)`. While redis owns those names, `brew install
 * valkey` unpacks the keg and then fails at the *link* step — so the install
 * reports trouble, `valkey-server` never reaches `PATH`, and the data-plane
 * tests keep skipping as though nothing had been installed at all.
 */
export function isRedisLinkTarget(symlinkTarget: string | null): boolean {
  return symlinkTarget != null && symlinkTarget.includes('/Cellar/redis/');
}

function resolveHomebrewPrefix(): string | null {
  const brewPath = Bun.which('brew');

  // .../homebrew/bin/brew -> .../homebrew
  return brewPath == null ? null : dirname(dirname(brewPath));
}

function readSymlinkTarget(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

/**
 * Give up redis's claim on the `redis-*` binaries so valkey can link.
 *
 * <p>This is a change to the contributor's machine beyond installing Valkey,
 * so it is always announced. It is nonetheless close to harmless: redis stays
 * installed, `brew link redis` puts it back, and valkey's own keg ships
 * `redis-server`/`redis-cli` compatibility binaries, so those commands keep
 * working in the meantime — just backed by Valkey.
 *
 * <p>Returns whether redis was actually unlinked, so a caller whose install
 * then fails knows it owes the machine a {@link relinkRedis}.
 */
function unlinkConflictingRedis(): boolean {
  const prefix = resolveHomebrewPrefix();

  if (prefix == null) return false;

  if (!isRedisLinkTarget(readSymlinkTarget(`${prefix}/bin/redis-server`))) return false;

  console.log("\nHomebrew's redis owns the redis-* binaries that valkey also installs.");
  console.log('Unlinking redis so valkey can link (redis stays installed):\n');
  console.log('  brew unlink redis\n');

  const result = Bun.spawnSync(['brew', 'unlink', 'redis'], {
    stdout: 'inherit',
    stderr: 'inherit',
  });

  if (result.exitCode === 0) {
    console.log('\nUnlinked redis. `brew link redis` restores it (that unlinks valkey again).');
    console.log('valkey provides redis-server/redis-cli, so those commands still work.\n');

    return true;
  }

  console.log('\nCould not unlink redis; the valkey install may fail to link.\n');

  return false;
}

/**
 * Put redis back when the install it was unlinked for did not pan out.
 *
 * <p>Without this, a failed `brew install valkey` — a network blip is enough —
 * leaves the machine with neither `valkey-server` nor the `redis-*` binaries on
 * `PATH`, and in auto mode that happens quietly in the middle of a plain
 * `bun install`.
 */
function relinkRedis(): void {
  console.log('\nThe valkey install did not succeed, so redis is being relinked.\n');

  const result = Bun.spawnSync(['brew', 'link', 'redis'], {
    stdout: 'inherit',
    stderr: 'inherit',
  });

  if (result.exitCode === 0) {
    console.log('\nRelinked redis — redis-server/redis-cli are back on your PATH.\n');

    return;
  }

  console.log(
    '\nCould not relink redis. Run `brew link redis` to restore redis-server/redis-cli.\n'
  );
}

/**
 * Cover the case where the keg is present but not linked.
 *
 * <p>`brew install valkey` exits 0 for an already-installed formula without
 * linking it, so a machine that previously lost the link to redis would report
 * a successful install while `valkey-server` stayed off `PATH`.
 */
function linkValkeyIfNeeded(): void {
  if (isValkeyInstalled()) return;

  Bun.spawnSync(['brew', 'link', 'valkey'], { stdout: 'inherit', stderr: 'inherit' });
}

/**
 * Bring the package index up to date, if this manager needs telling.
 *
 * <p>Deliberately best-effort: a refresh can fail behind a proxy or a pinned
 * mirror while the index already on disk is good enough to install from, and
 * where it is not, the install's own error is the one worth reporting.
 */
function refreshPackageIndex(plan: ValkeyInstallPlan): void {
  if (plan.refreshIndexCommand == null) return;

  const command = withRootIfNeeded(plan, plan.refreshIndexCommand);

  console.log(`Refreshing the ${plan.packageManager} package index: ${command.join(' ')}`);

  Bun.spawnSync(command, { stdout: 'inherit', stderr: 'inherit' });
}

function runInstall(plan: ValkeyInstallPlan): boolean {
  const wasRedisUnlinked = plan.packageManager === 'brew' && unlinkConflictingRedis();

  refreshPackageIndex(plan);

  const command = withRootIfNeeded(plan, plan.command);

  console.log(`Installing valkey-server via ${plan.packageManager}: ${command.join(' ')}`);

  Bun.spawnSync(command, { stdout: 'inherit', stderr: 'inherit' });

  if (plan.packageManager === 'brew') linkValkeyIfNeeded();

  // The install command's exit code is not the question — whether the binary
  // is now resolvable is, and those differ exactly in the unlinked-keg case.
  const isInstalled = isValkeyInstalled();

  if (!isInstalled && wasRedisUnlinked) relinkRedis();

  return isInstalled;
}

function reportSkip(reason: string, plan: ValkeyInstallPlan | null): void {
  console.log(`\nvalkey-server not found — ${reason}.`);
  console.log('The Memorystore data-plane tests will skip until it is installed. Either run:');
  console.log('\n  bun run setup:valkey\n');
  console.log('or install it yourself:');
  console.log(describeManualInstall(plan));
  console.log('');
}

export function setUpValkey(isExplicitRequest: boolean): number {
  if (process.env.KINGLET_SKIP_VALKEY_SETUP) return 0;

  // CI installs valkey in the workflow on purpose (and test-utils/valkey.ts
  // turns a missing binary into a hard error there), so an install hook has no
  // business second-guessing it mid-`bun install`.
  if (!isExplicitRequest && process.env.CI) return 0;

  if (isValkeyInstalled()) {
    if (isExplicitRequest) console.log('valkey-server is already installed — nothing to do.');

    return 0;
  }

  const plan = findInstallPlan();

  if (plan == null) {
    if (isExplicitRequest) {
      console.error('Could not find a package manager able to install Valkey.');
      console.error(describeManualInstall(null));

      return 1;
    }

    reportSkip('and no supported package manager was found', null);

    return 0;
  }

  // Auto mode installs only what it can do silently. A root-requiring manager
  // would either block on a password prompt or escalate privileges behind the
  // contributor's back during a plain `bun install`; neither is acceptable, so
  // that case degrades to printing the command.
  if (!isExplicitRequest && !canInstallWithoutPrompting(plan)) {
    reportSkip(`installing it needs root, which ${plan.packageManager} would prompt for`, plan);

    return 0;
  }

  if (runInstall(plan)) {
    console.log('valkey-server installed — the Memorystore data-plane tests will now run.');

    return 0;
  }

  if (isExplicitRequest) {
    console.error('Installing valkey-server failed. Try manually:');
    console.error(describeManualInstall(plan));

    return 1;
  }

  reportSkip('the automatic install did not succeed', plan);

  return 0;
}

if (import.meta.main) {
  process.exit(setUpValkey(!process.argv.includes('--auto')));
}
