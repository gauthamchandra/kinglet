/**
 * HMAC key business logic for the Cloud Storage JSON API.
 *
 * Create returns `secret` once. Get and list do not. The secret stays on the
 * row and is not copied onto those responses. Request signatures are not
 * checked, and the service account is not looked up.
 *
 * Update requires `etag`. Real GCS also accepts an update that omits it
 * (`gslib/tests/test_hmac.py` `test_update`). This emulator rejects that
 * omission. A present etag that does not match uses the message gsutil
 * asserts. gsutil does not assert that mismatch's HTTP status; this returns 400.
 */

import { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import { GcsError } from './bucket-service.ts';
import type { HmacKeyRepository } from './hmac-repository.ts';
import type { HmacKey, HmacKeyList, HmacKeyMetadata } from './types.ts';
import {
  HmacKeyState,
  hmacKeyRecordToMetadata,
  MAX_HMAC_KEYS_PER_SERVICE_ACCOUNT,
  resolveHmacPageSize,
} from './types.ts';

const ACCESS_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export interface ListHmacKeysOptions {
  maxResults?: number | undefined;
  pageToken?: string | undefined;
  serviceAccountEmail?: string | undefined;
  showDeletedKeys?: boolean | undefined;
}

function randomAccessId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let suffix = '';

  for (const byte of bytes) {
    suffix += ACCESS_ID_ALPHABET[byte % ACCESS_ID_ALPHABET.length] ?? 'A';
  }

  return `GOOG1${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function accountLockKey(projectId: string, serviceAccountEmail: string): string {
  return `account\0${projectId}\0${serviceAccountEmail}`;
}

function hmacKeyLockKey(projectId: string, accessId: string): string {
  return `key\0${projectId}\0${accessId}`;
}

export class HmacKeyService {
  private repo: HmacKeyRepository;

  /**
   * Create counts then inserts. Update and delete read, check, then write.
   * Callers of one service share this mutex. Account creates key on the
   * project and service account. Update and delete key on the access id,
   * so they cannot pass each other.
   */
  private readonly writes = new ResourceMutex();

  constructor(repo: HmacKeyRepository) {
    this.repo = repo;
  }

  async createKey(projectId: string, serviceAccountEmail: string): Promise<HmacKey> {
    const project = projectId.trim();
    const email = serviceAccountEmail.trim();

    if (project.length === 0) {
      throw new GcsError('INVALID_ARGUMENT', 'projectId is required');
    }

    if (email.length === 0) {
      throw new GcsError('INVALID_ARGUMENT', 'serviceAccountEmail is required');
    }

    return this.writes.runExclusively(accountLockKey(project, email), async () => {
      const existing = await this.repo.countNonDeleted(project, email);

      if (existing >= MAX_HMAC_KEYS_PER_SERVICE_ACCOUNT) {
        throw new GcsError('INVALID_ARGUMENT', 'HMAC key limit reached');
      }

      const now = new Date().toISOString();
      const created = await this.repo.create({
        projectId: project,
        accessId: randomAccessId(),
        secret: Buffer.from(crypto.getRandomValues(new Uint8Array(30))).toString('base64'),
        serviceAccountEmail: email,
        state: HmacKeyState.ACTIVE,
        etag: Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64'),
        timeCreated: now,
        updated: now,
      });

      const response: HmacKey = {
        kind: 'storage#hmacKey',
        metadata: hmacKeyRecordToMetadata(created),
        secret: created.secret,
      };

      return response;
    });
  }

  async getKey(projectId: string, accessId: string): Promise<HmacKeyMetadata> {
    const record = await this.repo.getByAccessId(projectId, accessId);

    if (!record) {
      throw new GcsError('NOT_FOUND', accessId);
    }

    return hmacKeyRecordToMetadata(record);
  }

  async listKeys(projectId: string, options: ListHmacKeysOptions): Promise<HmacKeyList> {
    const email = options.serviceAccountEmail?.trim();
    const result = await this.repo.list({
      projectId,
      serviceAccountEmail: email ? email : undefined,
      showDeletedKeys: options.showDeletedKeys === true,
      limit: resolveHmacPageSize(options.maxResults),
      pageToken: options.pageToken,
    });

    const response: HmacKeyList = {
      kind: 'storage#hmacKeysMetadata',
      items: result.keys.map(hmacKeyRecordToMetadata),
    };

    if (result.nextPageToken) {
      response.nextPageToken = result.nextPageToken;
    }

    return response;
  }

  async updateKey(projectId: string, accessId: string, body: unknown): Promise<HmacKeyMetadata> {
    return this.writes.runExclusively(hmacKeyLockKey(projectId, accessId), () =>
      this.applyUpdate(projectId, accessId, body)
    );
  }

  private async applyUpdate(
    projectId: string,
    accessId: string,
    body: unknown
  ): Promise<HmacKeyMetadata> {
    const existing = await this.repo.getByAccessId(projectId, accessId);

    if (!existing) {
      throw new GcsError('NOT_FOUND', accessId);
    }

    if (existing.state === HmacKeyState.DELETED) {
      throw new GcsError('INVALID_ARGUMENT', 'Cannot update keys in DELETED state.');
    }

    const record = isRecord(body) ? body : {};
    const etag = record.etag;
    const state = record.state;

    if (typeof etag !== 'string' || etag.length === 0) {
      throw new GcsError('INVALID_ARGUMENT', 'Etag is required');
    }

    if (state !== HmacKeyState.ACTIVE && state !== HmacKeyState.INACTIVE) {
      throw new GcsError('INVALID_ARGUMENT', 'State must be ACTIVE or INACTIVE');
    }

    if (etag !== existing.etag) {
      throw new GcsError('INVALID_ARGUMENT', 'Etag does not match expected value.');
    }

    if (state === existing.state) {
      throw new GcsError('INVALID_ARGUMENT', 'Update must modify the credential');
    }

    const updated = await this.repo.update(existing.id, {
      state,
      etag: Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64'),
      updated: new Date().toISOString(),
    });

    if (!updated) {
      throw new GcsError('NOT_FOUND', accessId);
    }

    return hmacKeyRecordToMetadata(updated);
  }

  async deleteKey(projectId: string, accessId: string): Promise<void> {
    return this.writes.runExclusively(hmacKeyLockKey(projectId, accessId), () =>
      this.applyDelete(projectId, accessId)
    );
  }

  private async applyDelete(projectId: string, accessId: string): Promise<void> {
    const existing = await this.repo.getByAccessId(projectId, accessId);

    if (!existing) {
      throw new GcsError('NOT_FOUND', accessId);
    }

    if (existing.state === HmacKeyState.ACTIVE) {
      throw new GcsError('INVALID_ARGUMENT', 'Cannot delete keys in ACTIVE state.');
    }

    if (existing.state === HmacKeyState.DELETED) {
      throw new GcsError('INVALID_ARGUMENT', 'Cannot delete keys in DELETED state.');
    }

    const updated = await this.repo.update(existing.id, {
      state: HmacKeyState.DELETED,
      etag: Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64'),
      updated: new Date().toISOString(),
    });

    if (!updated) {
      throw new GcsError('NOT_FOUND', accessId);
    }
  }
}
