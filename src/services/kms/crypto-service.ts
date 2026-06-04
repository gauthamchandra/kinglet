/**
 * KMS data plane — cryptographic operations that act on stored key versions.
 *
 * Key-level operations (encrypt/decrypt) route through the crypto key's primary
 * version; version-level operations (asymmetricSign/Decrypt, macSign/Verify,
 * getPublicKey) act on a specific version named in the request path.
 */

import {
  algorithmKind,
  asymmetricDecrypt,
  asymmetricSign,
  CryptoEngineError,
  getPublicKeyPem,
  macSign,
  macVerify,
  readEnvelopeVersionId,
  type SignInput,
  symmetricDecrypt,
  symmetricEncrypt,
} from './crypto-engine.ts';
import { KmsError } from './key-management-service.ts';
import type { CryptoKeyRepository, CryptoKeyVersionRepository } from './repository.ts';
import type { CryptoKeyRecord, CryptoKeyVersionRecord } from './types.ts';
import { buildCryptoKeyVersionName, CryptoKeyPurpose, CryptoKeyVersionState } from './types.ts';

export interface EncryptResult {
  ciphertext: Uint8Array;
  keyVersionName: string;
}

export interface DecryptResult {
  plaintext: Uint8Array;
  usedPrimary: boolean;
}

export interface SignResult {
  signature: Uint8Array;
  name: string;
}

export interface MacSignResult {
  mac: Uint8Array;
  name: string;
}

export interface MacVerifyResult {
  success: boolean;
  name: string;
}

export interface PublicKeyResult {
  pem: string;
  algorithm: string;
  name: string;
  protectionLevel: string;
}

export class CryptoService {
  constructor(
    private cryptoKeyRepo: CryptoKeyRepository,
    private versionRepo: CryptoKeyVersionRepository
  ) {}

  async encrypt(
    cryptoKeyName: string,
    plaintext: Uint8Array,
    aad?: Uint8Array
  ): Promise<EncryptResult> {
    const key = await this.requireKey(cryptoKeyName);

    if (key.purpose !== CryptoKeyPurpose.ENCRYPT_DECRYPT) {
      throw new KmsError(
        'INVALID_ARGUMENT',
        `CryptoKey ${cryptoKeyName} (purpose ${key.purpose}) cannot encrypt`
      );
    }

    if (!key.primaryVersion) {
      throw new KmsError(
        'FAILED_PRECONDITION',
        `CryptoKey ${cryptoKeyName} has no primary version`
      );
    }

    const primary = await this.versionRepo.getVersionByName(
      buildCryptoKeyVersionName(key.name, key.primaryVersion)
    );

    if (!primary || primary.state !== CryptoKeyVersionState.ENABLED) {
      throw new KmsError(
        'FAILED_PRECONDITION',
        `Primary version of ${cryptoKeyName} is not ENABLED`
      );
    }

    const ciphertext = this.wrapEngine(() =>
      symmetricEncrypt(
        primary.keyMaterial,
        Number.parseInt(key.primaryVersion ?? '0', 10),
        plaintext,
        aad
      )
    );

    return { ciphertext, keyVersionName: primary.name };
  }

  async decrypt(
    cryptoKeyName: string,
    ciphertext: Uint8Array,
    aad?: Uint8Array
  ): Promise<DecryptResult> {
    const key = await this.requireKey(cryptoKeyName);

    if (key.purpose !== CryptoKeyPurpose.ENCRYPT_DECRYPT) {
      throw new KmsError(
        'INVALID_ARGUMENT',
        `CryptoKey ${cryptoKeyName} (purpose ${key.purpose}) cannot decrypt`
      );
    }

    const versionId = this.wrapEngine(() => readEnvelopeVersionId(ciphertext));

    const version = await this.versionRepo.getVersionByName(
      buildCryptoKeyVersionName(cryptoKeyName, String(versionId))
    );

    if (!version) {
      throw new KmsError(
        'INVALID_ARGUMENT',
        'Ciphertext references a key version that does not exist'
      );
    }

    if (version.state !== CryptoKeyVersionState.ENABLED) {
      throw new KmsError('FAILED_PRECONDITION', `Key version ${version.name} is not ENABLED`);
    }

    const plaintext = this.wrapEngine(() => symmetricDecrypt(version.keyMaterial, ciphertext, aad));

    return { plaintext, usedPrimary: String(versionId) === key.primaryVersion };
  }

  async asymmetricSign(versionName: string, input: SignInput): Promise<SignResult> {
    const version = await this.requireEnabledVersion(versionName);

    if (algorithmKind(version.algorithm) !== 'asymmetric-sign') {
      throw new KmsError('INVALID_ARGUMENT', `Key version ${versionName} cannot sign`);
    }

    const signature = this.wrapEngine(() =>
      asymmetricSign(version.algorithm, version.keyMaterial, input)
    );

    return { signature, name: version.name };
  }

  async asymmetricDecrypt(versionName: string, ciphertext: Uint8Array): Promise<Uint8Array> {
    const version = await this.requireEnabledVersion(versionName);

    if (algorithmKind(version.algorithm) !== 'asymmetric-decrypt') {
      throw new KmsError('INVALID_ARGUMENT', `Key version ${versionName} cannot decrypt`);
    }

    return this.wrapEngine(() =>
      asymmetricDecrypt(version.algorithm, version.keyMaterial, ciphertext)
    );
  }

  async macSign(versionName: string, data: Uint8Array): Promise<MacSignResult> {
    const version = await this.requireEnabledVersion(versionName);

    if (algorithmKind(version.algorithm) !== 'mac') {
      throw new KmsError('INVALID_ARGUMENT', `Key version ${versionName} cannot MAC`);
    }

    const mac = this.wrapEngine(() => macSign(version.algorithm, version.keyMaterial, data));

    return { mac, name: version.name };
  }

  async macVerify(
    versionName: string,
    data: Uint8Array,
    mac: Uint8Array
  ): Promise<MacVerifyResult> {
    const version = await this.requireEnabledVersion(versionName);

    if (algorithmKind(version.algorithm) !== 'mac') {
      throw new KmsError('INVALID_ARGUMENT', `Key version ${versionName} cannot MAC`);
    }

    const success = this.wrapEngine(() =>
      macVerify(version.algorithm, version.keyMaterial, data, mac)
    );

    return { success, name: version.name };
  }

  async getPublicKey(versionName: string): Promise<PublicKeyResult> {
    const version = await this.requireVersion(versionName);

    if (version.state !== CryptoKeyVersionState.ENABLED) {
      throw new KmsError('FAILED_PRECONDITION', `Key version ${versionName} is not ENABLED`);
    }

    const kind = algorithmKind(version.algorithm);

    if (kind !== 'asymmetric-sign' && kind !== 'asymmetric-decrypt') {
      throw new KmsError(
        'FAILED_PRECONDITION',
        `Key version ${versionName} has no public key (not an asymmetric key)`
      );
    }

    const pem = this.wrapEngine(() => getPublicKeyPem(version.keyMaterial));

    return {
      pem,
      algorithm: version.algorithm,
      name: version.name,
      protectionLevel: version.protectionLevel,
    };
  }

  // ── Internal helpers ──

  private async requireKey(name: string): Promise<CryptoKeyRecord> {
    const record = await this.cryptoKeyRepo.getCryptoKeyByName(name);

    if (!record) {
      throw new KmsError('NOT_FOUND', `CryptoKey ${name} not found`);
    }

    return record;
  }

  private async requireVersion(name: string): Promise<CryptoKeyVersionRecord> {
    const record = await this.versionRepo.getVersionByName(name);

    if (!record) {
      throw new KmsError('NOT_FOUND', `CryptoKeyVersion ${name} not found`);
    }

    return record;
  }

  private async requireEnabledVersion(name: string): Promise<CryptoKeyVersionRecord> {
    const record = await this.requireVersion(name);

    if (record.state !== CryptoKeyVersionState.ENABLED) {
      throw new KmsError('FAILED_PRECONDITION', `Key version ${name} is not ENABLED`);
    }

    return record;
  }

  private wrapEngine<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof CryptoEngineError) {
        throw new KmsError('INVALID_ARGUMENT', err.message);
      }

      throw err;
    }
  }
}
