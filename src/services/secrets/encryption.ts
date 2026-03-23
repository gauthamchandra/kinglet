/**
 * Secret Manager encryption layer - AES-256-GCM with PBKDF2 key derivation
 */

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = 'sha256';

export interface EncryptResult {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/**
 * Derive a 32-byte encryption key from a master key and salt using PBKDF2
 */
export function deriveKey(masterKey: string, salt: string): Buffer {
  return pbkdf2Sync(masterKey, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
}

/**
 * Encrypt plaintext using AES-256-GCM with a random IV
 */
export function encrypt(plaintext: Buffer, key: Buffer): EncryptResult {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted,
    iv,
    authTag,
  };
}

/**
 * Decrypt ciphertext using AES-256-GCM
 */
export function decrypt(ciphertext: Buffer, key: Buffer, iv: Buffer, authTag: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Re-encrypt data with a new key (for key rotation)
 */
export function reEncrypt(encrypted: EncryptResult, oldKey: Buffer, newKey: Buffer): EncryptResult {
  const plaintext = decrypt(encrypted.ciphertext, oldKey, encrypted.iv, encrypted.authTag);

  return encrypt(plaintext, newKey);
}
