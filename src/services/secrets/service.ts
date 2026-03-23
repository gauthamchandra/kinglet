/**
 * Secret Service - business logic for Secret Manager CRUD and version lifecycle
 */

import { decrypt, encrypt } from './encryption.ts';
import type { SecretRepository } from './repository.ts';
import type {
  AccessSecretVersionResponse,
  ListSecretsResponse,
  ListSecretVersionsResponse,
  SecretResponse,
  SecretVersionRecord,
  SecretVersionResponse,
} from './types.ts';
import {
  AddSecretVersionRequestSchema,
  buildSecretName,
  buildSecretVersionName,
  CreateSecretRequestSchema,
  generateEtag,
  PatchSecretRequestSchema,
  SecretVersionState,
  secretRecordToResponse,
  secretVersionRecordToResponse,
} from './types.ts';

export type SecretsErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_ARGUMENT'
  | 'FAILED_PRECONDITION';

export class SecretsError extends Error {
  readonly code: SecretsErrorCode;
  readonly resourceName?: string | undefined;

  constructor(code: SecretsErrorCode, message: string, resourceName?: string) {
    super(message);
    this.name = 'SecretsError';
    this.code = code;
    this.resourceName = resourceName;
  }
}

export class SecretService {
  private repo: SecretRepository;
  private encryptionKey: Buffer;

  constructor(repo: SecretRepository, encryptionKey: Buffer) {
    this.repo = repo;
    this.encryptionKey = encryptionKey;
  }

  // ── Secret CRUD ──

  async createSecret(
    project: string,
    secretId: string,
    body: unknown,
    location?: string | null
  ): Promise<SecretResponse> {
    const parsed = CreateSecretRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new SecretsError('INVALID_ARGUMENT', `Invalid request: ${parsed.error.message}`);
    }

    const request = parsed.data;
    const name = buildSecretName(project, secretId, location);

    const existing = await this.repo.getSecretByName(name);

    if (existing) {
      throw new SecretsError('ALREADY_EXISTS', name);
    }

    const record = await this.repo.createSecret({
      name,
      project,
      location: location ?? null,
      replication: JSON.stringify(request.replication),
      labels: JSON.stringify(request.labels ?? {}),
      annotations: JSON.stringify(request.annotations ?? {}),
      expireTime: request.expireTime ?? null,
      ttl: request.ttl ?? null,
      rotation: request.rotation ? JSON.stringify(request.rotation) : null,
      topics: request.topics ? JSON.stringify(request.topics) : null,
      versionAliases: JSON.stringify(request.versionAliases ?? {}),
      versionDestroyTtl: request.versionDestroyTtl ?? null,
      etag: generateEtag(),
      nextVersionNumber: 1,
    });

    return secretRecordToResponse(record);
  }

  async getSecret(name: string): Promise<SecretResponse> {
    const record = await this.repo.getSecretByName(name);

    if (!record) {
      throw new SecretsError('NOT_FOUND', `Secret ${name} not found`, name);
    }

    return secretRecordToResponse(record);
  }

  async listSecrets(
    project: string,
    location?: string | null,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListSecretsResponse> {
    const result = await this.repo.listSecrets(project, location, pageSize, pageToken);

    return {
      secrets: result.secrets.map(secretRecordToResponse),
      nextPageToken: result.nextPageToken,
      totalSize: result.totalCount,
    };
  }

  async patchSecret(name: string, body: unknown, updateMask?: string): Promise<SecretResponse> {
    const parsed = PatchSecretRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new SecretsError('INVALID_ARGUMENT', `Invalid request: ${parsed.error.message}`);
    }

    const existing = await this.repo.getSecretByName(name);

    if (!existing) {
      throw new SecretsError('NOT_FOUND', `Secret ${name} not found`, name);
    }

    const request = parsed.data;
    const allowedFields = updateMask ? new Set(updateMask.split(',').map(f => f.trim())) : null;
    const updates: Record<string, unknown> = {};

    if (request.labels !== undefined && (!allowedFields || allowedFields.has('labels'))) {
      updates.labels = JSON.stringify(request.labels);
    }

    if (request.annotations !== undefined && (!allowedFields || allowedFields.has('annotations'))) {
      updates.annotations = JSON.stringify(request.annotations);
    }

    if (request.ttl !== undefined && (!allowedFields || allowedFields.has('ttl'))) {
      updates.ttl = request.ttl;
    }

    if (request.expireTime !== undefined && (!allowedFields || allowedFields.has('expireTime'))) {
      updates.expireTime = request.expireTime;
    }

    if (request.rotation !== undefined && (!allowedFields || allowedFields.has('rotation'))) {
      updates.rotation = JSON.stringify(request.rotation);
    }

    if (request.topics !== undefined && (!allowedFields || allowedFields.has('topics'))) {
      updates.topics = JSON.stringify(request.topics);
    }

    if (
      request.versionDestroyTtl !== undefined &&
      (!allowedFields || allowedFields.has('versionDestroyTtl'))
    ) {
      updates.versionDestroyTtl = request.versionDestroyTtl;
    }

    if (
      request.versionAliases !== undefined &&
      (!allowedFields || allowedFields.has('versionAliases'))
    ) {
      updates.versionAliases = JSON.stringify(request.versionAliases);
    }

    updates.etag = generateEtag();

    const updated = await this.repo.updateSecret(name, updates);

    if (!updated) {
      throw new SecretsError('NOT_FOUND', `Secret ${name} not found`, name);
    }

    return secretRecordToResponse(updated);
  }

  async deleteSecret(name: string): Promise<void> {
    const existing = await this.repo.getSecretByName(name);

    if (!existing) {
      throw new SecretsError('NOT_FOUND', `Secret ${name} not found`, name);
    }

    await this.repo.deleteSecretVersionsBySecretName(name);

    const deleted = await this.repo.deleteSecret(name);

    if (!deleted) {
      throw new SecretsError('NOT_FOUND', `Secret ${name} not found`, name);
    }
  }

  // ── Version Lifecycle ──

  async addVersion(secretName: string, body: unknown): Promise<SecretVersionResponse> {
    const parsed = AddSecretVersionRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new SecretsError('INVALID_ARGUMENT', `Invalid request: ${parsed.error.message}`);
    }

    const secret = await this.repo.getSecretByName(secretName);

    if (!secret) {
      throw new SecretsError('NOT_FOUND', `Secret ${secretName} not found`, secretName);
    }

    const versionNumber = await this.repo.incrementVersionNumber(secretName);
    const versionName = buildSecretVersionName(secretName, versionNumber);

    const payloadData = parsed.data.payload.data;
    const plaintext = Buffer.from(payloadData, 'base64');
    const encrypted = encrypt(plaintext, this.encryptionKey);

    const record = await this.repo.createSecretVersion({
      name: versionName,
      secretName,
      versionNumber,
      state: SecretVersionState.ENABLED,
      etag: generateEtag(),
      encryptedPayload: encrypted.ciphertext.toString('base64'),
      iv: encrypted.iv.toString('base64'),
      authTag: encrypted.authTag.toString('base64'),
      payloadCrc32c: parsed.data.payload.dataCrc32c ?? null,
      destroyTime: null,
      scheduledDestroyTime: null,
    });

    return secretVersionRecordToResponse(record, this.parseReplicationStatus(secret.replication));
  }

  async getVersion(versionName: string): Promise<SecretVersionResponse> {
    const record = await this.resolveVersion(versionName);
    const secret = await this.repo.getSecretByName(record.secretName);

    return secretVersionRecordToResponse(
      record,
      secret ? this.parseReplicationStatus(secret.replication) : undefined
    );
  }

  async accessVersion(versionName: string): Promise<AccessSecretVersionResponse> {
    const record = await this.resolveVersion(versionName);

    if (record.state === SecretVersionState.DISABLED) {
      throw new SecretsError('FAILED_PRECONDITION', `Secret version ${record.name} is disabled`);
    }

    if (record.state === SecretVersionState.DESTROYED) {
      throw new SecretsError('FAILED_PRECONDITION', `Secret version ${record.name} is destroyed`);
    }

    if (!record.encryptedPayload || !record.iv || !record.authTag) {
      throw new SecretsError('FAILED_PRECONDITION', `Secret version ${record.name} has no payload`);
    }

    const ciphertext = Buffer.from(record.encryptedPayload, 'base64');
    const iv = Buffer.from(record.iv, 'base64');
    const authTag = Buffer.from(record.authTag, 'base64');

    const plaintext = decrypt(ciphertext, this.encryptionKey, iv, authTag);

    const response: AccessSecretVersionResponse = {
      name: record.name,
      payload: {
        data: plaintext.toString('base64'),
      },
    };

    if (record.payloadCrc32c) {
      response.payload.dataCrc32c = record.payloadCrc32c;
    }

    return response;
  }

  async listVersions(
    secretName: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListSecretVersionsResponse> {
    const secret = await this.repo.getSecretByName(secretName);

    if (!secret) {
      throw new SecretsError('NOT_FOUND', `Secret ${secretName} not found`, secretName);
    }

    const result = await this.repo.listSecretVersions(secretName, pageSize, pageToken);
    const replicationStatus = this.parseReplicationStatus(secret.replication);

    return {
      versions: result.versions.map(v => secretVersionRecordToResponse(v, replicationStatus)),
      nextPageToken: result.nextPageToken,
      totalSize: result.totalCount,
    };
  }

  async disableVersion(versionName: string, _body?: unknown): Promise<SecretVersionResponse> {
    const record = await this.resolveVersion(versionName);
    const secret = await this.repo.getSecretByName(record.secretName);
    const replicationStatus = secret ? this.parseReplicationStatus(secret.replication) : undefined;

    if (record.state === SecretVersionState.DESTROYED) {
      throw new SecretsError('FAILED_PRECONDITION', `Secret version ${record.name} is destroyed`);
    }

    if (record.state === SecretVersionState.DISABLED) {
      return secretVersionRecordToResponse(record, replicationStatus);
    }

    const updated = await this.repo.updateSecretVersion(record.name, {
      state: SecretVersionState.DISABLED,
      etag: generateEtag(),
    });

    if (!updated) {
      throw new SecretsError('NOT_FOUND', `Secret version ${record.name} not found`, record.name);
    }

    return secretVersionRecordToResponse(updated, replicationStatus);
  }

  async enableVersion(versionName: string, _body?: unknown): Promise<SecretVersionResponse> {
    const record = await this.resolveVersion(versionName);
    const secret = await this.repo.getSecretByName(record.secretName);
    const replicationStatus = secret ? this.parseReplicationStatus(secret.replication) : undefined;

    if (record.state === SecretVersionState.DESTROYED) {
      throw new SecretsError('FAILED_PRECONDITION', `Secret version ${record.name} is destroyed`);
    }

    if (record.state === SecretVersionState.ENABLED) {
      return secretVersionRecordToResponse(record, replicationStatus);
    }

    const updated = await this.repo.updateSecretVersion(record.name, {
      state: SecretVersionState.ENABLED,
      etag: generateEtag(),
    });

    if (!updated) {
      throw new SecretsError('NOT_FOUND', `Secret version ${record.name} not found`, record.name);
    }

    return secretVersionRecordToResponse(updated, replicationStatus);
  }

  async destroyVersion(versionName: string, _body?: unknown): Promise<SecretVersionResponse> {
    const record = await this.resolveVersion(versionName);
    const secret = await this.repo.getSecretByName(record.secretName);
    const replicationStatus = secret ? this.parseReplicationStatus(secret.replication) : undefined;

    if (record.state === SecretVersionState.DESTROYED) {
      return secretVersionRecordToResponse(record, replicationStatus);
    }

    const updated = await this.repo.updateSecretVersion(record.name, {
      state: SecretVersionState.DESTROYED,
      destroyTime: new Date().toISOString(),
      etag: generateEtag(),
      encryptedPayload: null,
      iv: null,
      authTag: null,
    });

    if (!updated) {
      throw new SecretsError('NOT_FOUND', `Secret version ${record.name} not found`, record.name);
    }

    return secretVersionRecordToResponse(updated, replicationStatus);
  }

  // ── Private Helpers ──

  private parseReplicationStatus(replicationJson: string): unknown {
    const replication = JSON.parse(replicationJson) as Record<string, unknown>;

    if (replication.automatic !== undefined) {
      return { automatic: {} };
    }

    if (replication.userManaged !== undefined) {
      const userManaged = replication.userManaged as { replicas?: Array<{ location: string }> };

      return {
        userManaged: {
          replicas: (userManaged.replicas ?? []).map(r => ({ location: r.location })),
        },
      };
    }

    return undefined;
  }

  private async resolveVersion(versionName: string): Promise<SecretVersionRecord> {
    // Check if this is a "latest" reference
    if (versionName.endsWith('/versions/latest')) {
      const secretName = versionName.replace('/versions/latest', '');
      const latest = await this.repo.getLatestEnabledVersion(secretName);

      if (!latest) {
        throw new SecretsError(
          'NOT_FOUND',
          `No enabled version found for secret ${secretName}`,
          secretName
        );
      }

      return latest;
    }

    const record = await this.repo.getSecretVersionByName(versionName);

    if (!record) {
      throw new SecretsError('NOT_FOUND', `Secret version ${versionName} not found`, versionName);
    }

    return record;
  }
}
