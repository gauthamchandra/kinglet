/**
 * Tests for SecretService - integration tests with real repository and encryption
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { deriveKey } from './encryption.ts';
import { SecretRepository } from './repository.ts';
import { SecretService, SecretsError } from './service.ts';

describe('SecretService', () => {
  let service: SecretService;

  beforeEach(async () => {
    const storage = new StorageManager();

    await storage.initialize({ type: 'memory' });

    const repo = new SecretRepository(storage);

    await repo.initialize();

    const key = deriveKey('test-master-key', 'test-salt');

    service = new SecretService(repo, key);
  });

  // ── Secret CRUD ──

  describe('createSecret', () => {
    test('should create secret with valid replication config', async () => {
      const result = await service.createSecret('my-project', 'my-secret', {
        replication: { automatic: {} },
      });

      expect(result.name).toBe('projects/my-project/secrets/my-secret');
      expect(result.createTime).toBeDefined();
      expect(result.etag).toBeDefined();
      expect(result.replication).toEqual({ automatic: {} });
    });

    test('should create secret with labels and annotations', async () => {
      const result = await service.createSecret('proj', 'sec', {
        replication: { automatic: {} },
        labels: { env: 'test' },
        annotations: { note: 'hello' },
      });

      expect(result.labels).toEqual({ env: 'test' });
      expect(result.annotations).toEqual({ note: 'hello' });
    });

    test('should throw ALREADY_EXISTS for duplicate', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });

      const promise = service.createSecret('proj', 'sec', {
        replication: { automatic: {} },
      });

      await expect(promise).rejects.toBeInstanceOf(SecretsError);
      await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
    });

    test('should throw INVALID_ARGUMENT for invalid body', async () => {
      const promise = service.createSecret('proj', 'sec', {});

      await expect(promise).rejects.toBeInstanceOf(SecretsError);
      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
    });
  });

  describe('getSecret', () => {
    test('should return secret by name', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });

      const result = await service.getSecret('projects/proj/secrets/sec');

      expect(result.name).toBe('projects/proj/secrets/sec');
    });

    test('should throw NOT_FOUND for missing secret', async () => {
      const promise = service.getSecret('projects/proj/secrets/nope');

      await expect(promise).rejects.toBeInstanceOf(SecretsError);
      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });
  });

  describe('listSecrets', () => {
    test('should paginate correctly', async () => {
      await service.createSecret('proj', 's1', { replication: { automatic: {} } });
      await service.createSecret('proj', 's2', { replication: { automatic: {} } });
      await service.createSecret('proj', 's3', { replication: { automatic: {} } });

      const page1 = await service.listSecrets('proj', null, 2);

      expect(page1.secrets.length).toBe(2);
      expect(page1.nextPageToken).toBeDefined();

      const page2 = await service.listSecrets('proj', null, 2, page1.nextPageToken);

      expect(page2.secrets.length).toBe(1);
    });

    test('should filter regional secrets by location', async () => {
      await service.createSecret('proj', 's1', { replication: { automatic: {} } }, 'us-central1');
      await service.createSecret('proj', 's2', { replication: { automatic: {} } });

      const result = await service.listSecrets('proj', 'us-central1');

      expect(result.secrets.length).toBe(1);
      expect(result.secrets[0]?.name).toContain('us-central1');
    });

    test('should return totalSize as total count, not page size', async () => {
      await service.createSecret('proj', 's1', { replication: { automatic: {} } });
      await service.createSecret('proj', 's2', { replication: { automatic: {} } });
      await service.createSecret('proj', 's3', { replication: { automatic: {} } });

      const page1 = await service.listSecrets('proj', null, 2);

      expect(page1.totalSize).toBe(3);
    });
  });

  describe('patchSecret', () => {
    test('should update mutable fields', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });

      const result = await service.patchSecret('projects/proj/secrets/sec', {
        labels: { env: 'prod' },
      });

      expect(result.labels).toEqual({ env: 'prod' });
    });

    test('should throw NOT_FOUND for missing secret', async () => {
      const promise = service.patchSecret('projects/proj/secrets/nope', {
        labels: {},
      });

      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });

    test('should only update fields specified in updateMask', async () => {
      await service.createSecret('proj', 'sec', {
        replication: { automatic: {} },
        labels: { env: 'dev' },
        annotations: { note: 'original' },
      });

      const result = await service.patchSecret(
        'projects/proj/secrets/sec',
        { labels: { env: 'prod' }, annotations: { note: 'changed' } },
        'labels'
      );

      expect(result.labels).toEqual({ env: 'prod' });
      expect(result.annotations).toEqual({ note: 'original' });
    });

    test('should update all body fields when updateMask is absent', async () => {
      await service.createSecret('proj', 'sec', {
        replication: { automatic: {} },
        labels: { env: 'dev' },
        annotations: { note: 'original' },
      });

      const result = await service.patchSecret('projects/proj/secrets/sec', {
        labels: { env: 'prod' },
        annotations: { note: 'changed' },
      });

      expect(result.labels).toEqual({ env: 'prod' });
      expect(result.annotations).toEqual({ note: 'changed' });
    });
  });

  describe('deleteSecret', () => {
    test('should remove secret and all versions', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('v1') },
      });

      await service.deleteSecret('projects/proj/secrets/sec');

      const promise = service.getSecret('projects/proj/secrets/sec');

      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });

    test('should throw NOT_FOUND for missing secret', async () => {
      const promise = service.deleteSecret('projects/proj/secrets/nope');

      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });
  });

  // ── Version Lifecycle ──

  describe('addVersion', () => {
    test('should return version with state ENABLED and versionNumber 1', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });

      const version = await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('my secret') },
      });

      expect(version.state).toBe('ENABLED');
      expect(version.name).toBe('projects/proj/secrets/sec/versions/1');
    });

    test('should increment version numbers', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });

      const v1 = await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('v1') },
      });
      const v2 = await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('v2') },
      });
      const v3 = await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('v3') },
      });

      expect(v1.name).toEndWith('/versions/1');
      expect(v2.name).toEndWith('/versions/2');
      expect(v3.name).toEndWith('/versions/3');
    });

    test('should throw NOT_FOUND for non-existent secret', async () => {
      const promise = service.addVersion('projects/proj/secrets/nope', {
        payload: { data: btoa('data') },
      });

      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });

    test('should include clientSpecifiedPayloadChecksum when dataCrc32c is provided', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });

      const version = await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('data'), dataCrc32c: '12345' },
      });

      expect(version.clientSpecifiedPayloadChecksum).toBe(true);
    });

    test('should not include clientSpecifiedPayloadChecksum when dataCrc32c is absent', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });

      const version = await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('data') },
      });

      expect(version.clientSpecifiedPayloadChecksum).toBeUndefined();
    });
  });

  describe('getVersion', () => {
    test('should return version metadata', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('data') },
      });

      const version = await service.getVersion('projects/proj/secrets/sec/versions/1');

      expect(version.name).toBe('projects/proj/secrets/sec/versions/1');
      expect(version.state).toBe('ENABLED');
    });

    test('should include replicationStatus with automatic config', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('data') },
      });

      const version = await service.getVersion('projects/proj/secrets/sec/versions/1');

      expect(version.replicationStatus).toEqual({ automatic: {} });
    });
  });

  describe('accessVersion', () => {
    test('should return decrypted base64 payload by version number', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('my secret value') },
      });

      const result = await service.accessVersion('projects/proj/secrets/sec/versions/1');

      expect(result.name).toBe('projects/proj/secrets/sec/versions/1');
      expect(atob(result.payload.data)).toBe('my secret value');
    });

    test('should resolve "latest" to highest enabled version', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('v1') },
      });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('v2') },
      });

      const result = await service.accessVersion('projects/proj/secrets/sec/versions/latest');

      expect(atob(result.payload.data)).toBe('v2');
    });

    test('should throw FAILED_PRECONDITION on DISABLED version', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('data') },
      });
      await service.disableVersion('projects/proj/secrets/sec/versions/1');

      const promise = service.accessVersion('projects/proj/secrets/sec/versions/1');

      await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
    });

    test('should throw FAILED_PRECONDITION on DESTROYED version', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('data') },
      });
      await service.destroyVersion('projects/proj/secrets/sec/versions/1');

      const promise = service.accessVersion('projects/proj/secrets/sec/versions/1');

      await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
    });

    test('should throw NOT_FOUND for non-existent version', async () => {
      const promise = service.accessVersion('projects/proj/secrets/sec/versions/99');

      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });
  });

  describe('disableVersion', () => {
    test('should set state to DISABLED', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('data') },
      });

      const result = await service.disableVersion('projects/proj/secrets/sec/versions/1');

      expect(result.state).toBe('DISABLED');
    });

    test('should be idempotent for already DISABLED', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('data') },
      });
      await service.disableVersion('projects/proj/secrets/sec/versions/1');

      const result = await service.disableVersion('projects/proj/secrets/sec/versions/1');

      expect(result.state).toBe('DISABLED');
    });

    test('should throw FAILED_PRECONDITION on DESTROYED version', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('data') },
      });
      await service.destroyVersion('projects/proj/secrets/sec/versions/1');

      const promise = service.disableVersion('projects/proj/secrets/sec/versions/1');

      await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
    });
  });

  describe('enableVersion', () => {
    test('should set state back to ENABLED', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('data') },
      });
      await service.disableVersion('projects/proj/secrets/sec/versions/1');

      const result = await service.enableVersion('projects/proj/secrets/sec/versions/1');

      expect(result.state).toBe('ENABLED');
    });

    test('should throw FAILED_PRECONDITION on DESTROYED version', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('data') },
      });
      await service.destroyVersion('projects/proj/secrets/sec/versions/1');

      const promise = service.enableVersion('projects/proj/secrets/sec/versions/1');

      await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
    });
  });

  describe('destroyVersion', () => {
    test('should set state to DESTROYED with destroyTime and clear payload', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('data') },
      });

      const result = await service.destroyVersion('projects/proj/secrets/sec/versions/1');

      expect(result.state).toBe('DESTROYED');
      expect(result.destroyTime).toBeDefined();
    });

    test('should be idempotent for already destroyed version', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('data') },
      });

      const first = await service.destroyVersion('projects/proj/secrets/sec/versions/1');
      const second = await service.destroyVersion('projects/proj/secrets/sec/versions/1');

      expect(second.state).toBe('DESTROYED');
      expect(second.destroyTime).toBe(first.destroyTime);
    });
  });

  describe('listVersions', () => {
    test('should return all versions ordered by versionNumber', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('v1') },
      });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('v2') },
      });

      const result = await service.listVersions('projects/proj/secrets/sec');

      expect(result.versions.length).toBe(2);
      expect(result.versions[0]?.name).toEndWith('/versions/1');
      expect(result.versions[1]?.name).toEndWith('/versions/2');
    });

    test('should paginate versions', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('v1') },
      });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('v2') },
      });
      await service.addVersion('projects/proj/secrets/sec', {
        payload: { data: btoa('v3') },
      });

      const page1 = await service.listVersions('projects/proj/secrets/sec', 2);

      expect(page1.versions.length).toBe(2);
      expect(page1.nextPageToken).toBeDefined();
    });

    test('should return totalSize as total count, not page size', async () => {
      await service.createSecret('proj', 'sec', { replication: { automatic: {} } });
      await service.addVersion('projects/proj/secrets/sec', { payload: { data: btoa('v1') } });
      await service.addVersion('projects/proj/secrets/sec', { payload: { data: btoa('v2') } });
      await service.addVersion('projects/proj/secrets/sec', { payload: { data: btoa('v3') } });

      const page1 = await service.listVersions('projects/proj/secrets/sec', 2);

      expect(page1.totalSize).toBe(3);
    });
  });
});
