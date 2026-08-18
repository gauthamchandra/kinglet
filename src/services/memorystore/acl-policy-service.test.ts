/**
 * Unit tests for AclPolicyService
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AclPolicyRepository } from './acl-policy-repository.ts';
import { AclPolicyService } from './acl-policy-service.ts';
import type { OperationsStore } from './operations.ts';
import { MemoryStoreError } from './types.ts';

function makeAclPolicyRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    name: 'projects/p/locations/us-central1/aclPolicies/policy-1',
    state: 'ACTIVE',
    rules: JSON.stringify([{ username: 'alice', rule: 'on >secret ~* +@all' }]),
    etag: 'etag-1',
    instanceAclPolicyAttachments: null,
    ...overrides,
  };
}

function makeAclPolicyRevisionRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rev-row-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    name: 'projects/p/locations/us-central1/aclPolicies/policy-1/revisions/1',
    revisionNumber: '1',
    attachedInstances: JSON.stringify(['projects/p/locations/us-central1/instances/i']),
    snapshot: JSON.stringify(makeAclPolicyRecord()),
    ...overrides,
  };
}

describe('AclPolicyService', () => {
  let repo: AclPolicyRepository;
  let operationsStore: OperationsStore;
  let service: AclPolicyService;

  beforeEach(() => {
    repo = {
      createAclPolicy: mock(() => Promise.resolve(makeAclPolicyRecord())),
      getAclPolicyByName: mock(() => Promise.resolve(null)),
      listAclPolicies: mock(() =>
        Promise.resolve({ aclPolicies: [makeAclPolicyRecord()], nextPageToken: '1' })
      ),
      updateAclPolicy: mock(() => Promise.resolve(makeAclPolicyRecord())),
      deleteAclPolicy: mock(() => Promise.resolve(true)),
      createRevision: mock(() => Promise.resolve()),
      countRevisionsForPolicy: mock(() => Promise.resolve(0)),
      getRevisionByName: mock(() => Promise.resolve(makeAclPolicyRevisionRecord())),
      listRevisions: mock(() =>
        Promise.resolve({ revisions: [makeAclPolicyRevisionRecord()], nextPageToken: undefined })
      ),
    } as unknown as AclPolicyRepository;

    operationsStore = {
      createOperation: mock((_p: string, _l: string, target: string, verb: string) =>
        Promise.resolve({
          name: 'projects/p/locations/us-central1/operations/op-1',
          metadata: {
            '@type': 'type.googleapis.com/google.cloud.memorystore.v1.OperationMetadata',
            createTime: '2026-01-01T00:00:00.000Z',
            endTime: '2026-01-01T00:00:00.000Z',
            target,
            verb,
            apiVersion: 'v1',
          },
          done: true,
        })
      ),
    } as unknown as OperationsStore;

    service = new AclPolicyService(repo, operationsStore);
  });

  test('createAclPolicy_returnsTheBareAclPolicyResourceNotAnOperation', async () => {
    const result = await service.createAclPolicy('p', 'us-central1', 'policy-1', {
      rules: [{ username: 'alice', rule: 'on >secret ~* +@all' }],
    });

    expect(result).not.toHaveProperty('done');
    expect(result).not.toHaveProperty('metadata');
    expect(result.name).toBe('projects/p/locations/us-central1/aclPolicies/policy-1');
    expect(operationsStore.createOperation).not.toHaveBeenCalled();
  });

  test('createAclPolicy_snapshotsANewRevision', async () => {
    await service.createAclPolicy('p', 'us-central1', 'policy-1', {
      rules: [{ username: 'alice', rule: 'on >secret ~* +@all' }],
    });

    expect(repo.createRevision).toHaveBeenCalled();
  });

  test('createAclPolicy_givenDuplicateAclPolicyId_throwsAlreadyExists', async () => {
    (repo.getAclPolicyByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeAclPolicyRecord())
    );

    const promise = service.createAclPolicy('p', 'us-central1', 'policy-1', { rules: [] });

    await expect(promise).rejects.toBeInstanceOf(MemoryStoreError);
    await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
  });

  test('updateAclPolicy_returnsAnOperationNotABareResource', async () => {
    (repo.getAclPolicyByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeAclPolicyRecord())
    );

    const result = await service.updateAclPolicy(
      'projects/p/locations/us-central1/aclPolicies/policy-1',
      { rules: [{ username: 'bob', rule: 'on >secret ~* +@all' }] },
      'rules'
    );

    expect(result).toHaveProperty('done', true);
    expect(result).toHaveProperty('metadata');
  });

  test('updateAclPolicy_whenRulesActuallyChange_snapshotsANewRevision', async () => {
    (repo.getAclPolicyByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeAclPolicyRecord())
    );

    await service.updateAclPolicy(
      'projects/p/locations/us-central1/aclPolicies/policy-1',
      { rules: [{ username: 'bob', rule: 'on >secret ~* +@all' }] },
      'rules'
    );

    expect(repo.createRevision).toHaveBeenCalled();
  });

  test('updateAclPolicy_givenANoOpPatchThatChangesNothing_doesNotMintARedundantRevision', async () => {
    (repo.getAclPolicyByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeAclPolicyRecord())
    );

    await service.updateAclPolicy('projects/p/locations/us-central1/aclPolicies/policy-1', {});

    expect(repo.createRevision).not.toHaveBeenCalled();
  });

  test('updateAclPolicy_givenAnUpdateMaskNamingAnUnknownField_throwsInvalidArgument', async () => {
    (repo.getAclPolicyByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeAclPolicyRecord())
    );

    const promise = service.updateAclPolicy(
      'projects/p/locations/us-central1/aclPolicies/policy-1',
      { rules: [{ username: 'bob', rule: 'on >secret ~* +@all' }] },
      'unknownField'
    );

    await expect(promise).rejects.toBeInstanceOf(MemoryStoreError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('updateAclPolicy_givenMissingAclPolicy_throwsNotFound', async () => {
    const promise = service.updateAclPolicy(
      'projects/p/locations/us-central1/aclPolicies/missing',
      { rules: [] },
      'rules'
    );

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('deleteAclPolicy_returnsAnOperation', async () => {
    (repo.getAclPolicyByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeAclPolicyRecord())
    );

    const result = await service.deleteAclPolicy(
      'projects/p/locations/us-central1/aclPolicies/policy-1'
    );

    expect(result).toHaveProperty('done', true);
  });

  test('deleteAclPolicy_givenMismatchedEtag_throwsAbortedPerTheDiscoveryDocument', async () => {
    (repo.getAclPolicyByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeAclPolicyRecord({ etag: 'etag-current' }))
    );

    const promise = service.deleteAclPolicy(
      'projects/p/locations/us-central1/aclPolicies/policy-1',
      'etag-stale'
    );

    await expect(promise).rejects.toBeInstanceOf(MemoryStoreError);
    await expect(promise).rejects.toHaveProperty('code', 'ABORTED');
  });

  test('listAclPolicies_mapsRecordsToTheAclPolicyRevisionsResponseEnvelopeUnderAclPoliciesKey', async () => {
    const result = await service.listAclPolicies('p', 'us-central1', 10, '0');

    expect(repo.listAclPolicies).toHaveBeenCalledWith('p', 'us-central1', 10, '0');
    expect(result.aclPolicies[0]?.name).toBe(
      'projects/p/locations/us-central1/aclPolicies/policy-1'
    );
    expect(result.aclPolicies[0]?.rules).toEqual([
      { username: 'alice', rule: 'on >secret ~* +@all' },
    ]);
    expect(result.nextPageToken).toBe('1');
  });

  test('listAclPolicyRevisions_mapsRepositoryRecordsToTheAclPolicyRevisionsEnvelopeKey', async () => {
    const result = await service.listAclPolicyRevisions(
      'projects/p/locations/us-central1/aclPolicies/policy-1'
    );

    expect(repo.listRevisions).toHaveBeenCalledWith(
      'projects/p/locations/us-central1/aclPolicies/policy-1',
      undefined,
      undefined
    );

    // Pins the envelope-key RENAME (`revisions` on the repository record ->
    // `aclPolicyRevisions` on the wire) and the record->response mapping,
    // rather than a bare toHaveBeenCalled() that any shape would satisfy.
    expect('aclPolicyRevisions' in result).toBe(true);
    expect(result.aclPolicyRevisions[0]?.name).toBe(
      'projects/p/locations/us-central1/aclPolicies/policy-1/revisions/1'
    );
    expect(result.aclPolicyRevisions[0]?.attachedInstances).toEqual([
      'projects/p/locations/us-central1/instances/i',
    ]);
    expect(result.aclPolicyRevisions[0]?.snapshot).toEqual(
      expect.objectContaining({ name: 'projects/p/locations/us-central1/aclPolicies/policy-1' })
    );
  });
});
