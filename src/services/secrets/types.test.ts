import { describe, expect, test } from 'bun:test';
import {
  parseSecretName,
  parseSecretParent,
  resolveListPageSize,
  resolveSpec,
  SecretManagerError,
  secretNameIn,
} from './types.ts';

const NOW = new Date('2026-01-01T00:00:00.000Z');

describe('list page size', () => {
  test('defaults missing, zero, and negative to 100 and caps at 25000', () => {
    expect(resolveListPageSize(null)).toBe(100);
    expect(resolveListPageSize(0)).toBe(100);
    expect(resolveListPageSize(-5)).toBe(100);
    expect(resolveListPageSize(7)).toBe(7);
    expect(resolveListPageSize(25000)).toBe(25000);
    expect(resolveListPageSize(25001)).toBe(25000);
  });
});

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
