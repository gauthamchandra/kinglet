import { describe, expect, test } from 'bun:test';
import {
  constants,
  createHash,
  createPublicKey,
  verify as cryptoVerify,
  publicEncrypt,
} from 'node:crypto';
import {
  algorithmMatchesPurpose,
  asymmetricDecrypt,
  asymmetricSign,
  CryptoEngineError,
  generateKeyMaterial,
  generateRandomBytes,
  getPublicKeyPem,
  isSupportedAlgorithm,
  macSign,
  macVerify,
  readEnvelopeVersionId,
  symmetricDecrypt,
  symmetricEncrypt,
} from './crypto-engine.ts';
import { CryptoKeyPurpose, CryptoKeyVersionAlgorithm } from './types.ts';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('symmetric encrypt/decrypt (AES-256-GCM)', () => {
  const material = generateKeyMaterial(CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION);

  test('round-trips plaintext', () => {
    const plaintext = bytes('the quick brown fox');
    const envelope = symmetricEncrypt(material, 1, plaintext);

    expect(text(symmetricDecrypt(material, envelope))).toBe('the quick brown fox');
  });

  test('produces a different ciphertext each time (random IV)', () => {
    const pt = bytes('same input');
    const a = Buffer.from(symmetricEncrypt(material, 1, pt)).toString('base64');
    const b = Buffer.from(symmetricEncrypt(material, 1, pt)).toString('base64');

    expect(a).not.toBe(b);
  });

  test('embeds and reads back the key version id', () => {
    const envelope = symmetricEncrypt(material, 42, bytes('x'));

    expect(readEnvelopeVersionId(envelope)).toBe(42);
  });

  test('round-trips with additional authenticated data', () => {
    const aad = bytes('context-v1');
    const envelope = symmetricEncrypt(material, 1, bytes('secret'), aad);

    expect(text(symmetricDecrypt(material, envelope, aad))).toBe('secret');
  });

  test('rejects decryption when AAD does not match', () => {
    const envelope = symmetricEncrypt(material, 1, bytes('secret'), bytes('aad-a'));

    expect(() => symmetricDecrypt(material, envelope, bytes('aad-b'))).toThrow(CryptoEngineError);
  });

  test('rejects a tampered ciphertext (GCM auth tag)', () => {
    const envelope = symmetricEncrypt(material, 1, bytes('secret'));
    const last = envelope.length - 1;

    envelope[last] = (envelope[last] ?? 0) ^ 0xff;

    expect(() => symmetricDecrypt(material, envelope)).toThrow(CryptoEngineError);
  });

  test('rejects decryption with the wrong key', () => {
    const other = generateKeyMaterial(CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION);
    const envelope = symmetricEncrypt(material, 1, bytes('secret'));

    expect(() => symmetricDecrypt(other, envelope)).toThrow(CryptoEngineError);
  });

  test('rejects a malformed envelope', () => {
    expect(() => readEnvelopeVersionId(new Uint8Array([1, 2, 3]))).toThrow(CryptoEngineError);
  });
});

describe('asymmetric signing', () => {
  const cases = [
    { algo: CryptoKeyVersionAlgorithm.EC_SIGN_P256_SHA256, hash: 'sha256', scheme: 'ec' },
    { algo: CryptoKeyVersionAlgorithm.EC_SIGN_P384_SHA384, hash: 'sha384', scheme: 'ec' },
    { algo: CryptoKeyVersionAlgorithm.RSA_SIGN_PKCS1_2048_SHA256, hash: 'sha256', scheme: 'pkcs1' },
    { algo: CryptoKeyVersionAlgorithm.RSA_SIGN_PSS_2048_SHA256, hash: 'sha256', scheme: 'pss' },
  ] as const;

  for (const { algo, hash, scheme } of cases) {
    test(`${algo}: signature over data verifies with the public key`, () => {
      const material = generateKeyMaterial(algo);
      const publicKey = createPublicKey(getPublicKeyPem(material));
      const data = bytes('message to sign');

      const signature = asymmetricSign(algo, material, { data });

      const verifyOpts =
        scheme === 'pss'
          ? {
              key: publicKey,
              padding: constants.RSA_PKCS1_PSS_PADDING,
              saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
            }
          : scheme === 'pkcs1'
            ? { key: publicKey, padding: constants.RSA_PKCS1_PADDING }
            : { key: publicKey, dsaEncoding: 'der' as const };

      expect(cryptoVerify(hash, Buffer.from(data), verifyOpts, Buffer.from(signature))).toBe(true);
    });
  }

  test('RSA-PKCS1 supports signing a precomputed digest', () => {
    const algo = CryptoKeyVersionAlgorithm.RSA_SIGN_PKCS1_2048_SHA256;
    const material = generateKeyMaterial(algo);
    const publicKey = createPublicKey(getPublicKeyPem(material));
    const data = bytes('digest path message');
    const digest = new Uint8Array(createHash('sha256').update(Buffer.from(data)).digest());

    const signature = asymmetricSign(algo, material, { digest });

    // A digest-based signature must verify identically to a data-based one.
    expect(
      cryptoVerify(
        'sha256',
        Buffer.from(data),
        { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(signature)
      )
    ).toBe(true);
  });

  test('EC rejects a precomputed digest (data required)', () => {
    const algo = CryptoKeyVersionAlgorithm.EC_SIGN_P256_SHA256;
    const material = generateKeyMaterial(algo);
    const digest = new Uint8Array(createHash('sha256').update('x').digest());

    expect(() => asymmetricSign(algo, material, { digest })).toThrow(CryptoEngineError);
  });

  test('RSA-PSS rejects a precomputed digest (only PKCS1 supports digest)', () => {
    const algo = CryptoKeyVersionAlgorithm.RSA_SIGN_PSS_2048_SHA256;
    const material = generateKeyMaterial(algo);
    const digest = new Uint8Array(createHash('sha256').update('x').digest());

    expect(() => asymmetricSign(algo, material, { digest })).toThrow(CryptoEngineError);
  });

  test('RSA-PKCS1 rejects a digest of the wrong length (prevents invalid signatures)', () => {
    const algo = CryptoKeyVersionAlgorithm.RSA_SIGN_PKCS1_2048_SHA256;
    const material = generateKeyMaterial(algo);
    const shortDigest = new Uint8Array(20); // SHA-1 length, not the expected 32

    expect(() => asymmetricSign(algo, material, { digest: shortDigest })).toThrow(
      CryptoEngineError
    );
  });

  test('rejects signing with no data or digest', () => {
    const algo = CryptoKeyVersionAlgorithm.EC_SIGN_P256_SHA256;
    const material = generateKeyMaterial(algo);

    expect(() => asymmetricSign(algo, material, {})).toThrow(CryptoEngineError);
  });
});

describe('asymmetric decryption (RSA-OAEP)', () => {
  test('decrypts data encrypted with the exported public key', () => {
    const algo = CryptoKeyVersionAlgorithm.RSA_DECRYPT_OAEP_2048_SHA256;
    const material = generateKeyMaterial(algo);
    const publicKey = createPublicKey(getPublicKeyPem(material));

    const ciphertext = publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(bytes('top secret'))
    );

    expect(text(asymmetricDecrypt(algo, material, new Uint8Array(ciphertext)))).toBe('top secret');
  });

  test('rejects corrupt ciphertext', () => {
    const algo = CryptoKeyVersionAlgorithm.RSA_DECRYPT_OAEP_2048_SHA256;
    const material = generateKeyMaterial(algo);

    expect(() => asymmetricDecrypt(algo, material, bytes('not a real ciphertext'))).toThrow(
      CryptoEngineError
    );
  });
});

describe('MAC (HMAC-SHA256)', () => {
  const material = generateKeyMaterial(CryptoKeyVersionAlgorithm.HMAC_SHA256);
  const algo = CryptoKeyVersionAlgorithm.HMAC_SHA256;

  test('sign then verify succeeds', () => {
    const data = bytes('authenticate me');
    const mac = macSign(algo, material, data);

    expect(macVerify(algo, material, data, mac)).toBe(true);
  });

  test('verify fails for a tampered message', () => {
    const mac = macSign(algo, material, bytes('original'));

    expect(macVerify(algo, material, bytes('tampered'), mac)).toBe(false);
  });

  test('verify fails for a mac from a different key', () => {
    const other = generateKeyMaterial(CryptoKeyVersionAlgorithm.HMAC_SHA256);
    const data = bytes('data');
    const mac = macSign(algo, other, data);

    expect(macVerify(algo, material, data, mac)).toBe(false);
  });
});

describe('generateRandomBytes', () => {
  test('returns the requested number of bytes', () => {
    expect(generateRandomBytes(16).length).toBe(16);
    expect(generateRandomBytes(256).length).toBe(256);
  });

  test('rejects out-of-range lengths', () => {
    expect(() => generateRandomBytes(0)).toThrow(CryptoEngineError);
    expect(() => generateRandomBytes(2048)).toThrow(CryptoEngineError);
  });
});

describe('algorithm metadata', () => {
  test('recognizes supported algorithms and rejects unknown ones', () => {
    expect(isSupportedAlgorithm(CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION)).toBe(true);
    expect(isSupportedAlgorithm('NONSENSE_ALGO')).toBe(false);
  });

  test('matches algorithms to purposes', () => {
    expect(
      algorithmMatchesPurpose(
        CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION,
        CryptoKeyPurpose.ENCRYPT_DECRYPT
      )
    ).toBe(true);
    expect(
      algorithmMatchesPurpose(
        CryptoKeyVersionAlgorithm.EC_SIGN_P256_SHA256,
        CryptoKeyPurpose.ENCRYPT_DECRYPT
      )
    ).toBe(false);
  });
});
