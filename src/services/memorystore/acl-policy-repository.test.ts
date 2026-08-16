/**
 * Unit tests for AclPolicyRepository
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { AclPolicyRepository } from './acl-policy-repository.ts';
import type { AclPolicyRecord, AclPolicyRevisionRecord } from './types.ts';

function aclPolicyData(
  overrides: Partial<Omit<AclPolicyRecord, 'id' | 'createdAt' | 'updatedAt'>> = {}
): Omit<AclPolicyRecord, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: 'projects/p/locations/us-central1/aclPolicies/policy-1',
    state: 'ACTIVE',
    rules: JSON.stringify([{ username: 'alice', rule: 'on >secret ~* +@all' }]),
    etag: 'etag-1',
    instanceAclPolicyAttachments: null,
    ...overrides,
  };
}

function revisionData(
  overrides: Partial<Omit<AclPolicyRevisionRecord, 'id' | 'createdAt' | 'updatedAt'>> = {}
): Omit<AclPolicyRevisionRecord, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: 'projects/p/locations/us-central1/aclPolicies/policy-1/revisions/1',
    policyName: 'projects/p/locations/us-central1/aclPolicies/policy-1',
    revisionNumber: '1',
    attachedInstances: JSON.stringify(['projects/p/locations/us-central1/instances/i']),
    snapshot: JSON.stringify(aclPolicyData()),
    ...overrides,
  };
}

describe('AclPolicyRepository', () => {
  let storage: StorageManager;
  let repo: AclPolicyRepository;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new AclPolicyRepository(storage);
    await repo.initialize();
  });

  test('createAclPolicy_persistsRecord_andRoundTripsJsonColumns', async () => {
    await repo.createAclPolicy(
      aclPolicyData({ rules: JSON.stringify([{ username: 'bob', rule: 'on nopass ~* +@all' }]) })
    );

    const persisted = await repo.getAclPolicyByName(
      'projects/p/locations/us-central1/aclPolicies/policy-1'
    );

    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted?.rules as string)).toEqual([
      { username: 'bob', rule: 'on nopass ~* +@all' },
    ]);
  });

  test('createAclPolicy_givenDuplicateName_rejectsAndLeavesTheOriginalRowIntact', async () => {
    await repo.createAclPolicy(aclPolicyData({ etag: 'etag-original' }));

    const promise = repo.createAclPolicy(aclPolicyData({ etag: 'etag-clobbering' }));

    await expect(promise).rejects.toThrow(/name|unique|exists/i);

    const page = await repo.listAclPolicies('p', 'us-central1');

    expect(page.aclPolicies).toHaveLength(1);
    expect(page.aclPolicies[0]?.etag).toBe('etag-original');
  });

  test('getAclPolicyByName_givenMissingPolicy_returnsNull', async () => {
    const found = await repo.getAclPolicyByName(
      'projects/p/locations/us-central1/aclPolicies/missing'
    );

    expect(found).toBeNull();
  });

  test('listAclPolicies_scopesToProjectViaLikePrefix_andDoesNotLeakOtherProjects', async () => {
    await repo.createAclPolicy(
      aclPolicyData({ name: 'projects/p1/locations/us-central1/aclPolicies/a' })
    );
    await repo.createAclPolicy(
      aclPolicyData({ name: 'projects/p2/locations/us-central1/aclPolicies/b' })
    );

    const result = await repo.listAclPolicies('p1', 'us-central1');

    expect(result.aclPolicies).toHaveLength(1);
    expect(result.aclPolicies[0]?.name.startsWith('projects/p1/')).toBe(true);
  });

  test('listAclPolicies_scopesToLocation_andDoesNotLeakPoliciesFromOtherRegionsInTheSameProject', async () => {
    await repo.createAclPolicy(
      aclPolicyData({ name: 'projects/p/locations/us-central1/aclPolicies/a' })
    );
    await repo.createAclPolicy(
      aclPolicyData({ name: 'projects/p/locations/europe-west1/aclPolicies/b' })
    );

    const result = await repo.listAclPolicies('p', 'us-central1');

    expect(result.aclPolicies).toHaveLength(1);
    expect(result.aclPolicies[0]?.name).toBe('projects/p/locations/us-central1/aclPolicies/a');
  });

  test('listAclPolicies_paginatesWithStringifiedOffsetTokens', async () => {
    await repo.createAclPolicy(
      aclPolicyData({ name: 'projects/p/locations/us-central1/aclPolicies/a' })
    );
    await repo.createAclPolicy(
      aclPolicyData({ name: 'projects/p/locations/us-central1/aclPolicies/b' })
    );

    const page1 = await repo.listAclPolicies('p', 'us-central1', 1);

    expect(page1.aclPolicies).toHaveLength(1);
    expect(page1.nextPageToken).toBe('1');

    const page2 = await repo.listAclPolicies('p', 'us-central1', 1, page1.nextPageToken);

    expect(page2.aclPolicies).toHaveLength(1);
    expect(page2.aclPolicies[0]?.name).not.toBe(page1.aclPolicies[0]?.name);
  });

  test('updateAclPolicy_persistsChanges_andLeavesUnrelatedFieldsUnchanged', async () => {
    await repo.createAclPolicy(aclPolicyData({ etag: 'etag-1' }));

    await repo.updateAclPolicy('projects/p/locations/us-central1/aclPolicies/policy-1', {
      etag: 'etag-2',
    });

    const persisted = await repo.getAclPolicyByName(
      'projects/p/locations/us-central1/aclPolicies/policy-1'
    );

    expect(persisted?.etag).toBe('etag-2');
    expect(persisted?.state).toBe('ACTIVE');
  });

  test('updateAclPolicy_givenMissingPolicy_returnsNull', async () => {
    const result = await repo.updateAclPolicy(
      'projects/p/locations/us-central1/aclPolicies/missing',
      { etag: 'etag-2' }
    );

    expect(result).toBeNull();
  });

  test('deleteAclPolicy_removesTheAclPolicy_andReturnsTrue', async () => {
    await repo.createAclPolicy(aclPolicyData());

    const deleted = await repo.deleteAclPolicy(
      'projects/p/locations/us-central1/aclPolicies/policy-1'
    );

    expect(deleted).toBe(true);

    const found = await repo.getAclPolicyByName(
      'projects/p/locations/us-central1/aclPolicies/policy-1'
    );

    expect(found).toBeNull();
  });

  test('deleteAclPolicy_givenMissingPolicy_returnsFalse', async () => {
    const deleted = await repo.deleteAclPolicy(
      'projects/p/locations/us-central1/aclPolicies/missing'
    );

    expect(deleted).toBe(false);
  });

  test('createRevision_persistsRecord_andRoundTripsTheSnapshotJsonColumn', async () => {
    await repo.createRevision(revisionData());

    const page = await repo.listRevisions('projects/p/locations/us-central1/aclPolicies/policy-1');

    expect(page.revisions).toHaveLength(1);
    expect(JSON.parse(page.revisions[0]?.snapshot as string)).toMatchObject({
      name: 'projects/p/locations/us-central1/aclPolicies/policy-1',
    });
  });

  test('listRevisions_scopesToThePolicyName_andPaginatesWithStringifiedOffsetTokens', async () => {
    await repo.createRevision(
      revisionData({
        name: 'projects/p/locations/us-central1/aclPolicies/policy-1/revisions/1',
        revisionNumber: '1',
      })
    );
    await repo.createRevision(
      revisionData({
        name: 'projects/p/locations/us-central1/aclPolicies/policy-1/revisions/2',
        revisionNumber: '2',
      })
    );
    await repo.createRevision(
      revisionData({
        name: 'projects/p/locations/us-central1/aclPolicies/policy-2/revisions/1',
        policyName: 'projects/p/locations/us-central1/aclPolicies/policy-2',
        revisionNumber: '1',
      })
    );

    const page1 = await repo.listRevisions(
      'projects/p/locations/us-central1/aclPolicies/policy-1',
      1
    );

    expect(page1.revisions).toHaveLength(1);
    expect(page1.nextPageToken).toBe('1');

    const page2 = await repo.listRevisions(
      'projects/p/locations/us-central1/aclPolicies/policy-1',
      1,
      page1.nextPageToken
    );

    expect(page2.revisions).toHaveLength(1);
    expect(page2.revisions[0]?.name).not.toBe(page1.revisions[0]?.name);
  });
  /**
   * Revision numbers are derived from the revision count, so deriving that
   * count from a paged listRevisions() call saturated at the default page
   * size of 100 and started minting duplicate revision numbers.
   */
  test('countRevisionsForPolicy_givenMoreRevisionsThanTheDefaultPageSize_countsThemAll', async () => {
    const policyName = 'projects/p/locations/us-central1/aclPolicies/policy-1';

    for (let revision = 1; revision <= 105; revision++) {
      await repo.createRevision(
        revisionData({
          name: `${policyName}/revisions/${revision}`,
          revisionNumber: String(revision),
          policyName,
        })
      );
    }

    expect(await repo.countRevisionsForPolicy(policyName)).toBe(105);
  });

  test('deleteAclPolicy_alsoRemovesItsRevisionsSoASameNamedPolicyDoesNotInheritThem', async () => {
    const policyName = 'projects/p/locations/us-central1/aclPolicies/policy-1';

    await repo.createAclPolicy(aclPolicyData({ name: policyName }));
    await repo.createRevision(
      revisionData({ name: `${policyName}/revisions/1`, revisionNumber: '1', policyName })
    );

    await repo.deleteAclPolicy(policyName);

    expect(await repo.countRevisionsForPolicy(policyName)).toBe(0);
  });
});
