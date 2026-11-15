import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { GcsError } from './bucket-service.ts';
import { HmacKeyRepository } from './hmac-repository.ts';
import { HmacKeyService } from './hmac-service.ts';
import { MAX_HMAC_KEYS_PER_SERVICE_ACCOUNT, resolveHmacPageSize } from './types.ts';

const PROJECT = 'proj-1';
const EMAIL = 'sa@proj-1.iam.gserviceaccount.com';

describe('resolveHmacPageSize', () => {
  test('uses 250 when the caller omits maxResults or sends a non-positive value', () => {
    expect(resolveHmacPageSize(undefined)).toBe(250);
    expect(resolveHmacPageSize(0)).toBe(250);
    expect(resolveHmacPageSize(-5)).toBe(250);
  });

  test('caps maxResults at 250', () => {
    expect(resolveHmacPageSize(10)).toBe(10);
    expect(resolveHmacPageSize(250)).toBe(250);
    expect(resolveHmacPageSize(1000)).toBe(250);
  });
});

describe('HmacKeyService', () => {
  let service: HmacKeyService;

  beforeEach(async () => {
    const storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    const repo = new HmacKeyRepository(storage);
    await repo.initialize();
    service = new HmacKeyService(repo);
  });

  test('create returns the secret once and metadata without it', async () => {
    const created = await service.createKey(PROJECT, EMAIL);

    expect(created.kind).toBe('storage#hmacKey');
    expect(created.secret).toMatch(/^[A-Za-z0-9+/]{40}$/);
    expect(created.metadata.kind).toBe('storage#hmacKeyMetadata');
    expect(created.metadata.accessId).toMatch(/^GOOG1[A-Z0-9]+$/);
    expect(created.metadata.id).toBe(`${PROJECT}/${created.metadata.accessId}`);
    expect(created.metadata.selfLink).toBe(
      `https://www.googleapis.com/storage/v1/projects/${PROJECT}/hmacKeys/${created.metadata.accessId}`
    );
    expect(created.metadata.projectId).toBe(PROJECT);
    expect(created.metadata.serviceAccountEmail).toBe(EMAIL);
    expect(created.metadata.state).toBe('ACTIVE');
    expect(created.metadata.etag.length).toBeGreaterThan(0);
    expect(created.metadata.timeCreated).toBe(created.metadata.updated);
    expect(created.metadata).not.toHaveProperty('secret');

    const fetched = await service.getKey(PROJECT, created.metadata.accessId);

    expect(fetched).not.toHaveProperty('secret');
    expect(JSON.stringify(fetched)).not.toContain(created.secret);
    expect(fetched.etag).toBe(created.metadata.etag);
  });

  test('create rejects a blank project or service account email', async () => {
    const missingEmail = service.createKey(PROJECT, '');
    await expect(missingEmail).rejects.toBeInstanceOf(GcsError);
    await expect(missingEmail).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');

    const missingProject = service.createKey('  ', EMAIL);
    await expect(missingProject).rejects.toBeInstanceOf(GcsError);
    await expect(missingProject).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('get and list do not return the secret', async () => {
    const first = await service.createKey(PROJECT, EMAIL);
    const second = await service.createKey(PROJECT, 'other@proj-1.iam.gserviceaccount.com');

    const listed = await service.listKeys(PROJECT, {});

    expect(listed.kind).toBe('storage#hmacKeysMetadata');
    expect(listed.items).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain(first.secret);
    expect(JSON.stringify(listed)).not.toContain(second.secret);
    expect(listed.items?.every(item => !Object.hasOwn(item, 'secret'))).toBe(true);
  });

  test('get returns NOT_FOUND for an unknown id or another project', async () => {
    const created = await service.createKey(PROJECT, EMAIL);

    const missing = service.getKey(PROJECT, 'GOOG1MISSING');
    await expect(missing).rejects.toBeInstanceOf(GcsError);
    await expect(missing).rejects.toHaveProperty('code', 'NOT_FOUND');

    const otherProject = service.getKey('other-project', created.metadata.accessId);
    await expect(otherProject).rejects.toBeInstanceOf(GcsError);
    await expect(otherProject).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('list filters by service account and paginates', async () => {
    await service.createKey(PROJECT, EMAIL);
    await service.createKey(PROJECT, EMAIL);
    await service.createKey(PROJECT, 'other@proj-1.iam.gserviceaccount.com');

    const filtered = await service.listKeys(PROJECT, { serviceAccountEmail: EMAIL, maxResults: 1 });

    expect(filtered.items).toHaveLength(1);
    expect(filtered.items?.[0]?.serviceAccountEmail).toBe(EMAIL);
    expect(filtered.nextPageToken).toBeTypeOf('string');

    const page2 = await service.listKeys(PROJECT, {
      serviceAccountEmail: EMAIL,
      maxResults: 1,
      pageToken: filtered.nextPageToken,
    });

    expect(page2.items).toHaveLength(1);
    expect(page2.items?.[0]?.accessId).not.toBe(filtered.items?.[0]?.accessId);
    expect(page2.nextPageToken).toBeUndefined();
  });

  test('list hides deleted keys until showDeletedKeys is set', async () => {
    const created = await service.createKey(PROJECT, EMAIL);
    await service.updateKey(PROJECT, created.metadata.accessId, {
      state: 'INACTIVE',
      etag: created.metadata.etag,
    });
    await service.deleteKey(PROJECT, created.metadata.accessId);

    const hidden = await service.listKeys(PROJECT, {});
    expect(hidden.items).toHaveLength(0);

    const shown = await service.listKeys(PROJECT, { showDeletedKeys: true });
    expect(shown.items).toHaveLength(1);
    expect(shown.items?.[0]?.state).toBe('DELETED');
    expect(shown.items?.[0]).not.toHaveProperty('secret');
  });

  test('update requires a matching etag and a different state', async () => {
    const created = await service.createKey(PROJECT, EMAIL);
    const accessId = created.metadata.accessId;

    const missingEtag = service.updateKey(PROJECT, accessId, { state: 'INACTIVE' });
    await expect(missingEtag).rejects.toBeInstanceOf(GcsError);
    await expect(missingEtag).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
    await expect(missingEtag).rejects.toThrow('Etag is required');

    const badEtag = service.updateKey(PROJECT, accessId, { state: 'INACTIVE', etag: 'badEtag' });
    await expect(badEtag).rejects.toThrow('Etag does not match expected value.');

    const sameState = service.updateKey(PROJECT, accessId, {
      state: 'ACTIVE',
      etag: created.metadata.etag,
    });
    await expect(sameState).rejects.toThrow('Update must modify the credential');

    const updated = await service.updateKey(PROJECT, accessId, {
      kind: 'storage#hmacKeyMetadata',
      accessId,
      projectId: PROJECT,
      serviceAccountEmail: EMAIL,
      state: 'INACTIVE',
      etag: created.metadata.etag,
    });

    expect(updated.state).toBe('INACTIVE');
    expect(updated.etag).not.toBe(created.metadata.etag);
    expect(updated.timeCreated).toBe(created.metadata.timeCreated);
    expect(updated).not.toHaveProperty('secret');

    const fetched = await service.getKey(PROJECT, accessId);
    expect(fetched.state).toBe('INACTIVE');
    expect(fetched.etag).toBe(updated.etag);
  });

  test('update rejects a deleted key and a state other than ACTIVE or INACTIVE', async () => {
    const created = await service.createKey(PROJECT, EMAIL);
    const accessId = created.metadata.accessId;
    const inactive = await service.updateKey(PROJECT, accessId, {
      state: 'INACTIVE',
      etag: created.metadata.etag,
    });
    await service.deleteKey(PROJECT, accessId);

    const deleted = service.updateKey(PROJECT, accessId, {
      state: 'ACTIVE',
      etag: inactive.etag,
    });
    await expect(deleted).rejects.toThrow('Cannot update keys in DELETED state.');

    const fresh = await service.createKey(PROJECT, EMAIL);
    const invalid = service.updateKey(PROJECT, fresh.metadata.accessId, {
      state: 'DELETED',
      etag: fresh.metadata.etag,
    });
    await expect(invalid).rejects.toThrow('State must be ACTIVE or INACTIVE');
  });

  test('delete of an ACTIVE key is rejected and an INACTIVE key becomes DELETED', async () => {
    const created = await service.createKey(PROJECT, EMAIL);
    const accessId = created.metadata.accessId;

    const active = service.deleteKey(PROJECT, accessId);
    await expect(active).rejects.toBeInstanceOf(GcsError);
    await expect(active).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
    await expect(active).rejects.toThrow('Cannot delete keys in ACTIVE state.');

    const stillThere = await service.getKey(PROJECT, accessId);
    expect(stillThere.state).toBe('ACTIVE');

    await service.updateKey(PROJECT, accessId, {
      state: 'INACTIVE',
      etag: created.metadata.etag,
    });
    await expect(service.deleteKey(PROJECT, accessId)).resolves.toBeUndefined();

    const deleted = await service.getKey(PROJECT, accessId);
    expect(deleted.state).toBe('DELETED');
    expect(deleted).not.toHaveProperty('secret');

    const again = service.deleteKey(PROJECT, accessId);
    await expect(again).rejects.toThrow('Cannot delete keys in DELETED state.');
  });

  test('update and delete of an unknown key are NOT_FOUND', async () => {
    const missingUpdate = service.updateKey(PROJECT, 'GOOG1MISSING', {
      state: 'INACTIVE',
      etag: 'etag',
    });
    await expect(missingUpdate).rejects.toBeInstanceOf(GcsError);
    await expect(missingUpdate).rejects.toHaveProperty('code', 'NOT_FOUND');

    const missingDelete = service.deleteKey(PROJECT, 'GOOG1MISSING');
    await expect(missingDelete).rejects.toBeInstanceOf(GcsError);
    await expect(missingDelete).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('an eleventh non-deleted key for one service account is rejected', async () => {
    expect(MAX_HMAC_KEYS_PER_SERVICE_ACCOUNT).toBe(10);

    for (let i = 0; i < MAX_HMAC_KEYS_PER_SERVICE_ACCOUNT; i++) {
      await service.createKey(PROJECT, EMAIL);
    }

    const limited = service.createKey(PROJECT, EMAIL);
    await expect(limited).rejects.toBeInstanceOf(GcsError);
    await expect(limited).rejects.toThrow('HMAC key limit reached');

    const otherAccount = await service.createKey(PROJECT, 'other@proj-1.iam.gserviceaccount.com');
    expect(otherAccount.metadata.state).toBe('ACTIVE');
  });

  test('a deleted key does not count toward the per-account limit', async () => {
    const keys = [];

    for (let i = 0; i < MAX_HMAC_KEYS_PER_SERVICE_ACCOUNT; i++) {
      keys.push(await service.createKey(PROJECT, EMAIL));
    }

    const first = keys[0];

    if (!first) {
      throw new Error('expected a created key');
    }

    await service.updateKey(PROJECT, first.metadata.accessId, {
      state: 'INACTIVE',
      etag: first.metadata.etag,
    });
    await service.deleteKey(PROJECT, first.metadata.accessId);

    const replacement = await service.createKey(PROJECT, EMAIL);
    const live = await service.listKeys(PROJECT, { serviceAccountEmail: EMAIL });
    const accessIds = live.items.map(item => item.accessId);

    expect(replacement.metadata.state).toBe('ACTIVE');
    expect(live.items).toHaveLength(MAX_HMAC_KEYS_PER_SERVICE_ACCOUNT);
    expect(accessIds).toContain(replacement.metadata.accessId);
    expect(accessIds).not.toContain(first.metadata.accessId);
  });

  test('parallel creates stop at the per-account limit', async () => {
    const attempts = Array.from({ length: MAX_HMAC_KEYS_PER_SERVICE_ACCOUNT + 2 }, () =>
      service.createKey(PROJECT, EMAIL)
    );
    const results = await Promise.allSettled(attempts);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(
      MAX_HMAC_KEYS_PER_SERVICE_ACCOUNT
    );
    expect(rejected).toHaveLength(2);

    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(GcsError);
      expect(result.reason).toHaveProperty('message', 'HMAC key limit reached');
    }

    const live = await service.listKeys(PROJECT, { serviceAccountEmail: EMAIL });

    expect(live.items).toHaveLength(MAX_HMAC_KEYS_PER_SERVICE_ACCOUNT);
  });

  test('two updates with the same etag cannot both succeed', async () => {
    const created = await service.createKey(PROJECT, EMAIL);
    const body = { state: 'INACTIVE', etag: created.metadata.etag };
    const results = await Promise.allSettled([
      service.updateKey(PROJECT, created.metadata.accessId, body),
      service.updateKey(PROJECT, created.metadata.accessId, body),
    ]);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(GcsError);
    expect(rejected[0]?.reason).toHaveProperty('message', 'Etag does not match expected value.');

    const fetched = await service.getKey(PROJECT, created.metadata.accessId);

    expect(fetched.state).toBe('INACTIVE');
    expect(fetched.etag).not.toBe(created.metadata.etag);
  });

  test('an update cannot revive a key that delete already removed', async () => {
    const created = await service.createKey(PROJECT, EMAIL);
    const inactive = await service.updateKey(PROJECT, created.metadata.accessId, {
      state: 'INACTIVE',
      etag: created.metadata.etag,
    });
    const [updateResult, deleteResult] = await Promise.allSettled([
      service.updateKey(PROJECT, created.metadata.accessId, {
        state: 'ACTIVE',
        etag: inactive.etag,
      }),
      service.deleteKey(PROJECT, created.metadata.accessId),
    ]);

    if (updateResult == null || deleteResult == null) {
      throw new Error('expected both calls to settle');
    }

    const fetched = await service.getKey(PROJECT, created.metadata.accessId);
    const updateWon = updateResult.status === 'fulfilled';

    expect(updateWon).not.toBe(deleteResult.status === 'fulfilled');
    expect(fetched.state).toBe(updateWon ? 'ACTIVE' : 'DELETED');

    const loser = updateWon ? deleteResult : updateResult;

    expect(loser.status).toBe('rejected');

    if (loser.status !== 'rejected') {
      throw new Error('expected the losing call to reject');
    }

    expect(loser.reason).toHaveProperty(
      'message',
      updateWon ? 'Cannot delete keys in ACTIVE state.' : 'Cannot update keys in DELETED state.'
    );
  });
});
