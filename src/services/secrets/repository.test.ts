import { describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { SecretRepository } from './repository.ts';

describe('SecretRepository', () => {
  test('looks up names exactly on memory and sqlite', async () => {
    for (const storageType of ['memory', 'sqlite'] as const) {
      const storage = new StorageManager();

      await storage.initialize(
        storageType === 'memory'
          ? { type: 'memory' }
          : { type: 'sqlite', database: { memory: true } }
      );

      const repository = new SecretRepository(storage);

      await repository.initialize();
      await repository.initialize();

      const parent = 'projects/demo';

      await repository.insert(secret('projects/demo/secrets/a_b', parent));
      await repository.insert(secret('projects/demo/secrets/aXb', parent));
      await repository.insert(secret('projects/demo/secrets/A_b', parent));

      expect((await repository.getByName('projects/demo/secrets/a_b'))?.name).toBe(
        'projects/demo/secrets/a_b'
      );
      expect(await repository.getByName('projects/demo/secrets/axb')).toBeNull();
      expect((await repository.getByName('projects/demo/secrets/A_b'))?.spec.labels.env).toBe(
        'prod'
      );
    }
  });

  test('lists versions newest first by exact secret name on memory and sqlite', async () => {
    for (const storageType of ['memory', 'sqlite'] as const) {
      const repository = await repositoryOn(storageType);

      for (const number of [1, 2, 3]) {
        await repository.insertVersion(version('projects/demo/secrets/a_b', number));
      }

      await repository.insertVersion(version('projects/demo/secrets/aXb', 1));
      await repository.insertVersion(version('projects/demo/secrets/a_b2', 1));

      const page = await repository.listVersions('projects/demo/secrets/a_b', 2, 1);

      expect(page.versions.map(row => row.number)).toEqual([2, 1]);
      expect(page.total).toBe(3);
    }
  });

  test('updates one version and can null its payload on memory and sqlite', async () => {
    for (const storageType of ['memory', 'sqlite'] as const) {
      const repository = await repositoryOn(storageType);

      await repository.insertVersion(version('projects/demo/secrets/db', 1));
      await repository.insertVersion(version('projects/demo/secrets/db', 2));

      await repository.updateVersion('projects/demo/secrets/db', 1, {
        state: 'DESTROYED',
        generation: 2,
        destroyTime: '2026-02-01T00:00:00.000Z',
        payloadData: null,
        payloadCrc32c: null,
      });

      const updated = await repository.findVersion('projects/demo/secrets/db', 1);

      expect(updated?.state).toBe('DESTROYED');
      expect(updated?.payloadData).toBeNull();
      expect(updated?.payloadCrc32c).toBeNull();
      expect(updated?.destroyTime).toBe('2026-02-01T00:00:00.000Z');
      expect(updated?.generation).toBe(2);

      const untouched = await repository.findVersion('projects/demo/secrets/db', 2);

      expect(untouched?.state).toBe('ENABLED');
      expect(untouched?.payloadData).toBe('cGF5bG9hZA==');
    }
  });
});

async function repositoryOn(storageType: 'memory' | 'sqlite'): Promise<SecretRepository> {
  const storage = new StorageManager();

  await storage.initialize(
    storageType === 'memory' ? { type: 'memory' } : { type: 'sqlite', database: { memory: true } }
  );

  const repository = new SecretRepository(storage);

  await repository.initialize();

  return repository;
}

function version(secretName: string, number: number) {
  return {
    secretName,
    number,
    state: 'ENABLED' as const,
    createTime: '2026-01-01T00:00:00.000Z',
    destroyTime: null,
    generation: 1,
    payloadData: 'cGF5bG9hZA==',
    payloadCrc32c: '123',
    clientSpecifiedPayloadChecksum: false,
  };
}

function secret(name: string, parent: string) {
  return {
    name,
    parent,
    generation: 1,
    createTime: '2026-01-01T00:00:00.000Z',
    spec: {
      replication: { kind: 'automatic' as const, cmek: null },
      labels: { env: 'prod' },
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
}
