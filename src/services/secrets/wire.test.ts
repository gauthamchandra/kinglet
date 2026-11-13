import { describe, expect, test } from 'bun:test';
import { SecretManagerError } from './types.ts';
import {
  decodeAdd,
  decodeListVersions,
  decodeSecretSpecInput,
  decodeVersionChange,
  encodeSecret,
  encodeVersion,
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

  test('reads list paging from REST query strings and gRPC numbers alike', () => {
    const parent = 'projects/p/secrets/a';
    const rest = decodeListVersions({ parent, pageSize: '5', pageToken: '10' });
    const grpc = decodeListVersions({ parent, pageSize: 5, pageToken: '10', filter: '' });

    expect(rest).toEqual({ parentRaw: parent, pageSize: 5, pageToken: '10' });
    expect(grpc).toEqual(rest);
    expect(decodeListVersions({ parent, pageSize: 0, pageToken: '' })).toEqual({
      parentRaw: parent,
      pageSize: 0,
      pageToken: null,
    });
  });

  test('rejects a non-integer page size and refuses a filter', () => {
    const parent = 'projects/p/secrets/a';
    const badSize = captureError(() => decodeListVersions({ parent, pageSize: 'ten' }));
    const filtered = captureError(() => decodeListVersions({ parent, filter: 'state:ENABLED' }));

    expect(badSize.code).toBe('INVALID_ARGUMENT');
    expect(filtered.code).toBe('UNIMPLEMENTED');
  });

  test('reads an optional etag on a state change', () => {
    const name = 'projects/p/secrets/a/versions/1';

    expect(decodeVersionChange({ name, etag: '' })).toEqual({ name, etag: null });
    expect(decodeVersionChange({ name, etag: '3' })).toEqual({ name, etag: '3' });
  });

  test('writes destroyTime only once a version is destroyed', () => {
    const view = {
      name: 'projects/p/secrets/a/versions/1',
      state: 'DESTROYED' as const,
      createTime: '2026-01-01T00:00:00.000Z',
      destroyTime: '2026-01-02T00:00:00.000Z',
      etag: '2',
      clientSpecifiedPayloadChecksum: false,
    };

    expect(encodeVersion(view, REST_DIALECT).destroyTime).toBe('2026-01-02T00:00:00.000Z');
    expect(encodeVersion(view, GRPC_DIALECT).destroyTime).toEqual({
      seconds: '1767312000',
      nanos: 0,
    });
    expect(
      encodeVersion({ ...view, state: 'ENABLED', destroyTime: null }, REST_DIALECT)
    ).not.toHaveProperty('destroyTime');
  });
});

function captureError(run: () => void): SecretManagerError {
  try {
    run();
  } catch (err) {
    if (err instanceof SecretManagerError) {
      return err;
    }

    throw err;
  }

  throw new Error('expected a throw');
}
