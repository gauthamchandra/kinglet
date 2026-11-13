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

  test('lists one parent exactly, newest first, with the parent total', async () => {
    for (const repository of await repositories()) {
      await repository.insert(secret('projects/a_b/secrets/old', 'projects/a_b', '2026-01-01'));
      await repository.insert(secret('projects/a_b/secrets/new', 'projects/a_b', '2026-03-01'));
      await repository.insert(secret('projects/a_b/secrets/mid', 'projects/a_b', '2026-02-01'));
      await repository.insert(secret('projects/aXb/secrets/x', 'projects/aXb'));
      await repository.insert(secret('projects/A_b/secrets/y', 'projects/A_b'));
      await repository.insert(
        secret('projects/a_b/locations/l/secrets/z', 'projects/a_b/locations/l')
      );

      const first = await repository.listByParent('projects/a_b', 0, 2);
      const second = await repository.listByParent('projects/a_b', 2, 2);

      expect(first.secrets.map(stored => stored.name)).toEqual([
        'projects/a_b/secrets/new',
        'projects/a_b/secrets/mid',
      ]);
      expect(first.total).toBe(3);
      expect(first.hasMore).toBe(true);
      expect(second.secrets.map(stored => stored.name)).toEqual(['projects/a_b/secrets/old']);
      expect(second.hasMore).toBe(false);
    }
  });

  test('deletes a secret row and only its own version rows', async () => {
    for (const repository of await repositories()) {
      await repository.insert(secret('projects/p/secrets/a', 'projects/p'));
      await repository.insert(secret('projects/p/secrets/a_', 'projects/p'));
      await repository.insertVersion(version('projects/p/secrets/a', 1));
      await repository.insertVersion(version('projects/p/secrets/a', 2));
      await repository.insertVersion(version('projects/p/secrets/a_', 1));

      await repository.deleteVersions('projects/p/secrets/a');
      await repository.deleteByName('projects/p/secrets/a');

      expect(await repository.getByName('projects/p/secrets/a')).toBeNull();
      expect(await repository.findNewestVersion('projects/p/secrets/a')).toBeNull();
      expect((await repository.findNewestVersion('projects/p/secrets/a_'))?.number).toBe(1);
      expect((await repository.getByName('projects/p/secrets/a_'))?.name).toBe(
        'projects/p/secrets/a_'
      );
    }
  });
});

async function repositories(): Promise<SecretRepository[]> {
  const result: SecretRepository[] = [];

  for (const storageType of ['memory', 'sqlite'] as const) {
    const storage = new StorageManager();

    await storage.initialize(
      storageType === 'memory' ? { type: 'memory' } : { type: 'sqlite', database: { memory: true } }
    );

    const repository = new SecretRepository(storage);

    await repository.initialize();
    result.push(repository);
  }

  return result;
}

function version(secretName: string, number: number) {
  return {
    secretName,
    number,
    state: 'ENABLED' as const,
    createTime: '2026-01-01T00:00:00.000Z',
    destroyTime: null,
    generation: 1,
    payloadData: 'YQ==',
    payloadCrc32c: '1',
    clientSpecifiedPayloadChecksum: false,
  };
}

function secret(name: string, parent: string, day = '2026-01-01') {
  return {
    name,
    parent,
    generation: 1,
    createTime: `${day}T00:00:00.000Z`,
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
