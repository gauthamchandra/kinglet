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
});

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
