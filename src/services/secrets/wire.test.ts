import { describe, expect, test } from 'bun:test';
import { SecretManagerError } from './types.ts';
import {
  decodeAdd,
  decodeDelete,
  decodeList,
  decodeSecretSpecInput,
  encodeList,
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

  test('REST query strings and gRPC defaults decode to the same list request', () => {
    const rest = decodeList({
      parent: 'projects/p',
      pageSize: '5',
      pageToken: '10',
      filter: undefined,
    });
    const grpc = decodeList({ parent: 'projects/p', pageSize: 5, pageToken: '10', filter: '' });
    const unset = decodeList({ parent: 'projects/p', pageSize: 0, pageToken: '' });
    const absent = decodeList({ parent: 'projects/p' });

    expect(rest).toEqual({ parentRaw: 'projects/p', pageSize: 5, pageToken: '10', filter: null });
    expect(grpc).toEqual(rest);
    expect(unset).toEqual({ parentRaw: 'projects/p', pageSize: 0, pageToken: null, filter: null });
    expect(absent.pageSize).toBeNull();
    expect(() => decodeList({ parent: 'projects/p', pageSize: 'ten' })).toThrow(SecretManagerError);
  });

  test('omits nextPageToken on the last page and default fields of an empty list', () => {
    const secret = {
      name: 'projects/p/secrets/a',
      createTime: '2026-01-01T00:00:00.000Z',
      etag: '1',
      spec: {
        replication: { kind: 'automatic' as const, cmek: null },
        labels: {},
        topics: [],
        expireTime: null,
        rotation: null,
        versionAliases: {},
        annotations: {},
        versionDestroyTtl: null,
        customerManagedEncryption: null,
        secretType: 'SECRET_TYPE_UNSPECIFIED' as const,
      },
    };
    const last = encodeList({ secrets: [secret], nextPageToken: null, totalSize: 3 }, REST_DIALECT);
    const more = encodeList({ secrets: [secret], nextPageToken: '2', totalSize: 3 }, GRPC_DIALECT);
    const empty = encodeList({ secrets: [], nextPageToken: null, totalSize: 0 }, REST_DIALECT);

    expect(last).toEqual({ secrets: [encodeSecret(secret, REST_DIALECT)], totalSize: 3 });
    expect(more).toEqual({
      secrets: [encodeSecret(secret, GRPC_DIALECT)],
      nextPageToken: '2',
      totalSize: 3,
    });
    expect(empty).toEqual({});
  });

  test('an empty delete etag is the same as no etag', () => {
    expect(decodeDelete({ name: 'projects/p/secrets/a', etag: '' })).toEqual({
      nameRaw: 'projects/p/secrets/a',
      etag: null,
    });
    expect(decodeDelete({ name: 'projects/p/secrets/a', etag: '3' }).etag).toBe('3');
  });
});
