/**
 * Tests for SecretRepository
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { SecretRepository } from './repository.ts';
import type { SecretRecord, SecretVersionRecord } from './types.ts';
import { SecretVersionState } from './types.ts';

function makeSecretData(
  overrides: Partial<Omit<SecretRecord, keyof BaseRecord>> = {}
): Omit<SecretRecord, keyof BaseRecord> {
  return {
    name: 'projects/test-project/secrets/test-secret',
    project: 'test-project',
    location: null,
    replication: JSON.stringify({ automatic: {} }),
    labels: JSON.stringify({}),
    annotations: JSON.stringify({}),
    expireTime: null,
    ttl: null,
    rotation: null,
    topics: null,
    versionAliases: JSON.stringify({}),
    versionDestroyTtl: null,
    etag: 'test-etag',
    nextVersionNumber: 1,
    ...overrides,
  };
}

function makeVersionData(
  overrides: Partial<Omit<SecretVersionRecord, keyof BaseRecord>> = {}
): Omit<SecretVersionRecord, keyof BaseRecord> {
  return {
    name: 'projects/test-project/secrets/test-secret/versions/1',
    secretName: 'projects/test-project/secrets/test-secret',
    versionNumber: 1,
    state: SecretVersionState.ENABLED,
    etag: 'version-etag',
    encryptedPayload: null,
    iv: null,
    authTag: null,
    payloadCrc32c: null,
    destroyTime: null,
    scheduledDestroyTime: null,
    ...overrides,
  };
}

describe('SecretRepository', () => {
  let storage: StorageManager;
  let repo: SecretRepository;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new SecretRepository(storage);
    await repo.initialize();
  });

  describe('initialize', () => {
    test('should create tables without error', async () => {
      const newStorage = new StorageManager();

      await newStorage.initialize({ type: 'memory' });

      const newRepo = new SecretRepository(newStorage);

      await expect(newRepo.initialize()).resolves.toBeUndefined();
    });
  });

  describe('createSecret', () => {
    test('should create a secret and return it with generated id', async () => {
      const data = makeSecretData();
      const secret = await repo.createSecret(data);

      expect(secret.id).toBeDefined();
      expect(secret.name).toBe(data.name);
      expect(secret.project).toBe('test-project');
      expect(secret.createdAt).toBeInstanceOf(Date);
      expect(secret.updatedAt).toBeInstanceOf(Date);
    });

    test('should reject duplicate secret names', async () => {
      const data = makeSecretData();

      await repo.createSecret(data);

      await expect(repo.createSecret(data)).rejects.toThrow();
    });
  });

  describe('getSecretByName', () => {
    test('should find a secret by name', async () => {
      const data = makeSecretData();

      await repo.createSecret(data);

      const found = await repo.getSecretByName(data.name);

      expect(found).not.toBeNull();
      expect(found?.name).toBe(data.name);
    });

    test('should return null for non-existent secret', async () => {
      const found = await repo.getSecretByName('projects/p/secrets/nonexistent');

      expect(found).toBeNull();
    });
  });

  describe('listSecrets', () => {
    test('should filter by project prefix', async () => {
      await repo.createSecret(makeSecretData({ name: 'projects/p1/secrets/s1', project: 'p1' }));
      await repo.createSecret(makeSecretData({ name: 'projects/p1/secrets/s2', project: 'p1' }));
      await repo.createSecret(makeSecretData({ name: 'projects/p2/secrets/s3', project: 'p2' }));

      const result = await repo.listSecrets('p1');

      expect(result.secrets.length).toBe(2);
    });

    test('should filter by project and location', async () => {
      await repo.createSecret(
        makeSecretData({
          name: 'projects/p1/locations/us-central1/secrets/s1',
          project: 'p1',
          location: 'us-central1',
        })
      );
      await repo.createSecret(
        makeSecretData({
          name: 'projects/p1/secrets/s2',
          project: 'p1',
        })
      );

      const result = await repo.listSecrets('p1', 'us-central1');

      expect(result.secrets.length).toBe(1);
      expect(result.secrets[0]?.location).toBe('us-central1');
    });

    test('should support pageSize and pageToken pagination', async () => {
      await repo.createSecret(makeSecretData({ name: 'projects/p/secrets/s1', project: 'p' }));
      await repo.createSecret(makeSecretData({ name: 'projects/p/secrets/s2', project: 'p' }));
      await repo.createSecret(makeSecretData({ name: 'projects/p/secrets/s3', project: 'p' }));

      const page1 = await repo.listSecrets('p', null, 2);

      expect(page1.secrets.length).toBe(2);
      expect(page1.nextPageToken).toBeDefined();

      const page2 = await repo.listSecrets('p', null, 2, page1.nextPageToken);

      expect(page2.secrets.length).toBe(1);
      expect(page2.nextPageToken).toBeUndefined();
    });
  });

  describe('updateSecret', () => {
    test('should update fields and return updated record', async () => {
      const data = makeSecretData();

      await repo.createSecret(data);

      const updated = await repo.updateSecret(data.name, {
        labels: JSON.stringify({ env: 'prod' }),
      });

      expect(updated).not.toBeNull();
      expect(updated?.labels).toBe(JSON.stringify({ env: 'prod' }));
    });

    test('should return null for non-existent secret', async () => {
      const updated = await repo.updateSecret('projects/p/secrets/nope', {
        labels: JSON.stringify({}),
      });

      expect(updated).toBeNull();
    });
  });

  describe('deleteSecret', () => {
    test('should remove secret and return true', async () => {
      const data = makeSecretData();

      await repo.createSecret(data);

      const deleted = await repo.deleteSecret(data.name);

      expect(deleted).toBe(true);

      const found = await repo.getSecretByName(data.name);

      expect(found).toBeNull();
    });

    test('should return false for non-existent secret', async () => {
      const deleted = await repo.deleteSecret('projects/p/secrets/nope');

      expect(deleted).toBe(false);
    });
  });

  describe('incrementVersionNumber', () => {
    test('should atomically increment and return current value', async () => {
      await repo.createSecret(makeSecretData({ nextVersionNumber: 1 }));

      const v1 = await repo.incrementVersionNumber('projects/test-project/secrets/test-secret');

      expect(v1).toBe(1);

      const v2 = await repo.incrementVersionNumber('projects/test-project/secrets/test-secret');

      expect(v2).toBe(2);
    });
  });

  describe('createSecretVersion', () => {
    test('should create a version record', async () => {
      const data = makeVersionData();
      const version = await repo.createSecretVersion(data);

      expect(version.id).toBeDefined();
      expect(version.name).toBe(data.name);
      expect(version.versionNumber).toBe(1);
      expect(version.state).toBe(SecretVersionState.ENABLED);
    });
  });

  describe('getSecretVersionByName', () => {
    test('should find version by name', async () => {
      const data = makeVersionData();

      await repo.createSecretVersion(data);

      const found = await repo.getSecretVersionByName(data.name);

      expect(found).not.toBeNull();
      expect(found?.versionNumber).toBe(1);
    });
  });

  describe('getLatestEnabledVersion', () => {
    test('should return highest versionNumber with state ENABLED', async () => {
      const secretName = 'projects/test-project/secrets/test-secret';

      await repo.createSecretVersion(
        makeVersionData({ name: `${secretName}/versions/1`, versionNumber: 1 })
      );
      await repo.createSecretVersion(
        makeVersionData({
          name: `${secretName}/versions/2`,
          versionNumber: 2,
          state: SecretVersionState.DISABLED,
        })
      );
      await repo.createSecretVersion(
        makeVersionData({ name: `${secretName}/versions/3`, versionNumber: 3 })
      );

      const latest = await repo.getLatestEnabledVersion(secretName);

      expect(latest).not.toBeNull();
      expect(latest?.versionNumber).toBe(3);
    });

    test('should return null when no enabled versions exist', async () => {
      const latest = await repo.getLatestEnabledVersion('projects/p/secrets/empty');

      expect(latest).toBeNull();
    });
  });

  describe('listSecretVersions', () => {
    test('should list versions for a secret with pagination', async () => {
      const secretName = 'projects/test-project/secrets/test-secret';

      await repo.createSecretVersion(
        makeVersionData({ name: `${secretName}/versions/1`, versionNumber: 1 })
      );
      await repo.createSecretVersion(
        makeVersionData({ name: `${secretName}/versions/2`, versionNumber: 2 })
      );
      await repo.createSecretVersion(
        makeVersionData({ name: `${secretName}/versions/3`, versionNumber: 3 })
      );

      const page1 = await repo.listSecretVersions(secretName, 2);

      expect(page1.versions.length).toBe(2);
      expect(page1.nextPageToken).toBeDefined();

      const page2 = await repo.listSecretVersions(secretName, 2, page1.nextPageToken);

      expect(page2.versions.length).toBe(1);
      expect(page2.nextPageToken).toBeUndefined();
    });
  });

  describe('updateSecretVersion', () => {
    test('should update version state', async () => {
      await repo.createSecretVersion(makeVersionData());

      const updated = await repo.updateSecretVersion(
        'projects/test-project/secrets/test-secret/versions/1',
        { state: SecretVersionState.DISABLED }
      );

      expect(updated).not.toBeNull();
      expect(updated?.state).toBe(SecretVersionState.DISABLED);
    });
  });

  describe('deleteSecretVersionsBySecretName', () => {
    test('should delete all versions for a secret', async () => {
      const secretName = 'projects/test-project/secrets/test-secret';

      await repo.createSecretVersion(
        makeVersionData({ name: `${secretName}/versions/1`, versionNumber: 1 })
      );
      await repo.createSecretVersion(
        makeVersionData({ name: `${secretName}/versions/2`, versionNumber: 2 })
      );

      const count = await repo.deleteSecretVersionsBySecretName(secretName);

      expect(count).toBe(2);

      const result = await repo.listSecretVersions(secretName);

      expect(result.versions.length).toBe(0);
    });
  });
});
