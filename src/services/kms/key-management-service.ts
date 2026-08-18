/**
 * KMS management plane — key ring / crypto key / crypto key version lifecycle.
 *
 * Crypto key creation auto-generates an initial ENABLED version (unless
 * skipInitialVersionCreation). For ENCRYPT_DECRYPT keys the first version also
 * becomes the primary; subsequent versions (rotation) require an explicit
 * updatePrimaryVersion call, mirroring real Cloud KMS.
 */

import type { BaseRecord } from '@/core/storage/types.ts';
import {
  algorithmMatchesPurpose,
  generateKeyMaterial,
  isSupportedAlgorithm,
} from './crypto-engine.ts';
import type {
  CryptoKeyRepository,
  CryptoKeyVersionRepository,
  KeyRingRepository,
} from './repository.ts';
import type {
  CryptoKeyRecord,
  CryptoKeyResponse,
  CryptoKeyVersionRecord,
  CryptoKeyVersionResponse,
  KeyRingResponse,
} from './types.ts';
import {
  buildCryptoKeyName,
  buildCryptoKeyVersionName,
  buildKeyRingName,
  CreateCryptoKeyRequestSchema,
  type CryptoKeyPurposeValue,
  CryptoKeyVersionState,
  cryptoKeyRecordToResponse,
  cryptoKeyVersionRecordToResponse,
  DEFAULT_ALGORITHM_FOR_PURPOSE,
  DEFAULT_PROTECTION_LEVEL,
  keyRingRecordToResponse,
  normalizeAlgorithm,
  normalizeProtectionLevel,
  normalizePurpose,
  normalizeState,
  ProtectionLevel,
  parseKeyRingName,
  purposeUsesPrimaryVersion,
  UpdateCryptoKeyRequestSchema,
  UpdateCryptoKeyVersionRequestSchema,
} from './types.ts';

export type KmsErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_ARGUMENT'
  | 'FAILED_PRECONDITION';

export class KmsError extends Error {
  readonly code: KmsErrorCode;

  constructor(code: KmsErrorCode, message: string) {
    super(message);
    this.name = 'KmsError';
    this.code = code;
  }
}

const VALID_PURPOSES: CryptoKeyPurposeValue[] = [
  'ENCRYPT_DECRYPT',
  'ASYMMETRIC_SIGN',
  'ASYMMETRIC_DECRYPT',
  'MAC',
];

// Real KMS defaults to 30 days; the emulator only stamps the timestamp and never
// auto-advances DESTROY_SCHEDULED -> DESTROYED.
const DESTROY_SCHEDULED_MS = 24 * 60 * 60 * 1000;

export interface ListKeyRingsResult {
  keyRings: KeyRingResponse[];
  nextPageToken?: string | undefined;
}

export interface ListCryptoKeysResult {
  cryptoKeys: CryptoKeyResponse[];
  nextPageToken?: string | undefined;
}

export interface ListVersionsResult {
  cryptoKeyVersions: CryptoKeyVersionResponse[];
  nextPageToken?: string | undefined;
}

export class KeyManagementService {
  private readonly versionAllocations = new Map<string, Promise<void>>();

  constructor(
    private keyRingRepo: KeyRingRepository,
    private cryptoKeyRepo: CryptoKeyRepository,
    private versionRepo: CryptoKeyVersionRepository
  ) {}

  // ── Key rings ──

  async createKeyRing(
    project: string,
    location: string,
    keyRingId: string
  ): Promise<KeyRingResponse> {
    if (!keyRingId) {
      throw new KmsError('INVALID_ARGUMENT', 'keyRingId is required');
    }

    const name = buildKeyRingName(project, location, keyRingId);

    const existing = await this.keyRingRepo.getKeyRingByName(name);

    if (existing) {
      throw new KmsError('ALREADY_EXISTS', `KeyRing ${name} already exists`);
    }

    const created = await this.keyRingRepo.createKeyRing({ name });

    return keyRingRecordToResponse(created);
  }

  async getKeyRing(name: string): Promise<KeyRingResponse> {
    const record = await this.keyRingRepo.getKeyRingByName(name);

    if (!record) {
      throw new KmsError('NOT_FOUND', `KeyRing ${name} not found`);
    }

    return keyRingRecordToResponse(record);
  }

  async listKeyRings(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListKeyRingsResult> {
    const prefix = buildKeyRingName(project, location, '');
    const result = await this.keyRingRepo.listKeyRings(prefix, pageSize, pageToken);

    return {
      keyRings: result.items.map(keyRingRecordToResponse),
      nextPageToken: result.nextPageToken,
    };
  }

  // ── Crypto keys ──

  async createCryptoKey(
    keyRingName: string,
    cryptoKeyId: string,
    body: unknown,
    skipInitialVersionCreation: boolean
  ): Promise<CryptoKeyResponse> {
    if (!cryptoKeyId) {
      throw new KmsError('INVALID_ARGUMENT', 'cryptoKeyId is required');
    }

    const keyRing = await this.keyRingRepo.getKeyRingByName(keyRingName);

    if (!keyRing) {
      throw new KmsError('NOT_FOUND', `KeyRing ${keyRingName} not found`);
    }

    const parsed = CreateCryptoKeyRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new KmsError('INVALID_ARGUMENT', `Invalid CryptoKey: ${parsed.error.message}`);
    }

    const request = parsed.data;

    if (request.purpose == null) {
      throw new KmsError('INVALID_ARGUMENT', 'purpose is required');
    }

    const purposeInput = request.purpose;
    const purpose = this.normalizeEnum(() => normalizePurpose(purposeInput));

    if (!VALID_PURPOSES.includes(purpose as CryptoKeyPurposeValue)) {
      throw new KmsError('INVALID_ARGUMENT', `Unsupported purpose: ${purpose}`);
    }

    const algorithmInput = request.versionTemplate?.algorithm;
    const algorithm =
      algorithmInput != null
        ? this.normalizeEnum(() => normalizeAlgorithm(algorithmInput))
        : DEFAULT_ALGORITHM_FOR_PURPOSE[purpose as CryptoKeyPurposeValue];

    if (!isSupportedAlgorithm(algorithm) || !algorithmMatchesPurpose(algorithm, purpose)) {
      throw new KmsError(
        'INVALID_ARGUMENT',
        `Algorithm ${algorithm} is not supported for purpose ${purpose}`
      );
    }

    const protectionLevelInput = request.versionTemplate?.protectionLevel;
    const protectionLevel =
      protectionLevelInput != null
        ? this.normalizeEnum(() => normalizeProtectionLevel(protectionLevelInput))
        : DEFAULT_PROTECTION_LEVEL;

    if (protectionLevel !== ProtectionLevel.SOFTWARE) {
      throw new KmsError(
        'INVALID_ARGUMENT',
        `protectionLevel ${protectionLevel} is not supported by the emulator (only SOFTWARE)`
      );
    }

    const ring = parseKeyRingName(keyRingName);
    const name = buildCryptoKeyName(ring.project, ring.location, ring.keyRing, cryptoKeyId);

    const existing = await this.cryptoKeyRepo.getCryptoKeyByName(name);

    if (existing) {
      throw new KmsError('ALREADY_EXISTS', `CryptoKey ${name} already exists`);
    }

    const keyRecord = await this.cryptoKeyRepo.createCryptoKey({
      name,
      purpose,
      protectionLevel,
      algorithm,
      primaryVersion: null,
      labels: JSON.stringify(request.labels ?? {}),
      rotationPeriod: request.rotationPeriod ?? null,
      nextRotationTime: request.nextRotationTime ?? null,
    });

    let finalKey = keyRecord;
    let primary: CryptoKeyVersionRecord | null = null;

    if (!skipInitialVersionCreation) {
      const result = await this.addVersion(keyRecord.name);

      finalKey = result.key;

      if (purposeUsesPrimaryVersion(purpose)) {
        primary = result.version;
      }
    }

    return cryptoKeyRecordToResponse(finalKey, primary);
  }

  async getCryptoKey(name: string): Promise<CryptoKeyResponse> {
    const record = await this.requireCryptoKey(name);
    const primary = await this.getPrimaryVersionRecord(record);

    return cryptoKeyRecordToResponse(record, primary);
  }

  async listCryptoKeys(
    keyRingName: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListCryptoKeysResult> {
    const result = await this.cryptoKeyRepo.listCryptoKeys(keyRingName, pageSize, pageToken);

    const cryptoKeys = await Promise.all(
      result.items.map(async record => {
        const primary = await this.getPrimaryVersionRecord(record);

        return cryptoKeyRecordToResponse(record, primary);
      })
    );

    return { cryptoKeys, nextPageToken: result.nextPageToken };
  }

  async updateCryptoKey(
    name: string,
    body: unknown,
    updateMask?: string
  ): Promise<CryptoKeyResponse> {
    const existing = await this.requireCryptoKey(name);

    const parsed = UpdateCryptoKeyRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new KmsError('INVALID_ARGUMENT', `Invalid update: ${parsed.error.message}`);
    }

    const request = parsed.data;
    const mask = updateMask ? updateMask.split(',').map(s => s.trim()) : null;
    const allow = (field: string): boolean =>
      mask == null || mask.some(m => m === field || m.startsWith(`${field}.`));

    const updates: Partial<Omit<CryptoKeyRecord, keyof BaseRecord>> = {};

    if (request.labels !== undefined && allow('labels')) {
      updates.labels = JSON.stringify(request.labels);
    }

    if (request.rotationPeriod !== undefined && allow('rotationPeriod')) {
      updates.rotationPeriod = request.rotationPeriod;
    }

    if (request.nextRotationTime !== undefined && allow('nextRotationTime')) {
      updates.nextRotationTime = request.nextRotationTime;
    }

    if (request.versionTemplate !== undefined && allow('versionTemplate')) {
      const algorithm = normalizeAlgorithm(request.versionTemplate.algorithm);

      if (
        !isSupportedAlgorithm(algorithm) ||
        !algorithmMatchesPurpose(algorithm, existing.purpose)
      ) {
        throw new KmsError(
          'INVALID_ARGUMENT',
          `Algorithm ${algorithm} is not supported for purpose ${existing.purpose}`
        );
      }

      updates.algorithm = algorithm;
    }

    const updated = await this.cryptoKeyRepo.updateCryptoKey(name, updates);

    if (!updated) {
      throw new KmsError('NOT_FOUND', `CryptoKey ${name} not found`);
    }

    const primary = await this.getPrimaryVersionRecord(updated);

    return cryptoKeyRecordToResponse(updated, primary);
  }

  async updatePrimaryVersion(name: string, versionId: string): Promise<CryptoKeyResponse> {
    const key = await this.requireCryptoKey(name);

    if (!purposeUsesPrimaryVersion(key.purpose)) {
      throw new KmsError(
        'INVALID_ARGUMENT',
        `CryptoKey ${name} (purpose ${key.purpose}) does not use a primary version`
      );
    }

    if (!versionId) {
      throw new KmsError('INVALID_ARGUMENT', 'cryptoKeyVersionId is required');
    }

    const version = await this.versionRepo.getVersionByName(
      buildCryptoKeyVersionName(name, versionId)
    );

    if (!version) {
      throw new KmsError('NOT_FOUND', `CryptoKeyVersion ${versionId} not found`);
    }

    if (version.state !== CryptoKeyVersionState.ENABLED) {
      throw new KmsError('FAILED_PRECONDITION', `CryptoKeyVersion ${versionId} is not ENABLED`);
    }

    const updated = await this.cryptoKeyRepo.updateCryptoKey(name, { primaryVersion: versionId });

    if (!updated) {
      throw new KmsError('NOT_FOUND', `CryptoKey ${name} not found`);
    }

    return cryptoKeyRecordToResponse(updated, version);
  }

  // ── Crypto key versions ──

  async createCryptoKeyVersion(cryptoKeyName: string): Promise<CryptoKeyVersionResponse> {
    await this.requireCryptoKey(cryptoKeyName);

    const result = await this.addVersion(cryptoKeyName);

    return cryptoKeyVersionRecordToResponse(result.version);
  }

  async getCryptoKeyVersion(name: string): Promise<CryptoKeyVersionResponse> {
    const record = await this.versionRepo.getVersionByName(name);

    if (!record) {
      throw new KmsError('NOT_FOUND', `CryptoKeyVersion ${name} not found`);
    }

    return cryptoKeyVersionRecordToResponse(record);
  }

  async listCryptoKeyVersions(
    cryptoKeyName: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListVersionsResult> {
    const result = await this.versionRepo.listVersions(cryptoKeyName, pageSize, pageToken);

    return {
      cryptoKeyVersions: result.items.map(cryptoKeyVersionRecordToResponse),
      nextPageToken: result.nextPageToken,
    };
  }

  async updateCryptoKeyVersion(
    name: string,
    body: unknown,
    updateMask?: string
  ): Promise<CryptoKeyVersionResponse> {
    const existing = await this.versionRepo.getVersionByName(name);

    if (!existing) {
      throw new KmsError('NOT_FOUND', `CryptoKeyVersion ${name} not found`);
    }

    const parsed = UpdateCryptoKeyVersionRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new KmsError('INVALID_ARGUMENT', `Invalid update: ${parsed.error.message}`);
    }

    // cryptoKeyVersions.patch only supports the `state` field; honor updateMask.
    const mask = updateMask ? updateMask.split(',').map(s => s.trim()) : null;
    const stateAllowed = mask == null || mask.includes('state');
    const stateInput = parsed.data.state;

    if (stateInput === undefined || !stateAllowed) {
      return cryptoKeyVersionRecordToResponse(existing);
    }

    const target = this.normalizeEnum(() => normalizeState(stateInput));

    if (target !== CryptoKeyVersionState.ENABLED && target !== CryptoKeyVersionState.DISABLED) {
      throw new KmsError(
        'INVALID_ARGUMENT',
        'state can only be set to ENABLED or DISABLED; use destroy/restore otherwise'
      );
    }

    if (
      existing.state !== CryptoKeyVersionState.ENABLED &&
      existing.state !== CryptoKeyVersionState.DISABLED
    ) {
      throw new KmsError(
        'FAILED_PRECONDITION',
        `CryptoKeyVersion ${name} cannot transition from ${existing.state}`
      );
    }

    const updated = await this.versionRepo.updateVersion(name, { state: target });

    if (!updated) {
      throw new KmsError('NOT_FOUND', `CryptoKeyVersion ${name} not found`);
    }

    return cryptoKeyVersionRecordToResponse(updated);
  }

  async destroyCryptoKeyVersion(name: string): Promise<CryptoKeyVersionResponse> {
    const existing = await this.versionRepo.getVersionByName(name);

    if (!existing) {
      throw new KmsError('NOT_FOUND', `CryptoKeyVersion ${name} not found`);
    }

    if (
      existing.state === CryptoKeyVersionState.DESTROYED ||
      existing.state === CryptoKeyVersionState.DESTROY_SCHEDULED
    ) {
      throw new KmsError(
        'FAILED_PRECONDITION',
        `CryptoKeyVersion ${name} is already ${existing.state}`
      );
    }

    const destroyTime = new Date(Date.now() + DESTROY_SCHEDULED_MS).toISOString();

    const updated = await this.versionRepo.updateVersion(name, {
      state: CryptoKeyVersionState.DESTROY_SCHEDULED,
      destroyTime,
    });

    if (!updated) {
      throw new KmsError('NOT_FOUND', `CryptoKeyVersion ${name} not found`);
    }

    return cryptoKeyVersionRecordToResponse(updated);
  }

  async restoreCryptoKeyVersion(name: string): Promise<CryptoKeyVersionResponse> {
    const existing = await this.versionRepo.getVersionByName(name);

    if (!existing) {
      throw new KmsError('NOT_FOUND', `CryptoKeyVersion ${name} not found`);
    }

    if (existing.state !== CryptoKeyVersionState.DESTROY_SCHEDULED) {
      throw new KmsError(
        'FAILED_PRECONDITION',
        `CryptoKeyVersion ${name} is not scheduled for destruction`
      );
    }

    const updated = await this.versionRepo.updateVersion(name, {
      state: CryptoKeyVersionState.DISABLED,
      destroyTime: null,
    });

    if (!updated) {
      throw new KmsError('NOT_FOUND', `CryptoKeyVersion ${name} not found`);
    }

    return cryptoKeyVersionRecordToResponse(updated);
  }

  // ── Internal helpers ──

  private async requireCryptoKey(name: string): Promise<CryptoKeyRecord> {
    const record = await this.cryptoKeyRepo.getCryptoKeyByName(name);

    if (!record) {
      throw new KmsError('NOT_FOUND', `CryptoKey ${name} not found`);
    }

    return record;
  }

  private async getPrimaryVersionRecord(
    key: CryptoKeyRecord
  ): Promise<CryptoKeyVersionRecord | null> {
    if (!key.primaryVersion) {
      return null;
    }

    return this.versionRepo.getVersionByName(
      buildCryptoKeyVersionName(key.name, key.primaryVersion)
    );
  }

  private normalizeEnum<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      throw new KmsError(
        'INVALID_ARGUMENT',
        err instanceof Error ? err.message : 'invalid enum value'
      );
    }
  }

  /**
   * Allocations for one key are queued because the next version number is read
   * from the versions already persisted: two concurrent rotations would
   * otherwise both read the same maximum, and the second insert would fail as a
   * duplicate name. Deriving the number from the versions themselves rather than
   * from a counter on the CryptoKey also means there is no second write that can
   * be lost — a version that exists is a number that has been handed out.
   */
  private addVersion(
    cryptoKeyName: string
  ): Promise<{ version: CryptoKeyVersionRecord; key: CryptoKeyRecord }> {
    const queued = (this.versionAllocations.get(cryptoKeyName) ?? Promise.resolve()).then(() =>
      this.allocateVersion(cryptoKeyName)
    );

    // A failed allocation must not reject the next caller's queue position.
    const tail = queued.then(
      () => undefined,
      () => undefined
    );

    this.versionAllocations.set(cryptoKeyName, tail);

    void tail.then(() => {
      if (this.versionAllocations.get(cryptoKeyName) === tail) {
        this.versionAllocations.delete(cryptoKeyName);
      }
    });

    return queued;
  }

  private async allocateVersion(
    cryptoKeyName: string
  ): Promise<{ version: CryptoKeyVersionRecord; key: CryptoKeyRecord }> {
    const key = await this.requireCryptoKey(cryptoKeyName);
    const versionNumber = (await this.versionRepo.getHighestVersionNumber(cryptoKeyName)) + 1;
    const versionId = String(versionNumber);

    const version = await this.versionRepo.createVersion({
      name: buildCryptoKeyVersionName(key.name, versionId),
      cryptoKeyName: key.name,
      versionNumber,
      state: CryptoKeyVersionState.ENABLED,
      protectionLevel: key.protectionLevel,
      algorithm: key.algorithm,
      keyMaterial: generateKeyMaterial(key.algorithm),
      generateTime: new Date().toISOString(),
      destroyTime: null,
      destroyEventTime: null,
    });

    if (key.primaryVersion != null || !purposeUsesPrimaryVersion(key.purpose)) {
      return { version, key };
    }

    const updatedKey = await this.cryptoKeyRepo.updateCryptoKey(key.name, {
      primaryVersion: versionId,
    });

    return { version, key: updatedKey ?? key };
  }
}
