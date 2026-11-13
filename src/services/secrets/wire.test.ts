import { describe, expect, test } from 'bun:test';
import { SecretManagerError } from './types.ts';
import {
  decodeAdd,
  decodeSecretSpecInput,
  decodeUpdate,
  encodeSecret,
  GRPC_DIALECT,
  REST_DIALECT,
} from './wire.ts';

describe('secret wire dialects', () => {
  test('REST integer enums and gRPC names decode to the same spec', () => {
    const rest = decodeSecretSpecInput(
      {
        replication: { automatic: {} },
        ttl: '3600s',
        secretType: 2,
        labels: { team: 'core' },
        versionAliases: { current: '1' },
      },
      REST_DIALECT
    );
    const grpc = decodeSecretSpecInput(
      {
        replication: { automatic: {}, userManaged: null },
        expiration: 'ttl',
        ttl: { seconds: '3600', nanos: 0 },
        secretType: 'ACCESS_KEY',
        labels: { team: 'core' },
        versionAliases: { current: '1' },
      },
      GRPC_DIALECT
    );

    expect(rest.secretType).toBe('ACCESS_KEY');
    expect(grpc).toEqual(rest);
    expect(rest.expiration).toEqual({ kind: 'ttl', ttl: { seconds: 3600, nanos: 0 } });
    expect(rest.versionAliases).toEqual({ current: 1 });
  });

  test('rejects a ttl whose seconds do not fit in a JavaScript integer', () => {
    expect(() =>
      decodeSecretSpecInput(
        { replication: { automatic: {} }, ttl: '100000000000000000000s' },
        REST_DIALECT
      )
    ).toThrow(SecretManagerError);
  });

  test('accepts an empty REST payload and rejects malformed base64', () => {
    const empty = decodeAdd(
      { parent: 'projects/p/secrets/a', payload: { data: '' } },
      REST_DIALECT
    );

    expect(empty.payload.data).toEqual(new Uint8Array());

    expect(() =>
      decodeAdd({ parent: 'projects/p/secrets/a', payload: { data: '%%%' } }, REST_DIALECT)
    ).toThrow(SecretManagerError);
  });

  test('decodes an update from a REST mask string and a gRPC FieldMask alike', () => {
    const rest = decodeUpdate(
      {
        secret: {
          name: 'projects/p/secrets/a',
          etag: '3',
          labels: { env: 'prod' },
          versionAliases: { current: '2' },
        },
        updateMask: 'labels,version_aliases',
      },
      REST_DIALECT
    );
    const grpc = decodeUpdate(
      {
        secret: {
          name: 'projects/p/secrets/a',
          etag: '3',
          labels: { env: 'prod' },
          versionAliases: { current: '2' },
          replication: null,
          expiration: undefined,
        },
        updateMask: { paths: ['labels', 'versionAliases'] },
      },
      GRPC_DIALECT
    );

    expect(rest.nameRaw).toBe('projects/p/secrets/a');
    expect(rest.update.etag).toBe('3');
    expect([...rest.update.fields]).toEqual(['labels', 'versionAliases']);
    expect(rest.update.spec.versionAliases).toEqual({ current: 2 });
    expect(grpc).toEqual(rest);
  });

  test('an update ignores unmasked fields and treats an empty etag as unset', () => {
    const decoded = decodeUpdate(
      {
        secret: {
          name: 'projects/p/secrets/a',
          etag: '',
          labels: { env: 'prod' },
          replication: 'not-an-object',
          ttl: 'garbage',
        },
        updateMask: { paths: ['labels'] },
      },
      GRPC_DIALECT
    );

    expect(decoded.update.etag).toBeNull();
    expect(decoded.update.spec.labels).toEqual({ env: 'prod' });
    expect(decoded.update.spec.replication).toBeNull();
  });

  test('an update without a mask is INVALID_ARGUMENT', () => {
    for (const updateMask of [undefined, '', null, { paths: [] }]) {
      expect(() =>
        decodeUpdate({ secret: { name: 'projects/p/secrets/a' }, updateMask }, REST_DIALECT)
      ).toThrow('update_mask is required');
    }
  });

  test('alias versions must be decimal int64 strings or integers', () => {
    for (const value of ['1e3', ' 1', '0x10', '9007199254740993', 1.5]) {
      expect(() =>
        decodeSecretSpecInput({ versionAliases: { current: value } }, REST_DIALECT)
      ).toThrow(SecretManagerError);
    }

    expect(
      decodeSecretSpecInput({ versionAliases: { a: '12', b: 7 } }, GRPC_DIALECT).versionAliases
    ).toEqual({ a: 12, b: 7 });
  });

  test('encodes timestamps as RFC3339 on REST and seconds on gRPC', () => {
    const secret = {
      name: 'projects/demo/secrets/db',
      createTime: '2026-01-01T00:00:00.000Z',
      etag: '1',
      spec: {
        replication: { kind: 'automatic' as const, cmek: null },
        labels: {},
        topics: [],
        expireTime: '2026-01-02T00:00:00.000Z',
        rotation: null,
        versionAliases: { current: 1 },
        annotations: {},
        versionDestroyTtl: { seconds: 86400, nanos: 0 },
        customerManagedEncryption: null,
        secretType: 'ACCESS_KEY' as const,
      },
    };

    const rest = encodeSecret(secret, REST_DIALECT);
    const grpc = encodeSecret(secret, GRPC_DIALECT);

    expect(rest.createTime).toBe('2026-01-01T00:00:00.000Z');
    expect(rest.expireTime).toBe('2026-01-02T00:00:00.000Z');
    expect(rest.versionDestroyTtl).toBe('86400s');
    expect(rest.versionAliases).toEqual({ current: '1' });
    expect(rest.secretType).toBe('ACCESS_KEY');
    expect(grpc.createTime).toEqual({ seconds: '1767225600', nanos: 0 });
    expect(grpc.versionDestroyTtl).toEqual({ seconds: '86400', nanos: 0 });
  });
});
