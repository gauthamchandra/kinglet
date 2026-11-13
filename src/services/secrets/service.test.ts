import { describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { crc32cString } from '@/shared/utils/crc32c.ts';
import { SecretRepository } from './repository.ts';
import { SecretManager } from './service.ts';
import { formatSecretName, SecretManagerError, secretNameIn } from './types.ts';

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

  test('lists a global parent newest first across pages without regional secrets', async () => {
    const manager = await managerWith(ticking());
    const global = { project: 'demo', location: null };
    const regional = { project: 'demo', location: 'us-central1' };

    for (const id of ['a', 'b', 'c']) {
      await manager.createSecret(secretNameIn(global, id), input());
    }

    await manager.createSecret(secretNameIn(regional, 'r'), { ...input(), replication: null });
    await manager.createSecret(secretNameIn({ project: 'other', location: null }, 'o'), input());

    const first = await manager.listSecrets(global, { pageSize: 2, pageToken: null, filter: null });

    expect(first.secrets).toHaveLength(2);
    expect(first.totalSize).toBe(3);
    expect(first.nextPageToken).toBeTypeOf('string');

    const second = await manager.listSecrets(global, {
      pageSize: 2,
      pageToken: first.nextPageToken,
      filter: null,
    });
    const listed = [...first.secrets, ...second.secrets];
    const times = listed.map(secret => Date.parse(secret.createTime));

    expect(second.nextPageToken).toBeNull();
    expect(listed.map(secret => secret.name).sort()).toEqual([
      'projects/demo/secrets/a',
      'projects/demo/secrets/b',
      'projects/demo/secrets/c',
    ]);
    expect(times.every((time, index) => index === 0 || time <= (times[index - 1] ?? time))).toBe(
      true
    );

    const regionalPage = await manager.listSecrets(regional, {
      pageSize: null,
      pageToken: null,
      filter: null,
    });

    expect(regionalPage.secrets.map(secret => secret.name)).toEqual([
      'projects/demo/locations/us-central1/secrets/r',
    ]);
    expect(regionalPage.totalSize).toBe(1);
    expect(regionalPage.nextPageToken).toBeNull();
  });

  test('a non-empty list filter is UNIMPLEMENTED', async () => {
    const manager = await managerWith();
    const listed = manager.listSecrets(
      { project: 'demo', location: null },
      { pageSize: null, pageToken: null, filter: 'labels.team=core' }
    );

    await expect(listed).rejects.toBeInstanceOf(SecretManagerError);
    await expect(listed).rejects.toHaveProperty('code', 'UNIMPLEMENTED');
  });

  test('delete checks the etag and removes the secret', async () => {
    const manager = await managerWith();
    const name = secretNameIn({ project: 'demo', location: 'us-central1' }, 'gone');

    await manager.createSecret(name, { ...input(), replication: null });

    const stale = manager.deleteSecret(name, '2');

    await expect(stale).rejects.toHaveProperty('code', 'ABORTED');

    await manager.deleteSecret(name, '1');

    await expect(manager.getSecret(name)).rejects.toHaveProperty('code', 'NOT_FOUND');

    const again = manager.deleteSecret(name, null);

    await expect(again).rejects.toHaveProperty('code', 'NOT_FOUND');
    await expect(again).rejects.toHaveProperty('resourceName', formatSecretName(name));
  });

  test('a recreated secret starts at version 1 and cannot read old payloads', async () => {
    const manager = await managerWith();
    const name = secretNameIn({ project: 'demo', location: null }, 'reborn');
    const latest = { secret: name, selector: { kind: 'latest' as const } };

    await manager.createSecret(name, input());
    await manager.addVersion(name, { data: utf8('old-1'), crc32c: null });
    await manager.addVersion(name, { data: utf8('old-2'), crc32c: null });
    await manager.deleteSecret(name, null);
    await manager.createSecret(name, input());

    const missing = manager.accessVersion(latest, 'projects/demo/secrets/reborn/versions/latest');

    await expect(missing).rejects.toHaveProperty('code', 'NOT_FOUND');

    const added = await manager.addVersion(name, { data: utf8('new'), crc32c: null });
    const accessed = await manager.accessVersion(
      latest,
      'projects/demo/secrets/reborn/versions/latest'
    );

    expect(added.name).toBe('projects/demo/secrets/reborn/versions/1');
    expect(Buffer.from(accessed.data).toString()).toBe('new');

    const second = manager.getVersion(
      { secret: name, selector: { kind: 'number', number: 2 } },
      'projects/demo/secrets/reborn/versions/2'
    );

    await expect(second).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('a delete racing an addVersion leaves no orphan version rows', async () => {
    const manager = await managerWith();
    const name = secretNameIn({ project: 'demo', location: null }, 'race-delete');

    await manager.createSecret(name, input());
    await Promise.allSettled([
      manager.addVersion(name, { data: utf8('x'), crc32c: null }),
      manager.deleteSecret(name, null),
    ]);
    await manager.createSecret(name, input());

    const added = await manager.addVersion(name, { data: utf8('y'), crc32c: null });

    expect(added.name).toBe('projects/demo/secrets/race-delete/versions/1');
  });
});

async function managerWith(clock: () => Date = () => FIXED): Promise<SecretManager> {
  const storage = new StorageManager();

  await storage.initialize({ type: 'memory' });

  const repository = new SecretRepository(storage);

  await repository.initialize();

  return new SecretManager(repository, clock);
}

function ticking(): () => Date {
  let tick = 0;

  return () => new Date(FIXED.getTime() + tick++ * 1000);
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
