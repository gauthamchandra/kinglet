/**
 * Cloud KMS crypto engine — the actual cryptographic primitives.
 *
 * This module is deliberately storage-free and stateless: it turns algorithm
 * names + key material into real cryptographic operations using Node's `crypto`
 * module (chosen over WebCrypto because it can synchronously generate and export
 * RSA/EC key pairs as PEM — see docs/adrs/008). All inputs/outputs are raw bytes;
 * base64/JSON transport concerns live in the handler layer.
 *
 * Symmetric ciphertext is an opaque, self-describing envelope so that decrypt can
 * locate the originating key version even after key rotation:
 *   [0x01 format][versionId uint32 BE][iv 12B][gcm tag 16B][ciphertext...]
 */

import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHmac,
  sign as cryptoSign,
  generateKeyPairSync,
  privateDecrypt,
  privateEncrypt,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  CryptoKeyPurpose,
  type CryptoKeyPurposeValue,
  CryptoKeyVersionAlgorithm,
} from './types.ts';

const ENVELOPE_FORMAT_VERSION = 0x01;
const IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const AES_KEY_LENGTH = 32; // AES-256

export type AlgorithmKind = 'symmetric' | 'asymmetric-sign' | 'asymmetric-decrypt' | 'mac';

interface AlgorithmSpec {
  purpose: CryptoKeyPurposeValue;
  kind: AlgorithmKind;
  hash: 'sha256' | 'sha384';
  /** For RSA signing keys: which padding scheme. */
  rsaSignScheme?: 'pkcs1' | 'pss';
  /** node:crypto key generation parameters. */
  keyGen:
    | { type: 'symmetric' }
    | { type: 'rsa'; modulusLength: number }
    | { type: 'ec'; namedCurve: string };
}

const SPECS: Record<string, AlgorithmSpec> = {
  [CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION]: {
    purpose: CryptoKeyPurpose.ENCRYPT_DECRYPT,
    kind: 'symmetric',
    hash: 'sha256',
    keyGen: { type: 'symmetric' },
  },
  [CryptoKeyVersionAlgorithm.HMAC_SHA256]: {
    purpose: CryptoKeyPurpose.MAC,
    kind: 'mac',
    hash: 'sha256',
    keyGen: { type: 'symmetric' },
  },
  [CryptoKeyVersionAlgorithm.EC_SIGN_P256_SHA256]: {
    purpose: CryptoKeyPurpose.ASYMMETRIC_SIGN,
    kind: 'asymmetric-sign',
    hash: 'sha256',
    keyGen: { type: 'ec', namedCurve: 'P-256' },
  },
  [CryptoKeyVersionAlgorithm.EC_SIGN_P384_SHA384]: {
    purpose: CryptoKeyPurpose.ASYMMETRIC_SIGN,
    kind: 'asymmetric-sign',
    hash: 'sha384',
    keyGen: { type: 'ec', namedCurve: 'P-384' },
  },
  [CryptoKeyVersionAlgorithm.RSA_SIGN_PKCS1_2048_SHA256]: {
    purpose: CryptoKeyPurpose.ASYMMETRIC_SIGN,
    kind: 'asymmetric-sign',
    hash: 'sha256',
    rsaSignScheme: 'pkcs1',
    keyGen: { type: 'rsa', modulusLength: 2048 },
  },
  [CryptoKeyVersionAlgorithm.RSA_SIGN_PKCS1_3072_SHA256]: {
    purpose: CryptoKeyPurpose.ASYMMETRIC_SIGN,
    kind: 'asymmetric-sign',
    hash: 'sha256',
    rsaSignScheme: 'pkcs1',
    keyGen: { type: 'rsa', modulusLength: 3072 },
  },
  [CryptoKeyVersionAlgorithm.RSA_SIGN_PKCS1_4096_SHA256]: {
    purpose: CryptoKeyPurpose.ASYMMETRIC_SIGN,
    kind: 'asymmetric-sign',
    hash: 'sha256',
    rsaSignScheme: 'pkcs1',
    keyGen: { type: 'rsa', modulusLength: 4096 },
  },
  [CryptoKeyVersionAlgorithm.RSA_SIGN_PSS_2048_SHA256]: {
    purpose: CryptoKeyPurpose.ASYMMETRIC_SIGN,
    kind: 'asymmetric-sign',
    hash: 'sha256',
    rsaSignScheme: 'pss',
    keyGen: { type: 'rsa', modulusLength: 2048 },
  },
  [CryptoKeyVersionAlgorithm.RSA_SIGN_PSS_3072_SHA256]: {
    purpose: CryptoKeyPurpose.ASYMMETRIC_SIGN,
    kind: 'asymmetric-sign',
    hash: 'sha256',
    rsaSignScheme: 'pss',
    keyGen: { type: 'rsa', modulusLength: 3072 },
  },
  [CryptoKeyVersionAlgorithm.RSA_SIGN_PSS_4096_SHA256]: {
    purpose: CryptoKeyPurpose.ASYMMETRIC_SIGN,
    kind: 'asymmetric-sign',
    hash: 'sha256',
    rsaSignScheme: 'pss',
    keyGen: { type: 'rsa', modulusLength: 4096 },
  },
  [CryptoKeyVersionAlgorithm.RSA_DECRYPT_OAEP_2048_SHA256]: {
    purpose: CryptoKeyPurpose.ASYMMETRIC_DECRYPT,
    kind: 'asymmetric-decrypt',
    hash: 'sha256',
    keyGen: { type: 'rsa', modulusLength: 2048 },
  },
  [CryptoKeyVersionAlgorithm.RSA_DECRYPT_OAEP_3072_SHA256]: {
    purpose: CryptoKeyPurpose.ASYMMETRIC_DECRYPT,
    kind: 'asymmetric-decrypt',
    hash: 'sha256',
    keyGen: { type: 'rsa', modulusLength: 3072 },
  },
  [CryptoKeyVersionAlgorithm.RSA_DECRYPT_OAEP_4096_SHA256]: {
    purpose: CryptoKeyPurpose.ASYMMETRIC_DECRYPT,
    kind: 'asymmetric-decrypt',
    hash: 'sha256',
    keyGen: { type: 'rsa', modulusLength: 4096 },
  },
};

/** Error thrown for malformed crypto inputs (maps to INVALID_ARGUMENT). */
export class CryptoEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoEngineError';
  }
}

export function isSupportedAlgorithm(algorithm: string): boolean {
  return algorithm in SPECS;
}

function getAlgorithmSpec(algorithm: string): AlgorithmSpec {
  const spec = SPECS[algorithm];

  if (!spec) {
    throw new CryptoEngineError(`Unsupported algorithm: ${algorithm}`);
  }

  return spec;
}

export function algorithmKind(algorithm: string): AlgorithmKind {
  return getAlgorithmSpec(algorithm).kind;
}

/** Whether an algorithm is valid for a given key purpose. */
export function algorithmMatchesPurpose(algorithm: string, purpose: string): boolean {
  const spec = SPECS[algorithm];

  return spec != null && spec.purpose === purpose;
}

// ── Key material ──

interface SecretMaterial {
  secret: string; // base64
}

interface AsymmetricMaterial {
  privateKeyPem: string;
  publicKeyPem: string;
}

/**
 * Generate fresh key material for a version of the given algorithm. The returned
 * string is opaque JSON suitable for persistence; it is never exposed via the API.
 */
export function generateKeyMaterial(algorithm: string): string {
  const spec = getAlgorithmSpec(algorithm);

  if (spec.keyGen.type === 'symmetric') {
    const material: SecretMaterial = { secret: randomBytes(AES_KEY_LENGTH).toString('base64') };

    return JSON.stringify(material);
  }

  if (spec.keyGen.type === 'rsa') {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: spec.keyGen.modulusLength,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const material: AsymmetricMaterial = { privateKeyPem: privateKey, publicKeyPem: publicKey };

    return JSON.stringify(material);
  }

  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: spec.keyGen.namedCurve,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const material: AsymmetricMaterial = { privateKeyPem: privateKey, publicKeyPem: publicKey };

  return JSON.stringify(material);
}

/** Extract the SPKI PEM public key for an asymmetric version. */
export function getPublicKeyPem(keyMaterial: string): string {
  const material = JSON.parse(keyMaterial) as Partial<AsymmetricMaterial>;

  if (!material.publicKeyPem) {
    throw new CryptoEngineError('Key version has no public key');
  }

  return material.publicKeyPem;
}

function secretBytes(keyMaterial: string): Buffer {
  const material = JSON.parse(keyMaterial) as Partial<SecretMaterial>;

  if (!material.secret) {
    throw new CryptoEngineError('Key version has no symmetric secret');
  }

  return Buffer.from(material.secret, 'base64');
}

function privateKeyPem(keyMaterial: string): string {
  const material = JSON.parse(keyMaterial) as Partial<AsymmetricMaterial>;

  if (!material.privateKeyPem) {
    throw new CryptoEngineError('Key version has no private key');
  }

  return material.privateKeyPem;
}

// ── Symmetric encrypt / decrypt (AES-256-GCM) ──

export function symmetricEncrypt(
  keyMaterial: string,
  versionId: number,
  plaintext: Uint8Array,
  aad?: Uint8Array
): Uint8Array {
  const key = secretBytes(keyMaterial);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  if (aad && aad.length > 0) {
    cipher.setAAD(Buffer.from(aad));
  }

  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = Buffer.alloc(5);
  header.writeUInt8(ENVELOPE_FORMAT_VERSION, 0);
  header.writeUInt32BE(versionId >>> 0, 1);

  return new Uint8Array(Buffer.concat([header, iv, tag, ciphertext]));
}

/** Read the key-version id embedded in a symmetric ciphertext envelope. */
export function readEnvelopeVersionId(envelope: Uint8Array): number {
  if (envelope.length < 5 + IV_LENGTH + GCM_TAG_LENGTH) {
    throw new CryptoEngineError('Ciphertext is too short to be a valid envelope');
  }

  const buf = Buffer.from(envelope);

  if (buf.readUInt8(0) !== ENVELOPE_FORMAT_VERSION) {
    throw new CryptoEngineError('Unrecognized ciphertext envelope format');
  }

  return buf.readUInt32BE(1);
}

export function symmetricDecrypt(
  keyMaterial: string,
  envelope: Uint8Array,
  aad?: Uint8Array
): Uint8Array {
  if (envelope.length < 5 + IV_LENGTH + GCM_TAG_LENGTH) {
    throw new CryptoEngineError('Ciphertext is too short to be a valid envelope');
  }

  const buf = Buffer.from(envelope);

  if (buf.readUInt8(0) !== ENVELOPE_FORMAT_VERSION) {
    throw new CryptoEngineError('Unrecognized ciphertext envelope format');
  }

  const iv = buf.subarray(5, 5 + IV_LENGTH);
  const tag = buf.subarray(5 + IV_LENGTH, 5 + IV_LENGTH + GCM_TAG_LENGTH);
  const ciphertext = buf.subarray(5 + IV_LENGTH + GCM_TAG_LENGTH);

  const key = secretBytes(keyMaterial);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);

  decipher.setAuthTag(tag);

  if (aad && aad.length > 0) {
    decipher.setAAD(Buffer.from(aad));
  }

  try {
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    throw new CryptoEngineError('Decryption failed: ciphertext is corrupt or AAD does not match');
  }
}

// ── Asymmetric signing ──

// ASN.1 DigestInfo prefixes for RSA PKCS#1 v1.5 signatures over a precomputed hash.
const DIGEST_INFO_PREFIX: Record<string, Buffer> = {
  sha256: Buffer.from('3031300d060960864801650304020105000420', 'hex'),
  sha384: Buffer.from('3041300d060960864801650304020205000430', 'hex'),
};

export interface SignInput {
  data?: Uint8Array;
  digest?: Uint8Array;
}

/**
 * Produce a signature for an ASYMMETRIC_SIGN version. Prefers signing `data`
 * (hashing internally); a precomputed `digest` is supported for RSA-PKCS1 keys.
 */
export function asymmetricSign(
  algorithm: string,
  keyMaterial: string,
  input: SignInput
): Uint8Array {
  const spec = getAlgorithmSpec(algorithm);

  if (spec.kind !== 'asymmetric-sign') {
    throw new CryptoEngineError(`Algorithm ${algorithm} cannot sign`);
  }

  const pem = privateKeyPem(keyMaterial);

  if (input.data) {
    const data = Buffer.from(input.data);

    if (spec.rsaSignScheme === 'pss') {
      return new Uint8Array(
        cryptoSign(spec.hash, data, {
          key: pem,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
        })
      );
    }

    if (spec.rsaSignScheme === 'pkcs1') {
      return new Uint8Array(
        cryptoSign(spec.hash, data, { key: pem, padding: constants.RSA_PKCS1_PADDING })
      );
    }

    // EC
    return new Uint8Array(cryptoSign(spec.hash, data, { key: pem, dsaEncoding: 'der' }));
  }

  if (input.digest) {
    if (spec.rsaSignScheme !== 'pkcs1') {
      throw new CryptoEngineError(
        `Precomputed digest signing is only supported for RSA-PKCS1 keys; send 'data' instead for ${algorithm}`
      );
    }

    const prefix = DIGEST_INFO_PREFIX[spec.hash];

    if (!prefix) {
      throw new CryptoEngineError(`No DigestInfo prefix for hash ${spec.hash}`);
    }

    // The ASN.1 prefix hard-encodes the digest length, so a mismatched digest
    // would yield a structurally-invalid signature. Reject it loudly instead.
    const expectedDigestLength = spec.hash === 'sha256' ? 32 : 48;

    if (input.digest.length !== expectedDigestLength) {
      throw new CryptoEngineError(
        `digest length ${input.digest.length} does not match ${spec.hash} (expected ${expectedDigestLength})`
      );
    }

    const digestInfo = Buffer.concat([prefix, Buffer.from(input.digest)]);

    return new Uint8Array(
      privateEncrypt({ key: pem, padding: constants.RSA_PKCS1_PADDING }, digestInfo)
    );
  }

  throw new CryptoEngineError("AsymmetricSign requires either 'data' or 'digest'");
}

// ── Asymmetric decryption (RSA-OAEP) ──

export function asymmetricDecrypt(
  algorithm: string,
  keyMaterial: string,
  ciphertext: Uint8Array
): Uint8Array {
  const spec = getAlgorithmSpec(algorithm);

  if (spec.kind !== 'asymmetric-decrypt') {
    throw new CryptoEngineError(`Algorithm ${algorithm} cannot decrypt`);
  }

  const pem = privateKeyPem(keyMaterial);

  try {
    return new Uint8Array(
      privateDecrypt(
        { key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: spec.hash },
        Buffer.from(ciphertext)
      )
    );
  } catch {
    throw new CryptoEngineError('Decryption failed: ciphertext is corrupt or key does not match');
  }
}

// ── MAC (HMAC) ──

export function macSign(algorithm: string, keyMaterial: string, data: Uint8Array): Uint8Array {
  const spec = getAlgorithmSpec(algorithm);

  if (spec.kind !== 'mac') {
    throw new CryptoEngineError(`Algorithm ${algorithm} cannot MAC`);
  }

  return new Uint8Array(
    createHmac(spec.hash, secretBytes(keyMaterial)).update(Buffer.from(data)).digest()
  );
}

export function macVerify(
  algorithm: string,
  keyMaterial: string,
  data: Uint8Array,
  mac: Uint8Array
): boolean {
  const expected = Buffer.from(macSign(algorithm, keyMaterial, data));
  const provided = Buffer.from(mac);

  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}

// ── Random bytes ──

export function generateRandomBytes(length: number): Uint8Array {
  if (length < 1 || length > 1024) {
    throw new CryptoEngineError('lengthBytes must be between 1 and 1024');
  }

  return new Uint8Array(randomBytes(length));
}
