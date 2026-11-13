import { describe, expect, test } from 'bun:test';
import type { SecretVersionState, VersionTransition } from './types.ts';
import {
  nextVersionState,
  parsePageToken,
  parseSecretName,
  parseSecretParent,
  resolvePageSize,
  resolveSpec,
  SecretManagerError,
  secretNameIn,
} from './types.ts';

const NOW = new Date('2026-01-01T00:00:00.000Z');

describe('secret names', () => {
  test('round-trips global and regional parents', () => {
    expect(parseSecretParent('projects/demo')).toEqual({ project: 'demo', location: null });
    expect(parseSecretParent('projects/demo/locations/us-central1')).toEqual({
      project: 'demo',
      location: 'us-central1',
    });
    expect(parseSecretName('projects/demo/secrets/db_password').secretId).toBe('db_password');
    expect(
      parseSecretName('projects/demo/locations/us-central1/secrets/db-password').parent.location
    ).toBe('us-central1');
  });

  test('treats case and underscore as significant', () => {
    expect(parseSecretName('projects/p/secrets/a_b').secretId).not.toBe(
      parseSecretName('projects/p/secrets/aXb').secretId
    );
    expect(parseSecretName('projects/p/secrets/Foo').secretId).not.toBe(
      parseSecretName('projects/p/secrets/foo').secretId
    );
  });

  test('rejects a missing secret id', () => {
    expect(() => secretNameIn({ project: 'p', location: null }, '')).toThrow(SecretManagerError);
  });

  test('a colon in the secret id is invalid', () => {
    const error = capture(() => parseSecretName('projects/p/secrets/db:getIamPolicy'));

    expect(error).toBeInstanceOf(SecretManagerError);
    expect((error as SecretManagerError).code).toBe('INVALID_ARGUMENT');
    expect(() => secretNameIn({ project: 'p', location: null }, 'a:b')).toThrow(SecretManagerError);
  });
});

describe('resolveSpec', () => {
  test('requires replication on a global secret and rejects it on a regional secret', () => {
    const globalName = secretNameIn({ project: 'p', location: null }, 'db');
    const regionalName = secretNameIn({ project: 'p', location: 'us-central1' }, 'db');
    const empty = emptyInput();

    expect(() => resolveSpec(globalName, empty, NOW)).toThrow(SecretManagerError);
    expect(() =>
      resolveSpec(regionalName, { ...empty, replication: { kind: 'automatic', cmek: null } }, NOW)
    ).toThrow(SecretManagerError);

    const resolved = resolveSpec(
      globalName,
      {
        ...empty,
        replication: { kind: 'automatic', cmek: null },
        expiration: { kind: 'ttl', ttl: { seconds: 3600, nanos: 0 } },
      },
      NOW
    );

    expect(resolved.expireTime).toBe('2026-01-01T01:00:00.000Z');
    expect(resolved.replication?.kind).toBe('automatic');
  });

  test('rejects a ttl that would overflow the timestamp', () => {
    const name = secretNameIn({ project: 'p', location: null }, 'db');
    const error = capture(() =>
      resolveSpec(
        name,
        {
          ...emptyInput(),
          replication: { kind: 'automatic', cmek: null },
          expiration: { kind: 'ttl', ttl: { seconds: 8_640_000_000_000, nanos: 0 } },
        },
        NOW
      )
    );

    expect(error).toBeInstanceOf(SecretManagerError);
    expect((error as SecretManagerError).code).toBe('INVALID_ARGUMENT');
  });
});

describe('list paging', () => {
  test('defaults a missing or zero page size to 100 and caps it at 25000', () => {
    expect(resolvePageSize(null)).toBe(100);
    expect(resolvePageSize(0)).toBe(100);
    expect(resolvePageSize(7)).toBe(7);
    expect(resolvePageSize(25_000)).toBe(25_000);
    expect(resolvePageSize(25_001)).toBe(25_000);
  });

  test('rejects a negative page size', () => {
    const error = capture(() => resolvePageSize(-1));

    expect(error).toBeInstanceOf(SecretManagerError);
    expect((error as SecretManagerError).code).toBe('INVALID_ARGUMENT');
  });

  test('reads an empty page token as the start and rejects a malformed one', () => {
    expect(parsePageToken(null)).toBe(0);
    expect(parsePageToken('20')).toBe(20);

    for (const bad of ['abc', '-1', '1.5']) {
      const error = capture(() => parsePageToken(bad));

      expect(error).toBeInstanceOf(SecretManagerError);
      expect((error as SecretManagerError).code).toBe('INVALID_ARGUMENT');
    }
  });
});

describe('nextVersionState', () => {
  const name = 'projects/p/secrets/db/versions/1';

  const allowed: ReadonlyArray<[SecretVersionState, VersionTransition, SecretVersionState | null]> =
    [
      ['ENABLED', 'enable', null],
      ['ENABLED', 'disable', 'DISABLED'],
      ['ENABLED', 'destroy', 'DESTROYED'],
      ['DISABLED', 'enable', 'ENABLED'],
      ['DISABLED', 'disable', null],
      ['DISABLED', 'destroy', 'DESTROYED'],
    ];

  for (const [current, transition, expected] of allowed) {
    test(`${transition} of ${current} yields ${String(expected)}`, () => {
      expect(nextVersionState(current, transition, name)).toBe(expected);
    });
  }

  for (const transition of ['enable', 'disable', 'destroy'] as const) {
    test(`${transition} of DESTROYED is FAILED_PRECONDITION`, () => {
      const error = capture(() => nextVersionState('DESTROYED', transition, name));

      expect(error).toBeInstanceOf(SecretManagerError);
      expect((error as SecretManagerError).code).toBe('FAILED_PRECONDITION');
    });
  }
});

function emptyInput() {
  return {
    replication: null,
    labels: {},
    topics: [],
    expiration: { kind: 'none' as const },
    rotation: null,
    versionAliases: {},
    annotations: {},
    versionDestroyTtl: null,
    customerManagedEncryption: null,
    secretType: 'SECRET_TYPE_UNSPECIFIED' as const,
  };
}

function capture(run: () => void): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }

  throw new Error('expected a throw');
}
