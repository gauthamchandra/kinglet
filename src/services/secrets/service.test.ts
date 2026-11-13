import { describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { crc32cString } from '@/shared/utils/crc32c.ts';
import { SecretRepository } from './repository.ts';
import { SecretManager } from './service.ts';
import { SecretManagerError, secretNameIn } from './types.ts';

const FIXED = new Date('2026-06-01T00:00:00.000Z');

describe('SecretManager', () => {
  test('creates and gets a secret, and rejects a duplicate on memory storage', async () => {
    const manager = await managerWith();
    const name = secretNameIn({ project: 'demo', location: null }, 'db-password');
    const created = await manager.createSecret(name, input());

    expect(created.name).toBe('projects/demo/secrets/db-password');
    expect(created.etag).toBe('1');
    expect(created.createTime).toBe(FIXED.toISOString());

    const got = await manager.getSecret(name);

    expect(got.spec.labels).toEqual({ team: 'core' });
    expect(got.spec.secretType).toBe('ACCESS_KEY');

    const duplicate = manager.createSecret(name, input());

    await expect(duplicate).rejects.toBeInstanceOf(SecretManagerError);
    await expect(duplicate).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
  });

  test('one of two concurrent creates wins', async () => {
    const manager = await managerWith();
    const name = secretNameIn({ project: 'demo', location: null }, 'race');
    const results = await Promise.allSettled([
      manager.createSecret(name, input()),
      manager.createSecret(name, input()),
    ]);
    const fulfilled = results.filter(result => result.status === 'fulfilled');

    expect(fulfilled).toHaveLength(1);
  });

  test('getting a missing secret is NOT_FOUND', async () => {
    const manager = await managerWith();
    const missing = manager.getSecret(secretNameIn({ project: 'demo', location: null }, 'nope'));

    await expect(missing).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('numbers versions from 1 and rejects a bad checksum', async () => {
    const manager = await managerWith();
    const name = secretNameIn({ project: 'demo', location: null }, 'db');

    await manager.createSecret(name, input());

    const first = await manager.addVersion(name, { data: utf8('a'), crc32c: null });
    const second = await manager.addVersion(name, { data: utf8('b'), crc32c: null });

    expect(first.name).toBe('projects/demo/secrets/db/versions/1');
    expect(second.name).toBe('projects/demo/secrets/db/versions/2');
    expect(first.clientSpecifiedPayloadChecksum).toBe(false);

    const mismatch = manager.addVersion(name, { data: utf8('c'), crc32c: '1' });

    await expect(mismatch).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');

    const wrapped = manager.addVersion(name, {
      data: utf8('b'),
      crc32c: String(Number(crc32cString(utf8('b'))) + 2 ** 32),
    });

    await expect(wrapped).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');

    const accessed = await manager.accessVersion(
      { secret: name, selector: { kind: 'latest' } },
      'projects/demo/secrets/db/versions/latest'
    );

    expect(Buffer.from(accessed.data).toString()).toBe('b');

    const meta = await manager.getVersion(
      { secret: name, selector: { kind: 'number', number: 1 } },
      'projects/demo/secrets/db/versions/1'
    );

    expect(meta).not.toHaveProperty('data');
    expect(meta.state).toBe('ENABLED');
  });

  test('update bumps the etag on a change and keeps it on a no-op', async () => {
    const manager = await managerWith();
    const name = secretNameIn({ project: 'demo', location: 'us-east1' }, 'db');

    await manager.createSecret(name, { ...input(), replication: null });

    const changed = await manager.updateSecret(name, {
      spec: { ...input(), labels: { team: 'edge' } },
      fields: new Set(['labels']),
      etag: '1',
    });

    expect(changed.etag).toBe('2');
    expect(changed.spec.labels).toEqual({ team: 'edge' });
    expect(changed.spec.replication).toBeNull();

    const same = await manager.updateSecret(name, {
      spec: { ...input(), labels: { team: 'edge' } },
      fields: new Set(['labels']),
      etag: null,
    });

    expect(same.etag).toBe('2');
    expect((await manager.getSecret(name)).etag).toBe('2');
  });

  test('a stale etag is ABORTED and a missing secret is NOT_FOUND', async () => {
    const manager = await managerWith();
    const name = secretNameIn({ project: 'demo', location: null }, 'db');

    await manager.createSecret(name, input());

    const stale = manager.updateSecret(name, {
      spec: input(),
      fields: new Set(['labels']),
      etag: '7',
    });

    await expect(stale).rejects.toHaveProperty('code', 'ABORTED');

    const missing = manager.updateSecret(secretNameIn(name.parent, 'nope'), {
      spec: input(),
      fields: new Set(['labels']),
      etag: null,
    });

    await expect(missing).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('an alias set by update resolves on get and access', async () => {
    const manager = await managerWith();
    const name = secretNameIn({ project: 'demo', location: null }, 'db');
    const requested = 'projects/demo/secrets/db/versions/current';
    const byAlias = { secret: name, selector: { kind: 'alias' as const, alias: 'current' } };

    await manager.createSecret(name, input());
    await manager.addVersion(name, { data: utf8('one'), crc32c: null });
    await manager.addVersion(name, { data: utf8('two'), crc32c: null });

    await expect(manager.accessVersion(byAlias, requested)).rejects.toHaveProperty(
      'code',
      'NOT_FOUND'
    );

    await manager.updateSecret(name, {
      spec: { ...input(), versionAliases: { current: 1 } },
      fields: new Set(['versionAliases']),
      etag: null,
    });

    const accessed = await manager.accessVersion(byAlias, requested);
    const meta = await manager.getVersion(byAlias, requested);

    expect(Buffer.from(accessed.data).toString()).toBe('one');
    expect(meta.name).toBe('projects/demo/secrets/db/versions/1');
  });
});

async function managerWith(): Promise<SecretManager> {
  const storage = new StorageManager();

  await storage.initialize({ type: 'memory' });

  const repository = new SecretRepository(storage);

  await repository.initialize();

  return new SecretManager(repository, () => FIXED);
}

function input() {
  return {
    replication: { kind: 'automatic' as const, cmek: null },
    labels: { team: 'core' },
    topics: [],
    expiration: { kind: 'none' as const },
    rotation: null,
    versionAliases: {},
    annotations: {},
    customerManagedEncryption: null,
    versionDestroyTtl: null,
    secretType: 'ACCESS_KEY' as const,
  };
}

function utf8(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value));
}
