/**
 * Unit tests for InstanceService
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { BackupRepository } from './backup-repository.ts';
import type { InstanceRepository } from './instance-repository.ts';
import { InstanceService } from './instance-service.ts';
import type { OperationsStore } from './operations.ts';
import { ResourceMutex } from './resource-mutex.ts';
import type { TokenAuthRepository } from './token-auth-repository.ts';
import { MemoryStoreError } from './types.ts';
import type { ValkeyProcessManager } from './valkey-process-manager.ts';

function makeInstanceRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    name: 'projects/p/locations/us-central1/instances/i',
    uid: 'uid-1',
    state: 'ACTIVE',
    replicaCount: 0,
    shardCount: 1,
    nodeType: 'NODE_TYPE_UNSPECIFIED',
    mode: 'STANDALONE',
    authorizationMode: 'AUTH_DISABLED',
    transitEncryptionMode: 'TRANSIT_ENCRYPTION_DISABLED',
    engineVersion: null,
    labels: null,
    nodeConfig: JSON.stringify({ sizeGb: 1 }),
    stateInfo: null,
    discoveryEndpoints: JSON.stringify([{ address: '127.0.0.1', port: 7000 }]),
    pscAttachmentDetails: null,
    backupCollection: null,
    aclPolicy: null,
    aclPolicyInfo: null,
    aclPolicyInSync: 0,
    endpoints: null,
    maintenanceSchedule: null,
    migrationConfig: null,
    encryptionInfo: null,
    satisfiesPzi: 0,
    satisfiesPzs: 0,
    availableMaintenanceVersions: null,
    effectiveMaintenanceVersion: null,
    deletionProtectionEnabled: 0,
    engineConfigs: null,
    zoneDistributionConfig: null,
    persistenceConfig: null,
    automatedBackupConfig: null,
    maintenancePolicy: null,
    crossInstanceReplicationConfig: null,
    ...overrides,
  };
}

// Stands in for what the repository hands back after a write: the caller's own
// payload plus the columns storage owns, which is what the service turns into
// the operation's `response`.
function makeBackupRecord(data: Record<string, unknown>) {
  return {
    id: 'backup-row-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...data,
  };
}

function makeTokenAuthUserRecord(data: Record<string, unknown>) {
  return {
    id: 'token-auth-user-row-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...data,
  };
}

describe('InstanceService', () => {
  let repo: InstanceRepository;
  let operationsStore: OperationsStore;
  let valkeyProcessManager: ValkeyProcessManager;
  let backupRepository: BackupRepository;
  let tokenAuthRepository: TokenAuthRepository;
  let service: InstanceService;

  beforeEach(() => {
    repo = {
      createInstance: mock(() => Promise.resolve(makeInstanceRecord())),
      getInstanceByName: mock(() => Promise.resolve(null)),
      listInstances: mock(() => Promise.resolve({ instances: [] })),
      updateInstance: mock(() => Promise.resolve(makeInstanceRecord())),
      deleteInstance: mock(() => Promise.resolve(true)),
    } as unknown as InstanceRepository;

    operationsStore = {
      createOperation: mock(
        (
          _p: string,
          _l: string,
          target: string,
          verb: string,
          _resourceType: string,
          response?: Record<string, unknown>
        ) =>
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
            ...(response ? { response } : {}),
          })
      ),
    } as unknown as OperationsStore;

    valkeyProcessManager = {
      startServerForInstance: mock(() => Promise.resolve({ address: '127.0.0.1', port: 7000 })),
      stopServerForInstance: mock(() => Promise.resolve()),
    } as unknown as ValkeyProcessManager;

    backupRepository = {
      createBackupCollectionIfMissing: mock(() => Promise.resolve(true)),
      deleteBackupCollection: mock(() => Promise.resolve(true)),
      createBackup: mock((data: Record<string, unknown>) =>
        Promise.resolve(makeBackupRecord(data))
      ),
      getBackupByName: mock(() => Promise.resolve(null)),
    } as unknown as BackupRepository;

    tokenAuthRepository = {
      createTokenAuthUser: mock((data: Record<string, unknown>) =>
        Promise.resolve(makeTokenAuthUserRecord(data))
      ),
      deleteTokenAuthUsersForInstance: mock(() => Promise.resolve([])),
      getTokenAuthUserByName: mock(() => Promise.resolve(null)),
    } as unknown as TokenAuthRepository;

    service = new InstanceService(
      repo,
      operationsStore,
      valkeyProcessManager,
      backupRepository,
      tokenAuthRepository,
      new ResourceMutex()
    );
  });

  describe('createInstance', () => {
    test('createInstance_givenTwoConcurrentCallsForTheSameName_letsOneWinAndFailsTheOtherWithoutTearingDownTheWinnersServer', async () => {
      let persisted: unknown = null;

      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(persisted)
      );
      (repo.createInstance as ReturnType<typeof mock>).mockImplementation(() => {
        persisted = makeInstanceRecord();

        return Promise.resolve(persisted);
      });

      const [first, second] = await Promise.allSettled([
        service.createInstance('p', 'us-central1', 'cache1', {}),
        service.createInstance('p', 'us-central1', 'cache1', {}),
      ]);

      const statuses = [first.status, second.status].sort();

      expect(statuses).toEqual(['fulfilled', 'rejected']);

      const rejected = (first.status === 'rejected' ? first : second) as PromiseRejectedResult;

      expect(rejected.reason).toBeInstanceOf(MemoryStoreError);
      expect(rejected.reason).toHaveProperty('code', 'ALREADY_EXISTS');

      // The loser must bail at the existence check, so exactly one server is
      // spawned and the winner's live server is never torn down by a rollback.
      expect(valkeyProcessManager.startServerForInstance).toHaveBeenCalledTimes(1);
      expect(valkeyProcessManager.stopServerForInstance).not.toHaveBeenCalled();
    });

    test('createInstance_whenRepositoryPersistFails_stopsTheSpawnedServerAndRethrows', async () => {
      const failure = new Error('storage down');

      (repo.createInstance as ReturnType<typeof mock>).mockImplementationOnce(() =>
        Promise.reject(failure)
      );

      const promise = service.createInstance('p', 'us-central1', 'cache1', {});

      await expect(promise).rejects.toBe(failure);
      expect(valkeyProcessManager.stopServerForInstance).toHaveBeenCalledWith(
        'projects/p/locations/us-central1/instances/cache1'
      );
    });

    test('createInstance_whenBackupCollectionMaterialisationFails_stopsTheSpawnedServerAndRethrows', async () => {
      const failure = new Error('backup collection write failed');

      (
        backupRepository.createBackupCollectionIfMissing as ReturnType<typeof mock>
      ).mockImplementationOnce(() => Promise.reject(failure));

      const promise = service.createInstance('p', 'us-central1', 'cache1', {});

      await expect(promise).rejects.toBe(failure);
      expect(valkeyProcessManager.stopServerForInstance).toHaveBeenCalledWith(
        'projects/p/locations/us-central1/instances/cache1'
      );
    });

    test('createInstance_whenBackupCollectionMaterialisationFails_deletesThePersistedRowSoARetryIsNotAlreadyExists', async () => {
      const failure = new Error('backup collection write failed');

      (
        backupRepository.createBackupCollectionIfMissing as ReturnType<typeof mock>
      ).mockImplementationOnce(() => Promise.reject(failure));

      const promise = service.createInstance('p', 'us-central1', 'cache1', {});

      await expect(promise).rejects.toBe(failure);

      // Without this the row survives a failed create, so the retry 409s and
      // getInstance reports an instance the caller was told failed to create.
      expect(repo.deleteInstance).toHaveBeenCalledWith(
        'projects/p/locations/us-central1/instances/cache1'
      );
    });

    test('createInstance_whenOperationCreationFails_stillRollsBackTheRowAndTheServer', async () => {
      const failure = new Error('operations store unavailable');

      (operationsStore.createOperation as ReturnType<typeof mock>).mockImplementationOnce(() =>
        Promise.reject(failure)
      );

      const promise = service.createInstance('p', 'us-central1', 'cache1', {});

      // A bare `return promise` inside the try never routes a rejection to the
      // catch, so this last step used to escape rollback entirely.
      await expect(promise).rejects.toBe(failure);
      expect(repo.deleteInstance).toHaveBeenCalledWith(
        'projects/p/locations/us-central1/instances/cache1'
      );
      expect(valkeyProcessManager.stopServerForInstance).toHaveBeenCalledWith(
        'projects/p/locations/us-central1/instances/cache1'
      );
    });

    test('createInstance_whenOperationCreationFails_deletesTheBackupCollectionThisCreateMaterialised', async () => {
      (operationsStore.createOperation as ReturnType<typeof mock>).mockImplementationOnce(() =>
        Promise.reject(new Error('operations store unavailable'))
      );

      await expect(service.createInstance('p', 'us-central1', 'cache1', {})).rejects.toThrow(
        'operations store unavailable'
      );

      // A surviving collection is reused by the retry, which then stays pinned
      // to the failed create's instanceUid rather than the new instance's.
      expect(backupRepository.deleteBackupCollection).toHaveBeenCalledWith(
        'projects/p/locations/us-central1/backupCollections/cache1'
      );
    });

    test('createInstance_whenTheCollectionAlreadyExisted_leavesItInPlaceSoAnEarlierInstancesBackupsSurvive', async () => {
      (
        backupRepository.createBackupCollectionIfMissing as ReturnType<typeof mock>
      ).mockImplementationOnce(() => Promise.resolve(false));

      (operationsStore.createOperation as ReturnType<typeof mock>).mockImplementationOnce(() =>
        Promise.reject(new Error('operations store unavailable'))
      );

      await expect(service.createInstance('p', 'us-central1', 'cache1', {})).rejects.toThrow(
        'operations store unavailable'
      );

      expect(backupRepository.deleteBackupCollection).not.toHaveBeenCalled();
    });

    test('createInstance_whenThePersistItselfFails_doesNotAttemptToDeleteARowThatWasNeverCreated', async () => {
      (repo.createInstance as ReturnType<typeof mock>).mockImplementationOnce(() =>
        Promise.reject(new Error('storage down'))
      );

      await expect(service.createInstance('p', 'us-central1', 'cache1', {})).rejects.toThrow(
        'storage down'
      );

      expect(repo.deleteInstance).not.toHaveBeenCalled();
    });

    test('createInstance_populatesServerSetFieldsAndIgnoresClientSuppliedOnes', async () => {
      const createInstanceSpy = repo.createInstance as ReturnType<typeof mock>;

      await service.createInstance('p', 'us-central1', 'cache1', {
        uid: 'spoofed-uid',
        state: 'DELETING',
        nodeConfig: { sizeGb: 999 },
        discoveryEndpoints: [{ address: '9.9.9.9', port: 1 }],
        backupCollection: 'projects/p/locations/us-central1/backupCollections/spoofed',
        replicaCount: 2,
      });

      expect(createInstanceSpy).toHaveBeenCalled();
      const persisted = createInstanceSpy.mock.calls[0]?.[0] as Record<string, unknown>;

      // Positive assertions: a service that forgets to populate a
      // server-set field (leaving it `undefined`) must fail these, unlike
      // `not.toBe('spoofed-value')`, which an undefined field also satisfies.
      expect(persisted.uid).toMatch(/^[0-9a-f-]{36}$/);
      expect(persisted.state).toBe('ACTIVE');
      expect(persisted.backupCollection).toBe(
        'projects/p/locations/us-central1/backupCollections/cache1'
      );
      // The endpoint the mocked ValkeyProcessManager reports must reach the
      // persisted record, proving the spoofed 9.9.9.9/1 was overwritten
      // rather than merely differing from it by coincidence.
      expect(JSON.parse(persisted.discoveryEndpoints as string)).toEqual([
        { address: '127.0.0.1', port: 7000 },
      ]);
      expect(JSON.parse(persisted.nodeConfig as string)).not.toEqual({ sizeGb: 999 });
      expect(persisted.replicaCount).toBe(2);
    });

    test('createInstance_asksValkeyProcessManagerForAnEndpointAndPersistsItsResult', async () => {
      const createInstanceSpy = repo.createInstance as ReturnType<typeof mock>;

      await service.createInstance('p', 'us-central1', 'cache1', {});

      expect(valkeyProcessManager.startServerForInstance).toHaveBeenCalledWith(
        'projects/p/locations/us-central1/instances/cache1'
      );

      const persisted = createInstanceSpy.mock.calls[0]?.[0] as Record<string, unknown>;

      expect(JSON.parse(persisted.discoveryEndpoints as string)).toEqual([
        { address: '127.0.0.1', port: 7000 },
      ]);
    });

    test('createInstance_returnsAnOperationThatIsAlreadyDone', async () => {
      const op = await service.createInstance('p', 'us-central1', 'cache1', {});

      expect(op.done).toBe(true);
      expect(op.metadata.verb).toBe('create');
    });

    test.each([
      ['abc', 'shorter than the 4-character minimum'],
      ['a'.repeat(64), 'longer than the 63-character maximum'],
      ['-leading', 'begins with a hyphen'],
      ['trailing-', 'ends with a hyphen'],
      ['under_score', 'contains a character outside [a-z0-9-]'],
      ['cacheA', 'contains an uppercase character'],
    ])('createInstance_givenInstanceIdThat%s_throwsInvalidArgumentWithoutPersisting', async instanceId => {
      const promise = service.createInstance('p', 'us-central1', instanceId, {});

      await expect(promise).rejects.toBeInstanceOf(MemoryStoreError);
      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
      expect(repo.createInstance).not.toHaveBeenCalled();
      expect(valkeyProcessManager.startServerForInstance).not.toHaveBeenCalled();
    });

    test('createInstance_givenDuplicateInstance_throwsAlreadyExistsWithoutPersisting', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );

      const promise = service.createInstance('p', 'us-central1', 'cache1', {});

      await expect(promise).rejects.toBeInstanceOf(MemoryStoreError);
      await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
      expect(repo.createInstance).not.toHaveBeenCalled();
    });
  });

  describe('getInstance', () => {
    test('getInstance_givenExistingInstance_returnsInstanceResponse', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );

      const instance = await service.getInstance('projects/p/locations/us-central1/instances/i');

      expect(instance.name).toBe('projects/p/locations/us-central1/instances/i');
      expect(instance.state).toBe('ACTIVE');
    });

    test('getInstance_givenMissingInstance_throwsNotFound', async () => {
      const promise = service.getInstance('projects/p/locations/us-central1/instances/missing');

      await expect(promise).rejects.toBeInstanceOf(MemoryStoreError);
      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });
  });

  describe('updateInstance', () => {
    /**
     * InstanceRecord stores booleans as 0/1 and every reader compares `=== 1`,
     * so persisting a raw `true` here reads back as `false` — which silently
     * turned deletion protection OFF for anyone who enabled it via PATCH.
     */
    test('updateInstance_givenBooleanField_persistsItAsTheZeroOrOneTheRecordStores', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );

      const updateInstanceSpy = repo.updateInstance as ReturnType<typeof mock>;

      await service.updateInstance(
        'projects/p/locations/us-central1/instances/i',
        { deletionProtectionEnabled: true },
        'deletionProtectionEnabled'
      );

      const updates = updateInstanceSpy.mock.calls[0]?.[1] as Record<string, unknown>;

      expect(updates.deletionProtectionEnabled).toBe(1);
    });

    // `endpoints` is a json column, so an unstringified array round-trips as a
    // JSON.parse failure and the field disappears from the GET response.
    test('updateInstance_givenJsonBackedField_persistsItSerialized', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );

      const updateInstanceSpy = repo.updateInstance as ReturnType<typeof mock>;
      const endpoints = [{ connections: [] }];

      await service.updateInstance(
        'projects/p/locations/us-central1/instances/i',
        { endpoints },
        'endpoints'
      );

      const updates = updateInstanceSpy.mock.calls[0]?.[1] as Record<string, unknown>;

      expect(updates.endpoints).toBe(JSON.stringify(endpoints));
    });

    test('updateInstance_restrictsChangesToFieldsListedInUpdateMask', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );

      const updateInstanceSpy = repo.updateInstance as ReturnType<typeof mock>;

      await service.updateInstance(
        'projects/p/locations/us-central1/instances/i',
        { replicaCount: 4, shardCount: 9 },
        'replicaCount'
      );

      const updates = updateInstanceSpy.mock.calls[0]?.[1] as Record<string, unknown>;

      expect(updates.replicaCount).toBe(4);
      expect(updates.shardCount).toBeUndefined();
    });

    test('updateInstance_givenMissingInstance_throwsNotFound', async () => {
      const promise = service.updateInstance(
        'projects/p/locations/us-central1/instances/missing',
        { replicaCount: 4 },
        'replicaCount'
      );

      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });

    test('updateInstance_updateMaskContainsName_rejectsInsteadOfRenaming', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );

      const promise = service.updateInstance(
        'projects/p/locations/us-central1/instances/i',
        { name: 'projects/victim-project/locations/us-central1/instances/prod' },
        'name'
      );

      await expect(promise).rejects.toBeInstanceOf(MemoryStoreError);
      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
      expect(repo.updateInstance).not.toHaveBeenCalled();
    });

    test('updateInstance_updateMaskNamesModeAndEndpoints_appliesThemInsteadOfRejectingAsUnknown', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );

      const updateInstanceSpy = repo.updateInstance as ReturnType<typeof mock>;

      await service.updateInstance(
        'projects/p/locations/us-central1/instances/i',
        { mode: 'CLUSTER' },
        'mode'
      );

      const updates = updateInstanceSpy.mock.calls[0]?.[1] as Record<string, unknown>;

      expect(updates.mode).toBe('CLUSTER');
    });

    test('updateInstance_updateMaskNamesARealButUnmodeledField_isAcceptedButHasNoPersistedEffect', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );

      const updateInstanceSpy = repo.updateInstance as ReturnType<typeof mock>;

      const promise = service.updateInstance(
        'projects/p/locations/us-central1/instances/i',
        { kmsKey: 'projects/p/locations/us-central1/keyRings/r/cryptoKeys/k' },
        'kmsKey'
      );

      await expect(promise).resolves.toBeDefined();

      const updates = updateInstanceSpy.mock.calls[0]?.[1] as Record<string, unknown>;

      expect(updates.kmsKey).toBeUndefined();
    });

    test('updateInstance_updateMaskNamesANestedPath_appliesTheWholeRootFieldInsteadOfRejectingIt', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );

      const updateInstanceSpy = repo.updateInstance as ReturnType<typeof mock>;

      await service.updateInstance(
        'projects/p/locations/us-central1/instances/i',
        { persistenceConfig: { mode: 'AOF' } },
        'persistenceConfig.mode'
      );

      const updates = updateInstanceSpy.mock.calls[0]?.[1] as Record<string, unknown>;

      expect(JSON.parse(updates.persistenceConfig as string)).toEqual({ mode: 'AOF' });
    });

    test('updateInstance_updateMaskIsWildcard_rejectsWithAnExplicitUnsupportedMessageInsteadOfUnknownField', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );

      const promise = service.updateInstance(
        'projects/p/locations/us-central1/instances/i',
        { labels: { team: 'payments' } },
        '*'
      );

      await expect(promise).rejects.toBeInstanceOf(MemoryStoreError);
      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
      await expect(promise).rejects.toThrow(/wildcard/);
      expect(repo.updateInstance).not.toHaveBeenCalled();
    });

    test('updateInstance_updateMaskContainsReadOnlyField_rejectsDiscoveryEndpointsUidAndState', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );

      const discoveryEndpointsPromise = service.updateInstance(
        'projects/p/locations/us-central1/instances/i',
        { discoveryEndpoints: [{ address: '10.0.0.66', port: 6379 }] },
        'discoveryEndpoints'
      );

      await expect(discoveryEndpointsPromise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');

      const stateAndUidPromise = service.updateInstance(
        'projects/p/locations/us-central1/instances/i',
        { state: 'DELETING', uid: 'attacker-uid' },
        'state,uid'
      );

      await expect(stateAndUidPromise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
      expect(repo.updateInstance).not.toHaveBeenCalled();
    });

    test('updateInstance_readOnlyFieldInBody_isIgnoredWhenNoUpdateMaskGiven', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );

      const updateInstanceSpy = repo.updateInstance as ReturnType<typeof mock>;

      // Simulates a read-modify-write PATCH: the client GETs the instance,
      // tweaks a label, and PATCHes the full resource back without an
      // updateMask. Read-only fields present in that body must not persist.
      await service.updateInstance(
        'projects/p/locations/us-central1/instances/i',
        {
          name: 'projects/victim-project/locations/us-central1/instances/prod',
          uid: 'attacker-uid',
          state: 'DELETING',
          discoveryEndpoints: [{ address: '10.0.0.66', port: 6379 }],
          labels: { team: 'payments' },
        },
        undefined
      );

      const updates = updateInstanceSpy.mock.calls[0]?.[1] as Record<string, unknown>;

      expect(updates.name).toBeUndefined();
      expect(updates.uid).toBeUndefined();
      expect(updates.state).toBeUndefined();
      expect(updates.discoveryEndpoints).toBeUndefined();
      expect(JSON.parse(updates.labels as string)).toEqual({ team: 'payments' });
    });
  });

  describe('deleteInstance', () => {
    test('deleteInstance_stopsTheValkeyProcessAndRemovesTheInstanceRowAndReturnsADoneOperation', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );

      const op = await service.deleteInstance('projects/p/locations/us-central1/instances/i');

      // Call-argument assertions, not just toHaveBeenCalled(): a service that
      // tears down the process/mints the Operation but forgets to remove the
      // row (or removes the wrong name) must fail here.
      expect(valkeyProcessManager.stopServerForInstance).toHaveBeenCalledWith(
        'projects/p/locations/us-central1/instances/i'
      );
      expect(repo.deleteInstance).toHaveBeenCalledWith(
        'projects/p/locations/us-central1/instances/i'
      );
      expect(op.done).toBe(true);
      expect(op.metadata.verb).toBe('delete');
    });

    test('deleteInstance_givenMissingInstance_throwsNotFound', async () => {
      const promise = service.deleteInstance('projects/p/locations/us-central1/instances/missing');

      await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
    });

    test('deleteInstance_givenDeletionProtectionEnabled_rejectsInsteadOfDeletingTheInstance', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord({ deletionProtectionEnabled: 1 }))
      );

      const promise = service.deleteInstance('projects/p/locations/us-central1/instances/i');

      await expect(promise).rejects.toBeInstanceOf(MemoryStoreError);
      await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
      expect(valkeyProcessManager.stopServerForInstance).not.toHaveBeenCalled();
      expect(repo.deleteInstance).not.toHaveBeenCalled();
    });

    test('deleteInstance_whenRemovingTheRowFails_leavesTheDataPlaneRunningSoTheSurvivingInstanceStillMatchesItsEndpoint', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );
      (repo.deleteInstance as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.reject(new Error('storage down'))
      );

      const promise = service.deleteInstance('projects/p/locations/us-central1/instances/i');

      await expect(promise).rejects.toThrow('storage down');

      // A failed delete must not leave an ACTIVE row advertising a port nothing
      // is listening on: the endpoint is a promise to whoever reads the instance
      // next, and a retry cannot un-tell them.
      expect(valkeyProcessManager.stopServerForInstance).not.toHaveBeenCalled();
    });

    test('deleteInstance_whenTokenAuthCleanupFails_leavesTheDataPlaneRunningAndTheInstanceIntact', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );
      (
        tokenAuthRepository.deleteTokenAuthUsersForInstance as ReturnType<typeof mock>
      ).mockImplementation(() => Promise.reject(new Error('token cleanup failed')));

      const promise = service.deleteInstance('projects/p/locations/us-central1/instances/i');

      await expect(promise).rejects.toThrow('token cleanup failed');
      expect(valkeyProcessManager.stopServerForInstance).not.toHaveBeenCalled();
      expect(repo.deleteInstance).not.toHaveBeenCalled();
    });

    test('deleteInstance_whenACreateForTheSameNameIsStillInFlight_waitsForThatCreateToFinishFirst', async () => {
      let persisted: unknown = null;
      let signalCreateIsPersisting = () => {};
      let releaseCreate = () => {};

      const createIsPersisting = new Promise<void>(resolve => {
        signalCreateIsPersisting = resolve;
      });
      const createReleased = new Promise<void>(resolve => {
        releaseCreate = resolve;
      });

      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(persisted)
      );
      // Parks the create with its row already persisted and its server already
      // spawned — exactly the window a concurrent delete used to slip into.
      (repo.createInstance as ReturnType<typeof mock>).mockImplementation(async () => {
        persisted = makeInstanceRecord({
          name: 'projects/p/locations/us-central1/instances/cache1',
        });
        signalCreateIsPersisting();
        await createReleased;

        return persisted;
      });

      const create = service.createInstance('p', 'us-central1', 'cache1', {});

      await createIsPersisting;

      const remove = service.deleteInstance('projects/p/locations/us-central1/instances/cache1');

      // A macrotask, so every microtask an unserialized delete would need to
      // reach the repository has already had its chance to run.
      await Bun.sleep(5);

      expect(repo.deleteInstance).not.toHaveBeenCalled();
      expect(valkeyProcessManager.stopServerForInstance).not.toHaveBeenCalled();

      releaseCreate();

      const operation = await create;

      await remove;

      expect(operation.metadata.verb).toBe('create');
      expect(repo.deleteInstance).toHaveBeenCalledWith(
        'projects/p/locations/us-central1/instances/cache1'
      );
    });
  });

  describe('backupInstance', () => {
    test('backupInstance_createsTheImpliedBackupCollectionAndABackupRecordUnderThatCollection', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );

      await service.backupInstance('projects/p/locations/us-central1/instances/i', {});

      // Assert the derived collection NAME, not just that some call happened
      // — a service that creates a collection/backup under the wrong (or an
      // empty) name would otherwise still pass.
      expect(backupRepository.createBackupCollectionIfMissing).toHaveBeenCalledWith(
        'projects/p/locations/us-central1/backupCollections/i',
        'projects/p/locations/us-central1/instances/i',
        'uid-1'
      );

      const createBackupSpy = backupRepository.createBackup as ReturnType<typeof mock>;
      const persistedBackup = createBackupSpy.mock.calls[0]?.[0] as Record<string, unknown>;

      expect(persistedBackup.name as string).toMatch(
        /^projects\/p\/locations\/us-central1\/backupCollections\/i\/backups\/.+$/
      );
      expect(persistedBackup.instance).toBe('projects/p/locations/us-central1/instances/i');
    });

    test('backupInstance_givenABackupIdThatAlreadyExists_throwsAlreadyExistsNamingTheBackup', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );
      (backupRepository.getBackupByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve({ name: 'projects/p/locations/us-central1/backupCollections/i/backups/b' })
      );

      const promise = service.backupInstance('projects/p/locations/us-central1/instances/i', {
        backupId: 'b',
      });

      await expect(promise).rejects.toBeInstanceOf(MemoryStoreError);
      await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
      // Without this, the 409 body would report the route's resource
      // ("Instance") rather than the Backup that actually conflicted.
      await expect(promise).rejects.toHaveProperty('resourceType', 'Backup');
    });

    test('backupInstance_givenABackupIdThatAlreadyExists_persistsNeitherTheBackupNorTheCollection', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );
      (backupRepository.getBackupByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve({ name: 'projects/p/locations/us-central1/backupCollections/i/backups/b' })
      );

      const promise = service.backupInstance('projects/p/locations/us-central1/instances/i', {
        backupId: 'b',
      });

      await expect(promise).rejects.toBeInstanceOf(MemoryStoreError);
      expect(backupRepository.createBackup).not.toHaveBeenCalled();
      expect(backupRepository.createBackupCollectionIfMissing).not.toHaveBeenCalled();
    });

    test('backupInstance_returnsTheCreatedBackupAsTheOperationResponse', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );

      const op = await service.backupInstance('projects/p/locations/us-central1/instances/i', {
        backupId: 'b',
      });

      // Awaiting a done LRO is how a client learns what was created; without the
      // resource on `response` the Backup's name and uid are unreachable from
      // the create path.
      expect(op.response?.name).toBe(
        'projects/p/locations/us-central1/backupCollections/i/backups/b'
      );
      expect(op.response?.instance).toBe('projects/p/locations/us-central1/instances/i');
    });
  });

  describe('startMigration, finishMigration and rescheduleMaintenance', () => {
    beforeEach(() => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );
    });

    test('startMigration_returnsTheInstanceAsTheOperationResponse', async () => {
      const op = await service.startMigration('projects/p/locations/us-central1/instances/i', {});

      expect(op.metadata.verb).toBe('startMigration');
      expect(op.response?.name).toBe('projects/p/locations/us-central1/instances/i');
    });

    test('finishMigration_returnsTheInstanceAsTheOperationResponse', async () => {
      const op = await service.finishMigration('projects/p/locations/us-central1/instances/i', {});

      expect(op.metadata.verb).toBe('finishMigration');
      expect(op.response?.name).toBe('projects/p/locations/us-central1/instances/i');
    });

    test('rescheduleMaintenance_returnsTheInstanceAsTheOperationResponse', async () => {
      const op = await service.rescheduleMaintenance(
        'projects/p/locations/us-central1/instances/i',
        { rescheduleType: 'IMMEDIATE' }
      );

      expect(op.metadata.verb).toBe('rescheduleMaintenance');
      expect(op.response?.name).toBe('projects/p/locations/us-central1/instances/i');
    });
  });

  describe('addTokenAuthUser', () => {
    test('addTokenAuthUser_givenExistingInstance_persistsTheFullyQualifiedTokenAuthUserAndReturnsADoneOperation', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );

      const op = await service.addTokenAuthUser('projects/p/locations/us-central1/instances/i', {
        tokenAuthUser: 'u',
      });

      const createTokenAuthUserSpy = tokenAuthRepository.createTokenAuthUser as ReturnType<
        typeof mock
      >;
      const persisted = createTokenAuthUserSpy.mock.calls[0]?.[0] as Record<string, unknown>;

      // Pins the fully-qualified name under the instance, not the bare `u`
      // the client can supply — a service that persists the client value
      // verbatim would otherwise still pass a bare toHaveBeenCalled() check.
      expect(persisted.name).toBe('projects/p/locations/us-central1/instances/i/tokenAuthUsers/u');
      expect(op.done).toBe(true);
      expect(op.metadata.verb).toBe('addTokenAuthUser');
    });

    test('addTokenAuthUser_returnsTheCreatedTokenAuthUserAsTheOperationResponse', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );

      const op = await service.addTokenAuthUser('projects/p/locations/us-central1/instances/i', {
        tokenAuthUser: 'u',
      });

      expect(op.response?.name).toBe(
        'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u'
      );
      expect(op.response?.state).toBe('ACTIVE');
    });

    test('addTokenAuthUser_givenAnEmptyBody_rejectsWithInvalidArgumentInsteadOfALeakedTypeError', async () => {
      const promise = service.addTokenAuthUser('projects/p/locations/us-central1/instances/i', {});

      await expect(promise).rejects.toBeInstanceOf(MemoryStoreError);
      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
      expect(tokenAuthRepository.createTokenAuthUser).not.toHaveBeenCalled();
    });

    test('addTokenAuthUser_givenAnEmptyTokenAuthUserObject_rejectsInsteadOfPersistingAResourceNamedUndefined', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );

      const promise = service.addTokenAuthUser('projects/p/locations/us-central1/instances/i', {
        tokenAuthUser: {},
      });

      await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
      expect(tokenAuthRepository.createTokenAuthUser).not.toHaveBeenCalled();
    });

    test('addTokenAuthUser_givenAUserThatAlreadyExists_throwsAlreadyExistsInsteadOfPersistingADuplicate', async () => {
      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(makeInstanceRecord())
      );
      (tokenAuthRepository.getTokenAuthUserByName as ReturnType<typeof mock>).mockImplementation(
        () =>
          Promise.resolve({
            name: 'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u',
          })
      );

      const promise = service.addTokenAuthUser('projects/p/locations/us-central1/instances/i', {
        tokenAuthUser: 'u',
      });

      await expect(promise).rejects.toBeInstanceOf(MemoryStoreError);
      await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
      await expect(promise).rejects.toHaveProperty('resourceType', 'TokenAuthUser');
      expect(tokenAuthRepository.createTokenAuthUser).not.toHaveBeenCalled();
    });

    test('addTokenAuthUser_whenTheInstanceIsBeingDeleted_failsInsteadOfOrphaningAUserUnderTheDeletedInstance', async () => {
      let doesInstanceExist = true;
      let signalDeleteIsPurgingUsers = () => {};
      let releaseDelete = () => {};

      const deleteIsPurgingUsers = new Promise<void>(resolve => {
        signalDeleteIsPurgingUsers = resolve;
      });
      const deleteReleased = new Promise<void>(resolve => {
        releaseDelete = resolve;
      });

      (repo.getInstanceByName as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(doesInstanceExist ? makeInstanceRecord() : null)
      );
      // Parks the delete midway through its child cleanup, which is the window
      // an unserialized addTokenAuthUser used to write into.
      (
        tokenAuthRepository.deleteTokenAuthUsersForInstance as ReturnType<typeof mock>
      ).mockImplementation(async () => {
        signalDeleteIsPurgingUsers();
        await deleteReleased;

        return [];
      });
      (repo.deleteInstance as ReturnType<typeof mock>).mockImplementation(() => {
        doesInstanceExist = false;

        return Promise.resolve(true);
      });

      const remove = service.deleteInstance('projects/p/locations/us-central1/instances/i');

      await deleteIsPurgingUsers;

      const addUser = service.addTokenAuthUser('projects/p/locations/us-central1/instances/i', {
        tokenAuthUser: 'u',
      });

      await Bun.sleep(5);

      expect(tokenAuthRepository.createTokenAuthUser).not.toHaveBeenCalled();

      releaseDelete();
      await remove;

      // The instance is gone by the time the add gets its turn, so it must 404
      // rather than persist a user whose parent no longer exists — one a later
      // instance created under the same id would inherit.
      await expect(addUser).rejects.toHaveProperty('code', 'NOT_FOUND');
      expect(tokenAuthRepository.createTokenAuthUser).not.toHaveBeenCalled();
    });
  });

  describe('listInstances', () => {
    test('listInstances_mapsRecordsToInstanceResponsesAndPropagatesNextPageToken', async () => {
      (repo.listInstances as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve({ instances: [makeInstanceRecord()], nextPageToken: '1' })
      );

      const result = await service.listInstances('p', 'us-central1', 10, '0');

      expect(repo.listInstances).toHaveBeenCalledWith('p', 'us-central1', 10, '0');

      // Parsed objects/real booleans, not raw JSON strings or 0/1 — a list
      // implementation that returns raw DB records untouched must fail here.
      expect(result.instances[0]?.nodeConfig).toEqual({ sizeGb: 1 });
      expect(result.instances[0]?.satisfiesPzi).toBe(false);
      expect(result.instances[0]?.discoveryEndpoints).toEqual([
        { address: '127.0.0.1', port: 7000 },
      ]);
      expect(result.nextPageToken).toBe('1');
    });
  });
});
