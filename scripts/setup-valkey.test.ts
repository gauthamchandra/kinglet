/**
 * Unit tests for the Valkey setup helper.
 *
 * Only the decision logic is covered: which package manager is chosen and
 * whether it needs root. Actually invoking a package manager is deliberately
 * not exercised — that would mutate the machine running the suite.
 */

import { describe, expect, test } from 'bun:test';
import { findInstallPlan, isRedisLinkTarget, setUpValkey } from './setup-valkey.ts';

function lookUpOnly(...availableCommands: string[]) {
  return (name: string) => (availableCommands.includes(name) ? `/usr/bin/${name}` : null);
}

describe('findInstallPlan', () => {
  test('findInstallPlan_onAMachineWithHomebrew_choosesTheInstallThatNeedsNoRoot', () => {
    const plan = findInstallPlan(lookUpOnly('brew'));

    expect(plan?.packageManager).toBe('brew');
    expect(plan?.requiresRoot).toBe(false);
    expect(plan?.command).toEqual(['brew', 'install', 'valkey']);
    expect(plan?.refreshIndexCommand).toBeUndefined();
  });

  test('findInstallPlan_onDebian_usesTheValkeyServerPackageNameRatherThanValkey', () => {
    const plan = findInstallPlan(lookUpOnly('apt-get'));

    // Debian is the odd one out: the server binary ships as `valkey-server`,
    // so reusing the `valkey` package name from the other managers 404s.
    expect(plan?.command).toEqual([
      'apt-get',
      'install',
      '-y',
      '--no-install-recommends',
      'valkey-server',
    ]);
    expect(plan?.requiresRoot).toBe(true);
  });

  test('findInstallPlan_onDebian_refreshesTheIndexSoAFreshHostCanLocateThePackage', () => {
    const plan = findInstallPlan(lookUpOnly('apt-get'));

    // A fresh Debian host or slim image carries an empty apt index, so the
    // install alone fails with "Unable to locate package" even though
    // valkey-server is in main.
    expect(plan?.refreshIndexCommand).toEqual(['apt-get', 'update']);
  });

  test('findInstallPlan_onAlpine_fetchesTheIndexDuringInstallSoNoSeparateRefreshIsNeeded', () => {
    const plan = findInstallPlan(lookUpOnly('apk'));

    expect(plan?.command).toEqual(['apk', 'add', '--no-cache', 'valkey']);
    expect(plan?.refreshIndexCommand).toBeUndefined();
  });

  test('findInstallPlan_givenBothBrewAndApt_prefersBrewSoNoRootIsNeeded', () => {
    const plan = findInstallPlan(lookUpOnly('apt-get', 'brew'));

    expect(plan?.packageManager).toBe('brew');
  });

  test.each([
    ['dnf', ['dnf', 'install', '-y', 'valkey']],
    ['pacman', ['pacman', '-S', '--noconfirm', 'valkey']],
  ])('findInstallPlan_given%s_returnsItsInstallCommand', (manager, expectedCommand) => {
    const plan = findInstallPlan(lookUpOnly(manager as string));

    expect(plan?.command).toEqual(expectedCommand as string[]);
  });

  test('findInstallPlan_whenNoPackageManagerIsPresent_returnsNull', () => {
    expect(findInstallPlan(lookUpOnly())).toBeNull();
  });
});

describe('isRedisLinkTarget', () => {
  test('isRedisLinkTarget_whenRedisOwnsTheBinary_reportsTheConflictThatBlocksValkeyLinking', () => {
    expect(isRedisLinkTarget('../Cellar/redis/8.0.0/bin/redis-server')).toBe(true);
  });

  test('isRedisLinkTarget_whenValkeyAlreadyOwnsTheBinary_reportsNoConflict', () => {
    // valkey ships its own redis-server compatibility binary, so the symlink
    // existing is not itself the conflict — only redis owning it is.
    expect(isRedisLinkTarget('../Cellar/valkey/9.1.1/bin/redis-server')).toBe(false);
  });

  test('isRedisLinkTarget_whenNothingOwnsTheBinary_reportsNoConflict', () => {
    expect(isRedisLinkTarget(null)).toBe(false);
  });
});

describe('setUpValkey', () => {
  test('setUpValkey_whenExplicitlySkipped_exitsSuccessfullyWithoutInstalling', () => {
    const previous = process.env.KINGLET_SKIP_VALKEY_SETUP;

    process.env.KINGLET_SKIP_VALKEY_SETUP = '1';

    try {
      expect(setUpValkey(true)).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.KINGLET_SKIP_VALKEY_SETUP;
      else process.env.KINGLET_SKIP_VALKEY_SETUP = previous;
    }
  });

  test('setUpValkey_inAutoModeUnderCI_defersToTheWorkflowInsteadOfInstalling', () => {
    const previousCi = process.env.CI;

    process.env.CI = 'true';

    try {
      // The workflow installs valkey deliberately; an install hook that also
      // tried would add a slow, root-requiring step to every CI run.
      expect(setUpValkey(false)).toBe(0);
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
  });
});
