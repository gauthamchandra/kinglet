/**
 * Cloud KMS HTTP route handlers.
 *
 * Route levels mirror the real KMS v1 API: encrypt/decrypt are key-level,
 * asymmetricSign/Decrypt + macSign/Verify + getPublicKey are version-level, and
 * generateRandomBytes is location-level.
 */

import type {
  RouteContext,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import { crc32cString } from '@/shared/utils/crc32c.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import type { SignInput } from './crypto-engine.ts';
import { CryptoEngineError, generateRandomBytes as engineRandomBytes } from './crypto-engine.ts';
import type { CryptoService } from './crypto-service.ts';
import type { KeyManagementService } from './key-management-service.ts';
import { KmsError } from './key-management-service.ts';
import {
  buildCryptoKeyName,
  buildCryptoKeyVersionName,
  buildKeyRingName,
  ProtectionLevel,
} from './types.ts';

function decodeBase64(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }

  return new Uint8Array(Buffer.from(value, 'base64'));
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Normalize a provided crc32c value (Int64Value | string | number) to a decimal string. */
function readProvidedCrc(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value === 'object' && 'value' in value) {
    return String((value as { value: unknown }).value);
  }

  return String(value);
}

export class KmsHandlers {
  private responseUtils: ResponseUtils;

  constructor(
    private management: KeyManagementService,
    private crypto: CryptoService,
    private logger: Logger
  ) {
    this.responseUtils = new ResponseUtils(new StandardResponseFormatter(logger));
  }

  getRoutes(): RouteDefinition[] {
    const base = '/v1/projects/:project/locations/:location';
    const keyPath = `${base}/keyRings/:keyRing/cryptoKeys/:cryptoKey`;
    const versionPath = `${keyPath}/cryptoKeyVersions/:version`;

    return [
      // Locations
      {
        id: 'kms.locations.generateRandomBytes',
        method: 'POST',
        path: `${base}:generateRandomBytes`,
        handler: (r, c) => this.generateRandomBytes(r, c),
      },

      // Key rings
      {
        id: 'kms.keyRings.create',
        method: 'POST',
        path: `${base}/keyRings`,
        handler: (r, c) => this.createKeyRing(r, c),
      },
      {
        id: 'kms.keyRings.list',
        method: 'GET',
        path: `${base}/keyRings`,
        handler: (r, c) => this.listKeyRings(r, c),
      },
      {
        id: 'kms.keyRings.get',
        method: 'GET',
        path: `${base}/keyRings/:keyRing`,
        handler: (r, c) => this.getKeyRing(r, c),
      },

      // Crypto keys
      {
        id: 'kms.cryptoKeys.create',
        method: 'POST',
        path: `${base}/keyRings/:keyRing/cryptoKeys`,
        handler: (r, c) => this.createCryptoKey(r, c),
      },
      {
        id: 'kms.cryptoKeys.list',
        method: 'GET',
        path: `${base}/keyRings/:keyRing/cryptoKeys`,
        handler: (r, c) => this.listCryptoKeys(r, c),
      },
      {
        id: 'kms.cryptoKeys.updatePrimaryVersion',
        method: 'POST',
        path: `${keyPath}:updatePrimaryVersion`,
        handler: (r, c) => this.updatePrimaryVersion(r, c),
      },
      {
        id: 'kms.cryptoKeys.encrypt',
        method: 'POST',
        path: `${keyPath}:encrypt`,
        handler: (r, c) => this.encrypt(r, c),
      },
      {
        id: 'kms.cryptoKeys.decrypt',
        method: 'POST',
        path: `${keyPath}:decrypt`,
        handler: (r, c) => this.decrypt(r, c),
      },
      {
        id: 'kms.cryptoKeys.get',
        method: 'GET',
        path: keyPath,
        handler: (r, c) => this.getCryptoKey(r, c),
      },
      {
        id: 'kms.cryptoKeys.patch',
        method: 'PATCH',
        path: keyPath,
        handler: (r, c) => this.updateCryptoKey(r, c),
      },

      // Crypto key versions
      {
        id: 'kms.cryptoKeyVersions.create',
        method: 'POST',
        path: `${keyPath}/cryptoKeyVersions`,
        handler: (r, c) => this.createVersion(r, c),
      },
      {
        id: 'kms.cryptoKeyVersions.list',
        method: 'GET',
        path: `${keyPath}/cryptoKeyVersions`,
        handler: (r, c) => this.listVersions(r, c),
      },
      {
        id: 'kms.cryptoKeyVersions.getPublicKey',
        method: 'GET',
        path: `${versionPath}/publicKey`,
        handler: (r, c) => this.getPublicKey(r, c),
      },
      {
        id: 'kms.cryptoKeyVersions.destroy',
        method: 'POST',
        path: `${versionPath}:destroy`,
        handler: (r, c) => this.destroyVersion(r, c),
      },
      {
        id: 'kms.cryptoKeyVersions.restore',
        method: 'POST',
        path: `${versionPath}:restore`,
        handler: (r, c) => this.restoreVersion(r, c),
      },
      {
        id: 'kms.cryptoKeyVersions.asymmetricSign',
        method: 'POST',
        path: `${versionPath}:asymmetricSign`,
        handler: (r, c) => this.asymmetricSign(r, c),
      },
      {
        id: 'kms.cryptoKeyVersions.asymmetricDecrypt',
        method: 'POST',
        path: `${versionPath}:asymmetricDecrypt`,
        handler: (r, c) => this.asymmetricDecrypt(r, c),
      },
      {
        id: 'kms.cryptoKeyVersions.macSign',
        method: 'POST',
        path: `${versionPath}:macSign`,
        handler: (r, c) => this.macSign(r, c),
      },
      {
        id: 'kms.cryptoKeyVersions.macVerify',
        method: 'POST',
        path: `${versionPath}:macVerify`,
        handler: (r, c) => this.macVerify(r, c),
      },
      {
        id: 'kms.cryptoKeyVersions.get',
        method: 'GET',
        path: versionPath,
        handler: (r, c) => this.getVersion(r, c),
      },
      {
        id: 'kms.cryptoKeyVersions.patch',
        method: 'PATCH',
        path: versionPath,
        handler: (r, c) => this.updateVersion(r, c),
      },
    ];
  }

  // ── Locations ──

  private generateRandomBytes(req: RouteRequest, _ctx: RouteContext): RouteResponse {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const lengthBytes =
        typeof body.lengthBytes === 'number' ? body.lengthBytes : Number(body.lengthBytes);

      if (!Number.isInteger(lengthBytes)) {
        throw new KmsError('INVALID_ARGUMENT', 'lengthBytes must be an integer');
      }

      const bytes = engineRandomBytes(lengthBytes);

      return this.responseUtils.success({
        data: encodeBase64(bytes),
        dataCrc32c: crc32cString(bytes),
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  // ── Key rings ──

  private async createKeyRing(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, location } = req.params;
      const keyRingId = (req.query.keyRingId as string) ?? '';
      const result = await this.management.createKeyRing(project ?? '', location ?? '', keyRingId);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async getKeyRing(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, location, keyRing } = req.params;
      const name = buildKeyRingName(project ?? '', location ?? '', keyRing ?? '');

      return this.responseUtils.success(await this.management.getKeyRing(name));
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async listKeyRings(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, location } = req.params;
      const result = await this.management.listKeyRings(
        project ?? '',
        location ?? '',
        this.pageSize(req),
        (req.query.pageToken as string) || undefined
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  // ── Crypto keys ──

  private async createCryptoKey(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, location, keyRing } = req.params;
      const keyRingName = buildKeyRingName(project ?? '', location ?? '', keyRing ?? '');
      const cryptoKeyId = (req.query.cryptoKeyId as string) ?? '';
      const skip = req.query.skipInitialVersionCreation === 'true';

      const result = await this.management.createCryptoKey(
        keyRingName,
        cryptoKeyId,
        req.body,
        skip
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async getCryptoKey(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      return this.responseUtils.success(
        await this.management.getCryptoKey(this.cryptoKeyName(req))
      );
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async listCryptoKeys(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, location, keyRing } = req.params;
      const keyRingName = buildKeyRingName(project ?? '', location ?? '', keyRing ?? '');
      const result = await this.management.listCryptoKeys(
        keyRingName,
        this.pageSize(req),
        (req.query.pageToken as string) || undefined
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async updateCryptoKey(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const updateMask = (req.query.updateMask as string) || undefined;
      const result = await this.management.updateCryptoKey(
        this.cryptoKeyName(req),
        req.body,
        updateMask
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async updatePrimaryVersion(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const versionId = (body.cryptoKeyVersionId as string) ?? '';
      const result = await this.management.updatePrimaryVersion(this.cryptoKeyName(req), versionId);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  // ── Crypto key versions ──

  private async createVersion(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      return this.responseUtils.success(
        await this.management.createCryptoKeyVersion(this.cryptoKeyName(req))
      );
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async getVersion(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      return this.responseUtils.success(
        await this.management.getCryptoKeyVersion(this.versionName(req))
      );
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async listVersions(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.management.listCryptoKeyVersions(
        this.cryptoKeyName(req),
        this.pageSize(req),
        (req.query.pageToken as string) || undefined
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async updateVersion(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const updateMask = (req.query.updateMask as string) || undefined;
      const result = await this.management.updateCryptoKeyVersion(
        this.versionName(req),
        req.body,
        updateMask
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async destroyVersion(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      return this.responseUtils.success(
        await this.management.destroyCryptoKeyVersion(this.versionName(req))
      );
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async restoreVersion(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      return this.responseUtils.success(
        await this.management.restoreCryptoKeyVersion(this.versionName(req))
      );
    } catch (err) {
      return this.handleError(err);
    }
  }

  // ── Crypto operations ──

  private async encrypt(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const plaintext = decodeBase64(body.plaintext);

      if (!plaintext) {
        throw new KmsError('INVALID_ARGUMENT', 'plaintext is required');
      }

      const aad = decodeBase64(body.additionalAuthenticatedData);
      const verifiedPlaintext = this.checkCrc(plaintext, body.plaintextCrc32c);
      const verifiedAad = aad
        ? this.checkCrc(aad, body.additionalAuthenticatedDataCrc32c)
        : undefined;

      const result = await this.crypto.encrypt(this.cryptoKeyName(req), plaintext, aad);

      return this.responseUtils.success({
        // EncryptResponse.name is the CryptoKeyVersion that encrypted, not the CryptoKey
        // the request addressed — clients read it to confirm which version was primary.
        name: result.keyVersionName,
        ciphertext: encodeBase64(result.ciphertext),
        ciphertextCrc32c: crc32cString(result.ciphertext),
        protectionLevel: ProtectionLevel.SOFTWARE,
        ...(verifiedPlaintext != null && { verifiedPlaintextCrc32c: verifiedPlaintext }),
        ...(verifiedAad != null && { verifiedAdditionalAuthenticatedDataCrc32c: verifiedAad }),
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async decrypt(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ciphertext = decodeBase64(body.ciphertext);

      if (!ciphertext) {
        throw new KmsError('INVALID_ARGUMENT', 'ciphertext is required');
      }

      const aad = decodeBase64(body.additionalAuthenticatedData);

      this.checkCrc(ciphertext, body.ciphertextCrc32c);

      const result = await this.crypto.decrypt(this.cryptoKeyName(req), ciphertext, aad);

      return this.responseUtils.success({
        plaintext: encodeBase64(result.plaintext),
        plaintextCrc32c: crc32cString(result.plaintext),
        usedPrimary: result.usedPrimary,
        protectionLevel: ProtectionLevel.SOFTWARE,
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async asymmetricSign(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const data = decodeBase64(body.data);
      const digest = this.readDigest(body.digest);

      const verifiedData = data ? this.checkCrc(data, body.dataCrc32c) : undefined;
      const verifiedDigest = digest ? this.checkCrc(digest, body.digestCrc32c) : undefined;

      const input: SignInput = {};

      if (data) {
        input.data = data;
      }

      if (digest) {
        input.digest = digest;
      }

      const name = this.versionName(req);
      const result = await this.crypto.asymmetricSign(name, input);

      return this.responseUtils.success({
        name,
        signature: encodeBase64(result.signature),
        signatureCrc32c: crc32cString(result.signature),
        protectionLevel: ProtectionLevel.SOFTWARE,
        ...(verifiedData != null && { verifiedDataCrc32c: verifiedData }),
        ...(verifiedDigest != null && { verifiedDigestCrc32c: verifiedDigest }),
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async asymmetricDecrypt(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ciphertext = decodeBase64(body.ciphertext);

      if (!ciphertext) {
        throw new KmsError('INVALID_ARGUMENT', 'ciphertext is required');
      }

      const verifiedCiphertext = this.checkCrc(ciphertext, body.ciphertextCrc32c);

      const plaintext = await this.crypto.asymmetricDecrypt(this.versionName(req), ciphertext);

      return this.responseUtils.success({
        plaintext: encodeBase64(plaintext),
        plaintextCrc32c: crc32cString(plaintext),
        verifiedCiphertextCrc32c: verifiedCiphertext,
        protectionLevel: ProtectionLevel.SOFTWARE,
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async macSign(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const data = decodeBase64(body.data);

      if (!data) {
        throw new KmsError('INVALID_ARGUMENT', 'data is required');
      }

      const verifiedData = this.checkCrc(data, body.dataCrc32c);

      const name = this.versionName(req);
      const result = await this.crypto.macSign(name, data);

      return this.responseUtils.success({
        name,
        mac: encodeBase64(result.mac),
        macCrc32c: crc32cString(result.mac),
        verifiedDataCrc32c: verifiedData,
        protectionLevel: ProtectionLevel.SOFTWARE,
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async macVerify(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const data = decodeBase64(body.data);
      const mac = decodeBase64(body.mac);

      if (!data || !mac) {
        throw new KmsError('INVALID_ARGUMENT', 'data and mac are required');
      }

      const verifiedData = this.checkCrc(data, body.dataCrc32c);
      const verifiedMac = this.checkCrc(mac, body.macCrc32c);

      const name = this.versionName(req);
      const result = await this.crypto.macVerify(name, data, mac);

      return this.responseUtils.success({
        name,
        success: result.success,
        verifiedDataCrc32c: verifiedData,
        verifiedMacCrc32c: verifiedMac,
        protectionLevel: ProtectionLevel.SOFTWARE,
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async getPublicKey(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.crypto.getPublicKey(this.versionName(req));

      return this.responseUtils.success({
        pem: result.pem,
        algorithm: result.algorithm,
        name: result.name,
        protectionLevel: result.protectionLevel,
        pemCrc32c: crc32cString(new TextEncoder().encode(result.pem)),
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  // ── Helpers ──

  private cryptoKeyName(req: RouteRequest): string {
    const { project, location, keyRing, cryptoKey } = req.params;

    return buildCryptoKeyName(project ?? '', location ?? '', keyRing ?? '', cryptoKey ?? '');
  }

  private versionName(req: RouteRequest): string {
    return buildCryptoKeyVersionName(this.cryptoKeyName(req), req.params.version ?? '');
  }

  private pageSize(req: RouteRequest): number | undefined {
    const raw = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined;

    return raw != null && !Number.isNaN(raw) && raw > 0 ? raw : undefined;
  }

  private readDigest(digest: unknown): Uint8Array | undefined {
    if (typeof digest !== 'object' || digest === null) {
      return undefined;
    }

    const d = digest as Record<string, unknown>;

    return decodeBase64(d.sha256) ?? decodeBase64(d.sha384) ?? decodeBase64(d.sha512);
  }

  /**
   * Verify a caller-supplied crc32c against the actual bytes. Returns true when a
   * checksum was supplied and matched, false when none was supplied, and throws
   * INVALID_ARGUMENT on mismatch (matching real KMS data-integrity behavior).
   */
  private checkCrc(bytes: Uint8Array, provided: unknown): boolean {
    const providedStr = readProvidedCrc(provided);

    if (providedStr == null) {
      return false;
    }

    if (providedStr !== crc32cString(bytes)) {
      throw new KmsError('INVALID_ARGUMENT', 'Provided crc32c checksum does not match the data');
    }

    return true;
  }

  private handleError(err: unknown): RouteResponse {
    if (err instanceof KmsError) {
      switch (err.code) {
        case 'NOT_FOUND':
          return this.responseUtils.notFound('Resource', err.message);
        case 'ALREADY_EXISTS':
          return this.responseUtils.alreadyExists('Resource', err.message);
        case 'INVALID_ARGUMENT':
          return this.responseUtils.badRequest(err.message);
        case 'FAILED_PRECONDITION':
          return this.responseUtils.failedPrecondition(err.message);
      }
    }

    if (err instanceof CryptoEngineError) {
      return this.responseUtils.badRequest(err.message);
    }

    this.logger.error('Unexpected KMS handler error', err);

    return this.responseUtils.internalError(err instanceof Error ? err.message : 'Unknown error');
  }
}
