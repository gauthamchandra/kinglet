import { beforeEach, describe, expect, test } from 'bun:test';
import { constants, createPublicKey, verify as cryptoVerify, publicEncrypt } from 'node:crypto';
import { StorageManager } from '@/core/storage/manager.ts';
import { CryptoService } from './crypto-service.ts';
import { KeyManagementService, KmsError } from './key-management-service.ts';
import {
  CryptoKeyRepository,
  CryptoKeyVersionRepository,
  KeyRingRepository,
} from './repository.ts';

const PROJECT = 'p';
const LOCATION = 'us-central1';
const RING = 'r';
const RING_NAME = `projects/${PROJECT}/locations/${LOCATION}/keyRings/${RING}`;

let management: KeyManagementService;
let crypto: CryptoService;

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const keyName = (id: string): string => `${RING_NAME}/cryptoKeys/${id}`;
const versionName = (id: string, v = '1'): string => `${keyName(id)}/cryptoKeyVersions/${v}`;

beforeEach(async () => {
  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const keyRingRepo = new KeyRingRepository(storage);
  await keyRingRepo.initialize();
  const cryptoKeyRepo = new CryptoKeyRepository(storage);
  await cryptoKeyRepo.initialize();
  const versionRepo = new CryptoKeyVersionRepository(storage);
  await versionRepo.initialize();

  management = new KeyManagementService(keyRingRepo, cryptoKeyRepo, versionRepo);
  crypto = new CryptoService(cryptoKeyRepo, versionRepo);

  await management.createKeyRing(PROJECT, LOCATION, RING);
});

async function createKey(id: string, purpose: string, algorithm?: string): Promise<void> {
  await management.createCryptoKey(
    RING_NAME,
    id,
    algorithm ? { purpose, versionTemplate: { algorithm } } : { purpose },
    false
  );
}

describe('symmetric encrypt/decrypt', () => {
  beforeEach(() => createKey('sym', 'ENCRYPT_DECRYPT'));

  test('round-trips plaintext through encrypt then decrypt', async () => {
    const { ciphertext } = await crypto.encrypt(keyName('sym'), bytes('hello kms'));
    const { plaintext, usedPrimary } = await crypto.decrypt(keyName('sym'), ciphertext);

    expect(text(plaintext)).toBe('hello kms');
    expect(usedPrimary).toBe(true);
  });

  test('round-trips with additional authenticated data', async () => {
    const aad = bytes('ctx');
    const { ciphertext } = await crypto.encrypt(keyName('sym'), bytes('secret'), aad);

    expect(text((await crypto.decrypt(keyName('sym'), ciphertext, aad)).plaintext)).toBe('secret');
  });

  test('fails to decrypt when AAD does not match', async () => {
    const { ciphertext } = await crypto.encrypt(keyName('sym'), bytes('secret'), bytes('aad-a'));
    const promise = crypto.decrypt(keyName('sym'), ciphertext, bytes('aad-b'));

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('reports the primary key version used for encryption', async () => {
    const { keyVersionName } = await crypto.encrypt(keyName('sym'), bytes('x'));

    expect(keyVersionName).toBe(versionName('sym'));
  });

  test('decrypts ciphertext from an older version after rotation', async () => {
    const oldCiphertext = (await crypto.encrypt(keyName('sym'), bytes('v1 data'))).ciphertext;

    await management.createCryptoKeyVersion(keyName('sym'));
    await management.updatePrimaryVersion(keyName('sym'), '2');

    // New encryptions use v2, but the v1 ciphertext must still decrypt.
    const newResult = await crypto.encrypt(keyName('sym'), bytes('v2 data'));
    expect(newResult.keyVersionName).toBe(versionName('sym', '2'));

    const oldDecrypt = await crypto.decrypt(keyName('sym'), oldCiphertext);
    expect(text(oldDecrypt.plaintext)).toBe('v1 data');
    expect(oldDecrypt.usedPrimary).toBe(false); // v1 is no longer the primary

    const newDecrypt = await crypto.decrypt(keyName('sym'), newResult.ciphertext);
    expect(text(newDecrypt.plaintext)).toBe('v2 data');
    expect(newDecrypt.usedPrimary).toBe(true);
  });

  test('fails to decrypt when the encrypting version is disabled', async () => {
    const { ciphertext } = await crypto.encrypt(keyName('sym'), bytes('data'));

    await management.updateCryptoKeyVersion(versionName('sym'), { state: 'DISABLED' });

    await expect(crypto.decrypt(keyName('sym'), ciphertext)).rejects.toHaveProperty(
      'code',
      'FAILED_PRECONDITION'
    );
  });

  test('fails to decrypt when the encrypting version is scheduled for destruction', async () => {
    const { ciphertext } = await crypto.encrypt(keyName('sym'), bytes('data'));

    await management.destroyCryptoKeyVersion(versionName('sym'));

    await expect(crypto.decrypt(keyName('sym'), ciphertext)).rejects.toHaveProperty(
      'code',
      'FAILED_PRECONDITION'
    );
  });

  test('rejects corrupt ciphertext', async () => {
    await expect(crypto.decrypt(keyName('sym'), bytes('garbage'))).rejects.toHaveProperty(
      'code',
      'INVALID_ARGUMENT'
    );
  });

  test('rejects encrypt on a non-encrypt key', async () => {
    await createKey('signer', 'ASYMMETRIC_SIGN', 'EC_SIGN_P256_SHA256');

    await expect(crypto.encrypt(keyName('signer'), bytes('x'))).rejects.toHaveProperty(
      'code',
      'INVALID_ARGUMENT'
    );
  });
});

describe('asymmetric signing', () => {
  test('EC signature verifies against the exported public key', async () => {
    await createKey('ec', 'ASYMMETRIC_SIGN', 'EC_SIGN_P256_SHA256');
    const data = bytes('sign me');

    const { signature } = await crypto.asymmetricSign(versionName('ec'), { data });
    const { pem } = await crypto.getPublicKey(versionName('ec'));

    const ok = cryptoVerify(
      'sha256',
      Buffer.from(data),
      { key: createPublicKey(pem), dsaEncoding: 'der' },
      Buffer.from(signature)
    );

    expect(ok).toBe(true);
  });

  test('RSA-PKCS1 signature verifies against the exported public key', async () => {
    await createKey('rsa', 'ASYMMETRIC_SIGN', 'RSA_SIGN_PKCS1_2048_SHA256');
    const data = bytes('sign me too');

    const { signature } = await crypto.asymmetricSign(versionName('rsa'), { data });
    const { pem } = await crypto.getPublicKey(versionName('rsa'));

    const ok = cryptoVerify(
      'sha256',
      Buffer.from(data),
      { key: createPublicKey(pem), padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(signature)
    );

    expect(ok).toBe(true);
  });

  test('rejects signing on an encrypt key', async () => {
    await createKey('sym', 'ENCRYPT_DECRYPT');

    await expect(
      crypto.asymmetricSign(versionName('sym'), { data: bytes('x') })
    ).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });
});

describe('asymmetric decryption', () => {
  test('decrypts data encrypted with the exported public key', async () => {
    await createKey('dec', 'ASYMMETRIC_DECRYPT', 'RSA_DECRYPT_OAEP_2048_SHA256');
    const { pem } = await crypto.getPublicKey(versionName('dec'));

    const ciphertext = publicEncrypt(
      { key: createPublicKey(pem), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(bytes('rsa secret'))
    );

    const plaintext = await crypto.asymmetricDecrypt(
      versionName('dec'),
      new Uint8Array(ciphertext)
    );
    expect(text(plaintext)).toBe('rsa secret');
  });
});

describe('MAC', () => {
  beforeEach(() => createKey('mac', 'MAC', 'HMAC_SHA256'));

  test('sign then verify succeeds', async () => {
    const data = bytes('authenticate');
    const { mac } = await crypto.macSign(versionName('mac'), data);

    const { success } = await crypto.macVerify(versionName('mac'), data, mac);
    expect(success).toBe(true);
  });

  test('verify fails for a tampered message', async () => {
    const { mac } = await crypto.macSign(versionName('mac'), bytes('original'));

    const { success } = await crypto.macVerify(versionName('mac'), bytes('tampered'), mac);
    expect(success).toBe(false);
  });
});

describe('getPublicKey errors', () => {
  test('FAILED_PRECONDITION for a symmetric key', async () => {
    await createKey('sym', 'ENCRYPT_DECRYPT');

    await expect(crypto.getPublicKey(versionName('sym'))).rejects.toHaveProperty(
      'code',
      'FAILED_PRECONDITION'
    );
  });

  test('NOT_FOUND for a missing version', async () => {
    await expect(crypto.getPublicKey(versionName('ghost'))).rejects.toBeInstanceOf(KmsError);
    await expect(crypto.getPublicKey(versionName('ghost'))).rejects.toHaveProperty(
      'code',
      'NOT_FOUND'
    );
  });

  test('FAILED_PRECONDITION for a disabled asymmetric version', async () => {
    await createKey('ec', 'ASYMMETRIC_SIGN', 'EC_SIGN_P256_SHA256');
    await management.updateCryptoKeyVersion(versionName('ec'), { state: 'DISABLED' });

    await expect(crypto.getPublicKey(versionName('ec'))).rejects.toHaveProperty(
      'code',
      'FAILED_PRECONDITION'
    );
  });
});
