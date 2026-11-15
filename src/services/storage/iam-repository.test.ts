import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { IamPolicyRepository } from './iam-repository.ts';

describe('IamPolicyRepository', () => {
  let storage: StorageManager;
  let repo: IamPolicyRepository;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new IamPolicyRepository(storage);
    await repo.initialize();
  });

  test('getByResourceId returns null when nothing is stored', async () => {
    const found = await repo.getByResourceId('projects/_/buckets/missing');

    expect(found).toBeNull();
  });

  test('save inserts a policy and a second save replaces it', async () => {
    const created = await repo.save({
      resourceId: 'projects/_/buckets/iam-bucket',
      version: 1,
      etag: 'etag-1',
      bindings: '[]',
    });

    expect(created.resourceId).toBe('projects/_/buckets/iam-bucket');
    expect(created.etag).toBe('etag-1');
    expect(created.id).toBeTypeOf('string');

    const replaced = await repo.save({
      resourceId: 'projects/_/buckets/iam-bucket',
      version: 3,
      etag: 'etag-2',
      bindings: JSON.stringify([
        { role: 'roles/storage.objectViewer', members: ['user:a@example.com'] },
      ]),
    });

    expect(replaced.id).toBe(created.id);
    expect(replaced.version).toBe(3);
    expect(replaced.etag).toBe('etag-2');

    const found = await repo.getByResourceId('projects/_/buckets/iam-bucket');

    expect(found?.etag).toBe('etag-2');
    expect(found?.version).toBe(3);
    expect(found?.bindings).toBe(
      JSON.stringify([{ role: 'roles/storage.objectViewer', members: ['user:a@example.com'] }])
    );
  });

  test('save keeps policies for different resources apart', async () => {
    await repo.save({
      resourceId: 'projects/_/buckets/one',
      version: 1,
      etag: 'etag-one',
      bindings: '[]',
    });
    await repo.save({
      resourceId: 'projects/_/buckets/two',
      version: 1,
      etag: 'etag-two',
      bindings: '[]',
    });

    const one = await repo.getByResourceId('projects/_/buckets/one');
    const two = await repo.getByResourceId('projects/_/buckets/two');

    expect(one?.etag).toBe('etag-one');
    expect(two?.etag).toBe('etag-two');
  });
});
