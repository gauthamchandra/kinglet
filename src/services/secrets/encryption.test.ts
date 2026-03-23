/**
 * Tests for Secret Manager encryption layer
 */

import { describe, expect, test } from 'bun:test';
import { decrypt, deriveKey, encrypt, reEncrypt } from './encryption.ts';

describe('encrypt / decrypt', () => {
  const key = deriveKey('test-master-key', 'test-salt');

  test('should round-trip encrypt and decrypt a normal payload', () => {
    const plaintext = Buffer.from('my secret value');
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted.ciphertext, key, encrypted.iv, encrypted.authTag);

    expect(decrypted.toString()).toBe('my secret value');
  });

  test('should produce different ciphertexts for different plaintexts', () => {
    const enc1 = encrypt(Buffer.from('aaa'), key);
    const enc2 = encrypt(Buffer.from('bbb'), key);

    expect(enc1.ciphertext.equals(enc2.ciphertext)).toBe(false);
  });

  test('should produce different ciphertexts for same plaintext (unique IV)', () => {
    const plaintext = Buffer.from('same data');
    const enc1 = encrypt(plaintext, key);
    const enc2 = encrypt(plaintext, key);

    expect(enc1.iv.equals(enc2.iv)).toBe(false);
    expect(enc1.ciphertext.equals(enc2.ciphertext)).toBe(false);
  });

  test('should fail decryption with tampered ciphertext', () => {
    const encrypted = encrypt(Buffer.from('secret'), key);

    encrypted.ciphertext[0] = (encrypted.ciphertext[0] ?? 0) ^ 0xff;

    expect(() => decrypt(encrypted.ciphertext, key, encrypted.iv, encrypted.authTag)).toThrow();
  });

  test('should fail decryption with tampered auth tag', () => {
    const encrypted = encrypt(Buffer.from('secret'), key);
    const badTag = Buffer.from(encrypted.authTag);

    badTag[0] = (badTag[0] ?? 0) ^ 0xff;

    expect(() => decrypt(encrypted.ciphertext, key, encrypted.iv, badTag)).toThrow();
  });

  test('should fail decryption with wrong key', () => {
    const wrongKey = deriveKey('wrong-key', 'test-salt');
    const encrypted = encrypt(Buffer.from('secret'), key);

    expect(() =>
      decrypt(encrypted.ciphertext, wrongKey, encrypted.iv, encrypted.authTag)
    ).toThrow();
  });

  test('should handle empty payload round-trip', () => {
    const plaintext = Buffer.alloc(0);
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted.ciphertext, key, encrypted.iv, encrypted.authTag);

    expect(decrypted.length).toBe(0);
  });

  test('should handle large payload (64KB) round-trip', () => {
    const plaintext = Buffer.alloc(64 * 1024, 0x42);
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted.ciphertext, key, encrypted.iv, encrypted.authTag);

    expect(decrypted.equals(plaintext)).toBe(true);
  });
});

describe('deriveKey', () => {
  test('should produce same key for same inputs', () => {
    const key1 = deriveKey('master', 'salt');
    const key2 = deriveKey('master', 'salt');

    expect(key1.equals(key2)).toBe(true);
  });

  test('should produce different keys for different salts', () => {
    const key1 = deriveKey('master', 'salt-a');
    const key2 = deriveKey('master', 'salt-b');

    expect(key1.equals(key2)).toBe(false);
  });

  test('should return 32 bytes', () => {
    const key = deriveKey('any-key', 'any-salt');

    expect(key.length).toBe(32);
  });
});

describe('reEncrypt', () => {
  test('should decrypt with old key and re-encrypt with new key', () => {
    const oldKey = deriveKey('old-master', 'salt');
    const newKey = deriveKey('new-master', 'salt');

    const plaintext = Buffer.from('rotate me');
    const original = encrypt(plaintext, oldKey);
    const rotated = reEncrypt(original, oldKey, newKey);

    const decrypted = decrypt(rotated.ciphertext, newKey, rotated.iv, rotated.authTag);

    expect(decrypted.toString()).toBe('rotate me');
  });
});
