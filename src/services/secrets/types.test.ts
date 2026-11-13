import { describe, expect, test } from 'bun:test';
import {
  applySecretUpdate,
  parseSecretName,
  parseSecretParent,
  parseUpdateMask,
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

describe('parseUpdateMask', () => {
  test('canonicalizes snake_case and camelCase paths to the same fields', () => {
    expect([...parseUpdateMask(['labels', 'version_aliases', 'versionDestroyTtl'])]).toEqual([
      'labels',
      'versionAliases',
      'versionDestroyTtl',
    ]);
    expect([...parseUpdateMask(['expireTime'])]).toEqual(['expireTime']);
    expect([...parseUpdateMask(['ttl'])]).toEqual(['ttl']);
  });

  test('rejects a mask that names both ttl and expire_time', () => {
    const error = capture(() => parseUpdateMask(['versionAliases', 'expire_time', 'ttl']));

    expect(error).toBeInstanceOf(SecretManagerError);
    expect((error as SecretManagerError).code).toBe('INVALID_ARGUMENT');
  });

  test.each([
    [[]],
    [['']],
    [['*']],
    [['labels.env']],
    [['replication']],
    [['secretType']],
    [['secret_type']],
    [['name']],
    [['createTime']],
    [['etag']],
    [['tags']],
    [['bogus']],
    [['labels', 'Labels']],
  ])('rejects %p as INVALID_ARGUMENT', paths => {
    const error = capture(() => parseUpdateMask(paths));

    expect(error).toBeInstanceOf(SecretManagerError);
    expect((error as SecretManagerError).code).toBe('INVALID_ARGUMENT');
  });
});

describe('applySecretUpdate', () => {
  const current = resolveSpec(
    secretNameIn({ project: 'p', location: null }, 'db'),
    {
      ...emptyInput(),
      replication: { kind: 'automatic', cmek: null },
      labels: { team: 'core' },
      annotations: { owner: 'ops' },
    },
    NOW
  );

  test('a masked field absent from the input clears it and an unmasked field is kept', () => {
    const next = applySecretUpdate(
      current,
      { ...emptyInput(), annotations: { owner: 'someone-else' } },
      new Set(['labels']),
      NOW
    );

    expect(next.labels).toEqual({});
    expect(next.annotations).toEqual({ owner: 'ops' });
    expect(next.replication).toEqual({ kind: 'automatic', cmek: null });
  });

  test('ttl becomes expireTime relative to now', () => {
    const next = applySecretUpdate(
      current,
      { ...emptyInput(), expiration: { kind: 'ttl', ttl: { seconds: 60, nanos: 0 } } },
      new Set(['ttl']),
      NOW
    );

    expect(next.expireTime).toBe('2026-01-01T00:01:00.000Z');
  });

  test.each([
    [{ latest: 1 }],
    [{ NEW: 1 }],
    [{ '1abc': 1 }],
    [{ [`a${'b'.repeat(63)}`]: 1 }],
    [{ zero: 0 }],
    [Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`a${i}`, 1]))],
  ])('rejects aliases %p', versionAliases => {
    const error = capture(() =>
      applySecretUpdate(
        current,
        { ...emptyInput(), versionAliases },
        new Set(['versionAliases']),
        NOW
      )
    );

    expect((error as SecretManagerError).code).toBe('INVALID_ARGUMENT');
  });

  test('accepts 50 aliases and rejects 11 topics', () => {
    const aliases = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`a${i}`, 1]));
    const next = applySecretUpdate(
      current,
      { ...emptyInput(), versionAliases: aliases },
      new Set(['versionAliases']),
      NOW
    );

    expect(Object.keys(next.versionAliases)).toHaveLength(50);

    const topics = Array.from({ length: 11 }, (_, i) => `projects/p/topics/t${i}`);
    const error = capture(() =>
      applySecretUpdate(current, { ...emptyInput(), topics }, new Set(['topics']), NOW)
    );

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
