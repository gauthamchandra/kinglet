/**
 * Tests for the KMS repositories.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import {
  CryptoKeyRepository,
  CryptoKeyVersionRepository,
  KeyRingRepository,
} from './repository.ts';
import type { CryptoKeyRecord, CryptoKeyVersionRecord } from './types.ts';
import {
  CryptoKeyPurpose,
  CryptoKeyVersionAlgorithm,
  CryptoKeyVersionState,
  ProtectionLevel,
} from './types.ts';

const RING_NAME = 'projects/p/locations/us-central1/keyRings/r';
const KEY_NAME = `${RING_NAME}/cryptoKeys/k`;

let keyRingRepo: KeyRingRepository;
let cryptoKeyRepo: CryptoKeyRepository;
let versionRepo: CryptoKeyVersionRepository;

beforeEach(async () => {
  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  keyRingRepo = new KeyRingRepository(storage);
  await keyRingRepo.initialize();

  cryptoKeyRepo = new CryptoKeyRepository(storage);
  await cryptoKeyRepo.initialize();

  versionRepo = new CryptoKeyVersionRepository(storage);
  await versionRepo.initialize();
});

function keyData(
  overrides: Partial<Omit<CryptoKeyRecord, keyof BaseRecord>> = {}
): Omit<CryptoKeyRecord, keyof BaseRecord> {
  return {
    name: KEY_NAME,
    purpose: CryptoKeyPurpose.ENCRYPT_DECRYPT,
    protectionLevel: ProtectionLevel.SOFTWARE,
    algorithm: CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION,
    primaryVersion: null,
    labels: '{}',
    rotationPeriod: null,
    nextRotationTime: null,
    ...overrides,
  };
}

function versionData(
  versionNumber: number,
  overrides: Partial<Omit<CryptoKeyVersionRecord, keyof BaseRecord>> = {}
): Omit<CryptoKeyVersionRecord, keyof BaseRecord> {
  return {
    name: `${KEY_NAME}/cryptoKeyVersions/${versionNumber}`,
    cryptoKeyName: KEY_NAME,
    versionNumber,
    state: CryptoKeyVersionState.ENABLED,
    protectionLevel: ProtectionLevel.SOFTWARE,
    algorithm: CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION,
    keyMaterial: JSON.stringify({ secret: 'c2VjcmV0' }),
    generateTime: '2026-01-01T00:00:00.000Z',
    destroyTime: null,
    destroyEventTime: null,
    ...overrides,
  };
}

describe('KeyRingRepository', () => {
  test('creates and reads back a key ring', async () => {
    const created = await keyRingRepo.createKeyRing({ name: RING_NAME });

    expect(created.id).toBeTypeOf('string');
    expect(created.name).toBe(RING_NAME);
    expect(await keyRingRepo.getKeyRingByName(RING_NAME)).toMatchObject({ name: RING_NAME });
  });

  // The memory provider does not enforce unique indexes, so the guard is the repository's.
  test('rejects a duplicate key ring', async () => {
    await keyRingRepo.createKeyRing({ name: RING_NAME });

    await expect(keyRingRepo.createKeyRing({ name: RING_NAME })).rejects.toThrow(/already exists/);
  });

  test('returns null for an unknown key ring', async () => {
    expect(await keyRingRepo.getKeyRingByName(RING_NAME)).toBeNull();
  });

  test('lists only the key rings under the requested parent', async () => {
    await keyRingRepo.createKeyRing({ name: RING_NAME });
    await keyRingRepo.createKeyRing({ name: `${RING_NAME}-two` });
    await keyRingRepo.createKeyRing({ name: 'projects/other/locations/us-central1/keyRings/r' });

    const result = await keyRingRepo.listKeyRings('projects/p/locations/us-central1/keyRings/');

    expect(result.items.map(r => r.name)).toEqual([RING_NAME, `${RING_NAME}-two`]);
    expect(result.nextPageToken).toBeUndefined();
  });

  test('paginates with an offset token', async () => {
    for (const id of ['a', 'b', 'c']) {
      await keyRingRepo.createKeyRing({ name: `${RING_NAME}-${id}` });
    }

    const first = await keyRingRepo.listKeyRings('projects/p/locations/us-central1/keyRings/', 2);

    expect(first.items).toHaveLength(2);
    expect(first.nextPageToken).toBe('2');

    const second = await keyRingRepo.listKeyRings(
      'projects/p/locations/us-central1/keyRings/',
      2,
      first.nextPageToken
    );

    expect(second.items).toHaveLength(1);
    expect(second.nextPageToken).toBeUndefined();
  });

  test('treats a malformed page token as the first page', async () => {
    await keyRingRepo.createKeyRing({ name: RING_NAME });

    const result = await keyRingRepo.listKeyRings(
      'projects/p/locations/us-central1/keyRings/',
      10,
      'not-a-number'
    );

    expect(result.items).toHaveLength(1);
  });
});

describe('CryptoKeyRepository', () => {
  test('creates, reads, and updates a crypto key', async () => {
    await cryptoKeyRepo.createCryptoKey(keyData());

    const updated = await cryptoKeyRepo.updateCryptoKey(KEY_NAME, { primaryVersion: '1' });

    expect(updated?.primaryVersion).toBe('1');
    expect(await cryptoKeyRepo.getCryptoKeyByName(KEY_NAME)).toMatchObject({
      primaryVersion: '1',
    });
  });

  test('rejects a duplicate crypto key', async () => {
    await cryptoKeyRepo.createCryptoKey(keyData());

    await expect(cryptoKeyRepo.createCryptoKey(keyData())).rejects.toThrow(/already exists/);
  });

  test('returns null when updating an unknown crypto key', async () => {
    expect(await cryptoKeyRepo.updateCryptoKey(KEY_NAME, { primaryVersion: '1' })).toBeNull();
  });

  test('lists only the keys directly under a key ring', async () => {
    await cryptoKeyRepo.createCryptoKey(keyData());
    await cryptoKeyRepo.createCryptoKey(keyData({ name: `${RING_NAME}/cryptoKeys/k2` }));
    await cryptoKeyRepo.createCryptoKey(keyData({ name: `${RING_NAME}-other/cryptoKeys/k` }));

    const result = await cryptoKeyRepo.listCryptoKeys(RING_NAME);

    expect(result.items.map(r => r.name)).toEqual([KEY_NAME, `${RING_NAME}/cryptoKeys/k2`]);
  });
});

describe('CryptoKeyVersionRepository', () => {
  test('creates and reads back a version', async () => {
    const created = await versionRepo.createVersion(versionData(1));

    expect(created.name).toBe(`${KEY_NAME}/cryptoKeyVersions/1`);
    expect(await versionRepo.getVersionByName(created.name)).toMatchObject({ versionNumber: 1 });
  });

  test('rejects a duplicate version', async () => {
    await versionRepo.createVersion(versionData(1));

    await expect(versionRepo.createVersion(versionData(1))).rejects.toThrow(/already exists/);
  });

  test('updates a version and returns null for an unknown one', async () => {
    await versionRepo.createVersion(versionData(1));

    const updated = await versionRepo.updateVersion(`${KEY_NAME}/cryptoKeyVersions/1`, {
      state: CryptoKeyVersionState.DISABLED,
    });

    expect(updated?.state).toBe(CryptoKeyVersionState.DISABLED);
    expect(
      await versionRepo.updateVersion(`${KEY_NAME}/cryptoKeyVersions/99`, {
        state: CryptoKeyVersionState.DISABLED,
      })
    ).toBeNull();
  });

  test('orders versions numerically, not lexicographically', async () => {
    for (const n of [1, 2, 10, 11, 3]) {
      await versionRepo.createVersion(versionData(n));
    }

    const result = await versionRepo.listVersions(KEY_NAME);

    expect(result.items.map(v => v.versionNumber)).toEqual([1, 2, 3, 10, 11]);
  });

  describe('getHighestVersionNumber', () => {
    test('returns 0 for a key with no versions', async () => {
      expect(await versionRepo.getHighestVersionNumber(KEY_NAME)).toBe(0);
    });

    test('returns the numeric maximum, not the lexicographic one', async () => {
      for (const n of [1, 2, 10, 3]) {
        await versionRepo.createVersion(versionData(n));
      }

      expect(await versionRepo.getHighestVersionNumber(KEY_NAME)).toBe(10);
    });

    test('counts destroyed versions, whose ids stay taken', async () => {
      await versionRepo.createVersion(versionData(1));
      await versionRepo.createVersion(
        versionData(2, { state: CryptoKeyVersionState.DESTROYED, keyMaterial: '{}' })
      );

      expect(await versionRepo.getHighestVersionNumber(KEY_NAME)).toBe(2);
    });

    test('is scoped to one crypto key', async () => {
      const otherKey = `${RING_NAME}/cryptoKeys/other`;

      await versionRepo.createVersion(versionData(1));
      await versionRepo.createVersion(
        versionData(7, {
          name: `${otherKey}/cryptoKeyVersions/7`,
          cryptoKeyName: otherKey,
        })
      );

      expect(await versionRepo.getHighestVersionNumber(KEY_NAME)).toBe(1);
      expect(await versionRepo.getHighestVersionNumber(otherKey)).toBe(7);
    });
  });
});
