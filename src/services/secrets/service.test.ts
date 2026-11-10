import { describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
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
