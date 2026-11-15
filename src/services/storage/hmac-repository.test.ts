import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { HmacKeyRepository } from './hmac-repository.ts';
import type { HmacKeyRecord } from './types.ts';

function keyData(
  overrides: Partial<Omit<HmacKeyRecord, keyof BaseRecord>> = {}
): Omit<HmacKeyRecord, keyof BaseRecord> {
  return {
    projectId: 'proj-1',
    accessId: 'GOOG1TESTACCESSID000001',
    secret: 'stored-secret-value',
    serviceAccountEmail: 'sa@proj-1.iam.gserviceaccount.com',
    state: 'ACTIVE',
    etag: 'etag-1',
    timeCreated: '2020-01-01T00:00:00.000Z',
    updated: '2020-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('HmacKeyRepository', () => {
  let storage: StorageManager;
  let repo: HmacKeyRepository;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new HmacKeyRepository(storage);
    await repo.initialize();
  });

  test('create persists the secret and get returns it', async () => {
    const created = await repo.create(keyData());

    expect(created.secret).toBe('stored-secret-value');
    expect(created.id).toBeTypeOf('string');

    const found = await repo.getByAccessId('proj-1', created.accessId);

    expect(found?.secret).toBe('stored-secret-value');
    expect(found?.state).toBe('ACTIVE');
  });

  test('getByAccessId returns null for another project or a missing id', async () => {
    await repo.create(keyData());

    expect(await repo.getByAccessId('other-project', 'GOOG1TESTACCESSID000001')).toBeNull();
    expect(await repo.getByAccessId('proj-1', 'GOOG1MISSING')).toBeNull();
  });

  test('list hides DELETED keys unless showDeletedKeys is set', async () => {
    await repo.create(keyData({ accessId: 'GOOG1ACTIVE000000000001', state: 'ACTIVE' }));
    await repo.create(keyData({ accessId: 'GOOG1INACTIVE0000000001', state: 'INACTIVE' }));
    await repo.create(keyData({ accessId: 'GOOG1DELETED00000000001', state: 'DELETED' }));

    const live = await repo.list({
      projectId: 'proj-1',
      showDeletedKeys: false,
      limit: 10,
    });

    expect(live.keys.map(key => key.accessId)).toEqual([
      'GOOG1ACTIVE000000000001',
      'GOOG1INACTIVE0000000001',
    ]);

    const all = await repo.list({
      projectId: 'proj-1',
      showDeletedKeys: true,
      limit: 10,
    });

    expect(all.keys.map(key => key.state)).toEqual(['ACTIVE', 'DELETED', 'INACTIVE']);
  });

  test('list filters by service account and paginates in accessId order', async () => {
    await repo.create(
      keyData({
        accessId: 'GOOG1BBBB',
        serviceAccountEmail: 'a@proj-1.iam.gserviceaccount.com',
      })
    );
    await repo.create(
      keyData({
        accessId: 'GOOG1AAAA',
        serviceAccountEmail: 'a@proj-1.iam.gserviceaccount.com',
      })
    );
    await repo.create(
      keyData({
        accessId: 'GOOG1CCCC',
        serviceAccountEmail: 'b@proj-1.iam.gserviceaccount.com',
      })
    );

    const page = await repo.list({
      projectId: 'proj-1',
      serviceAccountEmail: 'a@proj-1.iam.gserviceaccount.com',
      showDeletedKeys: false,
      limit: 1,
    });

    expect(page.keys.map(key => key.accessId)).toEqual(['GOOG1AAAA']);
    expect(page.nextPageToken).toBeTypeOf('string');

    const rest = await repo.list({
      projectId: 'proj-1',
      serviceAccountEmail: 'a@proj-1.iam.gserviceaccount.com',
      showDeletedKeys: false,
      limit: 1,
      pageToken: page.nextPageToken,
    });

    expect(rest.keys.map(key => key.accessId)).toEqual(['GOOG1BBBB']);
    expect(rest.nextPageToken).toBeUndefined();
  });

  test('countNonDeleted ignores DELETED keys and other service accounts', async () => {
    await repo.create(keyData({ accessId: 'GOOG1A', state: 'ACTIVE' }));
    await repo.create(keyData({ accessId: 'GOOG1B', state: 'INACTIVE' }));
    await repo.create(keyData({ accessId: 'GOOG1C', state: 'DELETED' }));
    await repo.create(
      keyData({
        accessId: 'GOOG1D',
        serviceAccountEmail: 'other@proj-1.iam.gserviceaccount.com',
      })
    );

    const count = await repo.countNonDeleted('proj-1', 'sa@proj-1.iam.gserviceaccount.com');

    expect(count).toBe(2);
  });

  test('update replaces state and etag', async () => {
    const created = await repo.create(keyData());

    const updated = await repo.update(created.id, {
      state: 'INACTIVE',
      etag: 'etag-2',
      updated: '2020-01-02T00:00:00.000Z',
    });

    expect(updated?.state).toBe('INACTIVE');
    expect(updated?.etag).toBe('etag-2');
    expect(updated?.secret).toBe('stored-secret-value');
    expect(updated?.timeCreated).toBe('2020-01-01T00:00:00.000Z');
  });
});
