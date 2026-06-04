import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { KeyManagementService, KmsError } from './key-management-service.ts';
import {
  CryptoKeyRepository,
  CryptoKeyVersionRepository,
  KeyRingRepository,
} from './repository.ts';
import { CryptoKeyPurpose, CryptoKeyVersionAlgorithm, CryptoKeyVersionState } from './types.ts';

const PROJECT = 'test-project';
const LOCATION = 'us-central1';
const RING = 'test-ring';
const RING_NAME = `projects/${PROJECT}/locations/${LOCATION}/keyRings/${RING}`;

let svc: KeyManagementService;

beforeEach(async () => {
  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const keyRingRepo = new KeyRingRepository(storage);
  await keyRingRepo.initialize();

  const cryptoKeyRepo = new CryptoKeyRepository(storage);
  await cryptoKeyRepo.initialize();

  const versionRepo = new CryptoKeyVersionRepository(storage);
  await versionRepo.initialize();

  svc = new KeyManagementService(keyRingRepo, cryptoKeyRepo, versionRepo);
});

async function createRing(): Promise<void> {
  await svc.createKeyRing(PROJECT, LOCATION, RING);
}

describe('key rings', () => {
  test('creates, gets, and lists a key ring', async () => {
    const created = await svc.createKeyRing(PROJECT, LOCATION, RING);

    expect(created.name).toBe(RING_NAME);
    expect(created.createTime).toBeTypeOf('string');

    const fetched = await svc.getKeyRing(RING_NAME);
    expect(fetched.name).toBe(RING_NAME);

    const list = await svc.listKeyRings(PROJECT, LOCATION);
    expect(list.keyRings).toHaveLength(1);
    expect(list.keyRings[0]?.name).toBe(RING_NAME);
  });

  test('rejects duplicate key rings', async () => {
    await createRing();
    const promise = svc.createKeyRing(PROJECT, LOCATION, RING);

    await expect(promise).rejects.toBeInstanceOf(KmsError);
    await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
  });

  test('rejects an empty key ring id', async () => {
    const promise = svc.createKeyRing(PROJECT, LOCATION, '');

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('returns NOT_FOUND for a missing key ring', async () => {
    await expect(svc.getKeyRing(RING_NAME)).rejects.toHaveProperty('code', 'NOT_FOUND');
  });
});

describe('crypto keys', () => {
  beforeEach(createRing);

  test('creates an ENCRYPT_DECRYPT key with an enabled primary version', async () => {
    const key = await svc.createCryptoKey(RING_NAME, 'sym', { purpose: 'ENCRYPT_DECRYPT' }, false);

    expect(key.name).toBe(`${RING_NAME}/cryptoKeys/sym`);
    expect(key.purpose).toBe(CryptoKeyPurpose.ENCRYPT_DECRYPT);
    expect(key.versionTemplate.algorithm).toBe(
      CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION
    );
    expect(key.primary?.name).toBe(`${RING_NAME}/cryptoKeys/sym/cryptoKeyVersions/1`);
    expect(key.primary?.state).toBe(CryptoKeyVersionState.ENABLED);
  });

  test('asymmetric-sign keys have no primary version', async () => {
    const key = await svc.createCryptoKey(
      RING_NAME,
      'signer',
      { purpose: 'ASYMMETRIC_SIGN', versionTemplate: { algorithm: 'EC_SIGN_P256_SHA256' } },
      false
    );

    expect(key.purpose).toBe(CryptoKeyPurpose.ASYMMETRIC_SIGN);
    expect(key.primary).toBeUndefined();

    const versions = await svc.listCryptoKeyVersions(key.name);
    expect(versions.cryptoKeyVersions).toHaveLength(1);
  });

  test('skipInitialVersionCreation creates no version', async () => {
    const key = await svc.createCryptoKey(RING_NAME, 'empty', { purpose: 'ENCRYPT_DECRYPT' }, true);

    expect(key.primary).toBeUndefined();

    const versions = await svc.listCryptoKeyVersions(key.name);
    expect(versions.cryptoKeyVersions).toHaveLength(0);
  });

  test('requires a purpose', async () => {
    await expect(svc.createCryptoKey(RING_NAME, 'k', {}, false)).rejects.toHaveProperty(
      'code',
      'INVALID_ARGUMENT'
    );
  });

  test('rejects an algorithm that does not match the purpose', async () => {
    const promise = svc.createCryptoKey(
      RING_NAME,
      'k',
      { purpose: 'ENCRYPT_DECRYPT', versionTemplate: { algorithm: 'EC_SIGN_P256_SHA256' } },
      false
    );

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('rejects a non-SOFTWARE protection level', async () => {
    const promise = svc.createCryptoKey(
      RING_NAME,
      'k',
      {
        purpose: 'ENCRYPT_DECRYPT',
        versionTemplate: { algorithm: 'GOOGLE_SYMMETRIC_ENCRYPTION', protectionLevel: 'HSM' },
      },
      false
    );

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('rejects creating a key under a missing key ring', async () => {
    const promise = svc.createCryptoKey(
      `projects/${PROJECT}/locations/${LOCATION}/keyRings/ghost`,
      'k',
      { purpose: 'ENCRYPT_DECRYPT' },
      false
    );

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('rejects duplicate crypto keys', async () => {
    await svc.createCryptoKey(RING_NAME, 'dup', { purpose: 'ENCRYPT_DECRYPT' }, false);
    const promise = svc.createCryptoKey(RING_NAME, 'dup', { purpose: 'ENCRYPT_DECRYPT' }, false);

    await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
  });

  test('updates labels', async () => {
    await svc.createCryptoKey(RING_NAME, 'k', { purpose: 'ENCRYPT_DECRYPT' }, false);
    const name = `${RING_NAME}/cryptoKeys/k`;

    const updated = await svc.updateCryptoKey(name, { labels: { env: 'test' } }, 'labels');

    expect(updated.labels).toEqual({ env: 'test' });
  });
});

describe('crypto key versions', () => {
  const keyName = `${RING_NAME}/cryptoKeys/sym`;

  beforeEach(async () => {
    await createRing();
    await svc.createCryptoKey(RING_NAME, 'sym', { purpose: 'ENCRYPT_DECRYPT' }, false);
  });

  test('creating a version (rotation) does not change the primary', async () => {
    const v2 = await svc.createCryptoKeyVersion(keyName);

    expect(v2.name).toBe(`${keyName}/cryptoKeyVersions/2`);

    const key = await svc.getCryptoKey(keyName);
    expect(key.primary?.name).toBe(`${keyName}/cryptoKeyVersions/1`);
  });

  test('updatePrimaryVersion promotes a new version', async () => {
    await svc.createCryptoKeyVersion(keyName);
    const key = await svc.updatePrimaryVersion(keyName, '2');

    expect(key.primary?.name).toBe(`${keyName}/cryptoKeyVersions/2`);
  });

  test('updatePrimaryVersion rejects an unknown version', async () => {
    await expect(svc.updatePrimaryVersion(keyName, '99')).rejects.toHaveProperty(
      'code',
      'NOT_FOUND'
    );
  });

  test('updatePrimaryVersion is invalid for asymmetric keys', async () => {
    await svc.createCryptoKey(
      RING_NAME,
      'signer',
      { purpose: 'ASYMMETRIC_SIGN', versionTemplate: { algorithm: 'EC_SIGN_P256_SHA256' } },
      false
    );

    const promise = svc.updatePrimaryVersion(`${RING_NAME}/cryptoKeys/signer`, '1');
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('disables and re-enables a version', async () => {
    const v1 = `${keyName}/cryptoKeyVersions/1`;

    const disabled = await svc.updateCryptoKeyVersion(v1, { state: 'DISABLED' }, 'state');
    expect(disabled.state).toBe(CryptoKeyVersionState.DISABLED);

    const enabled = await svc.updateCryptoKeyVersion(v1, { state: 'ENABLED' }, 'state');
    expect(enabled.state).toBe(CryptoKeyVersionState.ENABLED);
  });

  test('rejects setting a version directly to DESTROYED', async () => {
    const promise = svc.updateCryptoKeyVersion(`${keyName}/cryptoKeyVersions/1`, {
      state: 'DESTROYED',
    });

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('destroys and restores a version', async () => {
    const v1 = `${keyName}/cryptoKeyVersions/1`;

    const destroyed = await svc.destroyCryptoKeyVersion(v1);
    expect(destroyed.state).toBe(CryptoKeyVersionState.DESTROY_SCHEDULED);
    expect(destroyed.destroyTime).toBeTypeOf('string');

    const restored = await svc.restoreCryptoKeyVersion(v1);
    expect(restored.state).toBe(CryptoKeyVersionState.DISABLED);
    expect(restored.destroyTime).toBeUndefined();
  });

  test('rejects destroying an already-scheduled version', async () => {
    const v1 = `${keyName}/cryptoKeyVersions/1`;
    await svc.destroyCryptoKeyVersion(v1);

    await expect(svc.destroyCryptoKeyVersion(v1)).rejects.toHaveProperty(
      'code',
      'FAILED_PRECONDITION'
    );
  });

  test('rejects restoring a version that is not scheduled for destruction', async () => {
    await expect(
      svc.restoreCryptoKeyVersion(`${keyName}/cryptoKeyVersions/1`)
    ).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
  });
});

describe('enum integer inputs (gapic enum-encoding=int)', () => {
  beforeEach(createRing);

  test('maps integer purpose + algorithm to canonical string enums', async () => {
    // 5 = ASYMMETRIC_SIGN, 12 = EC_SIGN_P256_SHA256 (note the gap at 11)
    const key = await svc.createCryptoKey(
      RING_NAME,
      'ec',
      { purpose: 5, versionTemplate: { algorithm: 12 } },
      false
    );

    expect(key.purpose).toBe(CryptoKeyPurpose.ASYMMETRIC_SIGN);
    expect(key.versionTemplate.algorithm).toBe(CryptoKeyVersionAlgorithm.EC_SIGN_P256_SHA256);
  });

  test('maps integer version state to DISABLED', async () => {
    await svc.createCryptoKey(RING_NAME, 'sym', { purpose: 1 }, false);
    const v1 = `${RING_NAME}/cryptoKeys/sym/cryptoKeyVersions/1`;

    const updated = await svc.updateCryptoKeyVersion(v1, { state: 2 }, 'state');
    expect(updated.state).toBe(CryptoKeyVersionState.DISABLED);
  });

  test('rejects an unknown integer algorithm with INVALID_ARGUMENT', async () => {
    const promise = svc.createCryptoKey(
      RING_NAME,
      'k',
      { purpose: 1, versionTemplate: { algorithm: 999 } },
      false
    );

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('rejects an unknown integer purpose with INVALID_ARGUMENT', async () => {
    await expect(
      svc.createCryptoKey(RING_NAME, 'k', { purpose: 999 }, false)
    ).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });
});

describe('version ordering and pagination', () => {
  beforeEach(createRing);

  test('lists versions in numeric order, not lexicographic', async () => {
    await svc.createCryptoKey(RING_NAME, 'sym', { purpose: 'ENCRYPT_DECRYPT' }, false);
    const name = `${RING_NAME}/cryptoKeys/sym`;

    // Create through version 11 so lexicographic order (1,10,11,2,...) would diverge.
    for (let i = 2; i <= 11; i++) {
      await svc.createCryptoKeyVersion(name);
    }

    const { cryptoKeyVersions } = await svc.listCryptoKeyVersions(name);
    const ids = cryptoKeyVersions.map(v => Number(v.name.split('/').pop()));

    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  test('paginates crypto keys across pages with stable, non-duplicating tokens', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      await svc.createCryptoKey(RING_NAME, id, { purpose: 'ENCRYPT_DECRYPT' }, true);
    }

    const names: string[] = [];
    let token: string | undefined;

    do {
      const page = await svc.listCryptoKeys(RING_NAME, 2, token);
      names.push(...page.cryptoKeys.map(k => k.name));
      token = page.nextPageToken;
    } while (token);

    expect(names).toHaveLength(5);
    expect(new Set(names).size).toBe(5);
  });

  test('treats a garbage page token as offset 0 rather than failing', async () => {
    await svc.createCryptoKey(RING_NAME, 'a', { purpose: 'ENCRYPT_DECRYPT' }, true);

    const page = await svc.listCryptoKeys(RING_NAME, 10, 'not-a-number');
    expect(page.cryptoKeys.length).toBeGreaterThanOrEqual(1);
  });
});

describe('updateMask + labels semantics', () => {
  beforeEach(createRing);

  test('version patch respects an updateMask that excludes state', async () => {
    await svc.createCryptoKey(RING_NAME, 'sym', { purpose: 'ENCRYPT_DECRYPT' }, false);
    const v1 = `${RING_NAME}/cryptoKeys/sym/cryptoKeyVersions/1`;

    // Mask excludes 'state', so the DISABLED change must NOT be applied.
    const result = await svc.updateCryptoKeyVersion(v1, { state: 'DISABLED' }, 'labels');
    expect(result.state).toBe(CryptoKeyVersionState.ENABLED);
  });

  test('clearing labels with {} omits the labels field on the response', async () => {
    await svc.createCryptoKey(
      RING_NAME,
      'k',
      { purpose: 'ENCRYPT_DECRYPT', labels: { a: '1' } },
      false
    );
    const name = `${RING_NAME}/cryptoKeys/k`;

    const cleared = await svc.updateCryptoKey(name, { labels: {} }, 'labels');
    expect(cleared.labels).toBeUndefined();
  });

  test('updateCryptoKey with a non-matching mask leaves labels unchanged', async () => {
    await svc.createCryptoKey(
      RING_NAME,
      'k',
      { purpose: 'ENCRYPT_DECRYPT', labels: { a: '1' } },
      false
    );
    const name = `${RING_NAME}/cryptoKeys/k`;

    const updated = await svc.updateCryptoKey(name, { labels: { b: '2' } }, 'rotationPeriod');
    expect(updated.labels).toEqual({ a: '1' });
  });
});
