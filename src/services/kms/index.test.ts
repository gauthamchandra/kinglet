import { describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { CloudKmsService } from './index.ts';

async function makeService(): Promise<CloudKmsService> {
  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  return new CloudKmsService(storage, new Logger('test', 'error'));
}

describe('CloudKmsService', () => {
  test('getRoutes throws before initialize', async () => {
    const service = await makeService();

    expect(() => service.getRoutes()).toThrow();
  });

  test('exposes the full route surface after initialize', async () => {
    const service = await makeService();
    await service.initialize();

    const ids = service.getRoutes().map(r => r.id);

    expect(ids).toContain('kms.keyRings.create');
    expect(ids).toContain('kms.cryptoKeys.encrypt');
    expect(ids).toContain('kms.cryptoKeys.decrypt');
    expect(ids).toContain('kms.cryptoKeyVersions.asymmetricSign');
    expect(ids).toContain('kms.cryptoKeyVersions.macVerify');
    expect(ids).toContain('kms.cryptoKeyVersions.getPublicKey');
    expect(ids).toContain('kms.locations.generateRandomBytes');
  });

  test('start and stop are safe lifecycle no-ops', async () => {
    const service = await makeService();
    await service.initialize();

    expect(() => service.start()).not.toThrow();
    await expect(service.stop()).resolves.toBeUndefined();
  });
});
