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
});

describe('SecretManager.listVersions', () => {
  for (const location of [null, 'us-central1']) {
    test(`pages newest first under ${location ?? 'a global'} parent`, async () => {
      const manager = await managerWith();
      const name = secretNameIn({ project: 'demo', location }, 'db');
      const prefix = location == null ? 'projects/demo' : `projects/demo/locations/${location}`;

      await manager.createSecret(name, location == null ? input() : regionalInput());

      for (const value of ['a', 'b', 'c']) {
        await manager.addVersion(name, { data: utf8(value), crc32c: null });
      }

      const first = await manager.listVersions(name, { pageSize: 2, pageToken: null });

      expect(first.versions.map(version => version.name)).toEqual([
        `${prefix}/secrets/db/versions/3`,
        `${prefix}/secrets/db/versions/2`,
      ]);
      expect(first.totalSize).toBe(3);
      expect(first.nextPageToken).toBe('2');

      const second = await manager.listVersions(name, { pageSize: 2, pageToken: '2' });

      expect(second.versions.map(version => version.name)).toEqual([
        `${prefix}/secrets/db/versions/1`,
      ]);
      expect(second.totalSize).toBe(3);
      expect(second.nextPageToken).toBeNull();
    });
  }

  test('lists only the named secret and defaults the page size', async () => {
    const manager = await managerWith();
    const exact = secretNameIn({ project: 'demo', location: null }, 'a_b');
    const lookalike = secretNameIn({ project: 'demo', location: null }, 'aXb');
    const prefixed = secretNameIn({ project: 'demo', location: null }, 'a_b2');

    for (const name of [exact, lookalike, prefixed]) {
      await manager.createSecret(name, input());
      await manager.addVersion(name, { data: utf8('x'), crc32c: null });
    }

    const page = await manager.listVersions(exact, { pageSize: null, pageToken: null });

    expect(page.versions.map(version => version.name)).toEqual([
      'projects/demo/secrets/a_b/versions/1',
    ]);
    expect(page.nextPageToken).toBeNull();
  });

  test('a secret with no versions lists empty and a missing secret is NOT_FOUND', async () => {
    const manager = await managerWith();
    const name = secretNameIn({ project: 'demo', location: null }, 'empty');

    await manager.createSecret(name, input());

    const page = await manager.listVersions(name, { pageSize: null, pageToken: null });

    expect(page).toEqual({ versions: [], totalSize: 0, nextPageToken: null });

    const missing = manager.listVersions(secretNameIn({ project: 'demo', location: null }, 'no'), {
      pageSize: null,
      pageToken: null,
    });

    await expect(missing).rejects.toHaveProperty('code', 'NOT_FOUND');
  });
});

describe('SecretManager version state', () => {
  test('disable and enable bump the etag, and a repeat is a no-op', async () => {
    const { manager, name } = await withVersions(1);
    const locator = versionLocator(name, 1);
    const raw = 'projects/demo/secrets/db/versions/1';

    const disabled = await manager.changeVersionState(locator, raw, null, 'disable');

    expect(disabled.state).toBe('DISABLED');
    expect(disabled.etag).toBe('2');

    const again = await manager.changeVersionState(locator, raw, null, 'disable');

    expect(again.state).toBe('DISABLED');
    expect(again.etag).toBe('2');

    const enabled = await manager.changeVersionState(locator, raw, '2', 'enable');

    expect(enabled.state).toBe('ENABLED');
    expect(enabled.etag).toBe('3');

    const noop = await manager.changeVersionState(locator, raw, null, 'enable');

    expect(noop.etag).toBe('3');
  });

  test('a disabled version cannot be accessed but its metadata is readable', async () => {
    const { manager, name } = await withVersions(1);
    const locator = versionLocator(name, 1);
    const raw = 'projects/demo/secrets/db/versions/1';

    await manager.changeVersionState(locator, raw, null, 'disable');

    const access = manager.accessVersion(locator, raw);

    await expect(access).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
    expect((await manager.getVersion(locator, raw)).state).toBe('DISABLED');
  });

  test('a wrong etag is ABORTED and leaves the version alone', async () => {
    const { manager, name } = await withVersions(1);
    const locator = versionLocator(name, 1);
    const raw = 'projects/demo/secrets/db/versions/1';

    for (const transition of ['disable', 'enable', 'destroy'] as const) {
      const attempt = manager.changeVersionState(locator, raw, '99', transition);

      await expect(attempt).rejects.toHaveProperty('code', 'ABORTED');
    }

    const current = await manager.getVersion(locator, raw);

    expect(current.state).toBe('ENABLED');
    expect(current.etag).toBe('1');
  });

  test('destroy is terminal, stamps destroyTime, and drops the payload', async () => {
    const { manager, name, repository } = await withVersions(2);
    const locator = versionLocator(name, 1);
    const raw = 'projects/demo/secrets/db/versions/1';

    const destroyed = await manager.changeVersionState(locator, raw, '1', 'destroy');

    expect(destroyed.state).toBe('DESTROYED');
    expect(destroyed.destroyTime).toBe(FIXED.toISOString());
    expect(destroyed.etag).toBe('2');

    const row = await repository.findVersion('projects/demo/secrets/db', 1);

    expect(row?.payloadData).toBeNull();
    expect(row?.payloadCrc32c).toBeNull();
    expect(row?.state).toBe('DESTROYED');

    for (const transition of ['enable', 'disable', 'destroy'] as const) {
      const attempt = manager.changeVersionState(locator, raw, null, transition);

      await expect(attempt).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
    }

    const access = manager.accessVersion(locator, raw);

    await expect(access).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
    expect((await manager.getVersion(locator, raw)).state).toBe('DESTROYED');
  });

  test('a disabled version can be destroyed', async () => {
    const { manager, name } = await withVersions(1);
    const locator = versionLocator(name, 1);
    const raw = 'projects/demo/secrets/db/versions/1';

    await manager.changeVersionState(locator, raw, null, 'disable');

    expect((await manager.changeVersionState(locator, raw, null, 'destroy')).state).toBe(
      'DESTROYED'
    );
  });

  test('latest stays on the highest version whatever its state', async () => {
    const { manager, name } = await withVersions(2);
    const latest = { secret: name, selector: { kind: 'latest' as const } };
    const latestRaw = 'projects/demo/secrets/db/versions/latest';

    await manager.changeVersionState(
      versionLocator(name, 2),
      'projects/demo/secrets/db/versions/2',
      null,
      'disable'
    );

    const got = await manager.getVersion(latest, latestRaw);

    expect(got.name).toBe('projects/demo/secrets/db/versions/2');
    expect(got.state).toBe('DISABLED');

    const access = manager.accessVersion(latest, latestRaw);

    await expect(access).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
  });

  test('a missing version is NOT_FOUND as a SecretVersion', async () => {
    const { manager, name } = await withVersions(1);
    const raw = 'projects/demo/secrets/db/versions/9';
    const attempt = manager.changeVersionState(versionLocator(name, 9), raw, null, 'destroy');

    await expect(attempt).rejects.toHaveProperty('code', 'NOT_FOUND');
    await expect(attempt).rejects.toHaveProperty('resourceType', 'SecretVersion');
    await expect(attempt).rejects.toHaveProperty('resourceName', raw);
  });

  test('works the same on a regional secret', async () => {
    const manager = await managerWith();
    const name = secretNameIn({ project: 'demo', location: 'us-east1' }, 'db');
    const raw = 'projects/demo/locations/us-east1/secrets/db/versions/1';

    await manager.createSecret(name, regionalInput());
    await manager.addVersion(name, { data: utf8('a'), crc32c: null });

    const disabled = await manager.changeVersionState(
      versionLocator(name, 1),
      raw,
      null,
      'disable'
    );

    expect(disabled.name).toBe(raw);
    expect(disabled.state).toBe('DISABLED');

    const destroyed = await manager.changeVersionState(
      versionLocator(name, 1),
      raw,
      null,
      'destroy'
    );

    expect(destroyed.state).toBe('DESTROYED');
  });
});

async function withVersions(count: number): Promise<{
  manager: SecretManager;
  repository: SecretRepository;
  name: ReturnType<typeof secretNameIn>;
}> {
  const storage = new StorageManager();

  await storage.initialize({ type: 'memory' });

  const repository = new SecretRepository(storage);

  await repository.initialize();

  const manager = new SecretManager(repository, () => FIXED);
  const name = secretNameIn({ project: 'demo', location: null }, 'db');

  await manager.createSecret(name, input());

  for (let index = 0; index < count; index++) {
    await manager.addVersion(name, { data: utf8(`v${index + 1}`), crc32c: null });
  }

  return { manager, repository, name };
}

function versionLocator(name: ReturnType<typeof secretNameIn>, number: number) {
  return { secret: name, selector: { kind: 'number' as const, number } };
}

function regionalInput() {
  return { ...input(), replication: null };
}

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
