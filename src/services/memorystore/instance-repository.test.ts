/**
 * Unit tests for InstanceRepository
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { InstanceRepository } from './instance-repository.ts';
import type { InstanceRecord } from './types.ts';

function instanceData(
  overrides: Partial<Omit<InstanceRecord, keyof { id: string; createdAt: Date; updatedAt: Date }>>
): Omit<InstanceRecord, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: 'projects/p/locations/us-central1/instances/i',
    uid: crypto.randomUUID(),
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

describe('InstanceRepository', () => {
  let storage: StorageManager;
  let repo: InstanceRepository;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new InstanceRepository(storage);
    await repo.initialize();
  });

  test('initialize_calledAgainOnTheSameStorageManager_doesNotWipePreviouslyPersistedRows', async () => {
    await repo.createInstance(
      instanceData({ name: 'projects/p/locations/us-central1/instances/i' })
    );

    // Simulates a restart re-wiring a new repository instance over the same
    // StorageManager: initialize() must be idempotent (like SQLite's
    // `CREATE TABLE IF NOT EXISTS`) rather than recreating the table, or
    // every persisted instance would vanish across a restart.
    const secondRepo = new InstanceRepository(storage);
    await secondRepo.initialize();

    const found = await secondRepo.getInstanceByName(
      'projects/p/locations/us-central1/instances/i'
    );

    expect(found).not.toBeNull();
  });

  test('createInstance_persistsRecord_andRoundTripsJsonAndBooleanColumns', async () => {
    const record = await repo.createInstance(
      instanceData({
        name: 'projects/p/locations/us-central1/instances/i',
        satisfiesPzi: 1,
        deletionProtectionEnabled: 1,
      })
    );

    expect(record.id).toBeTypeOf('string');
    expect(record.createdAt).toBeInstanceOf(Date);

    // Re-read from storage rather than asserting on the create() return
    // value, so a create() that merely echoes its argument back without
    // ever calling through to StorageManager cannot pass this test.
    const persisted = await repo.getInstanceByName('projects/p/locations/us-central1/instances/i');

    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted?.nodeConfig as string)).toEqual({ sizeGb: 1 });
    expect(persisted?.satisfiesPzi).toBe(1);
    expect(persisted?.deletionProtectionEnabled).toBe(1);
  });

  test('createInstance_givenDuplicateName_rejectsWithTheUniquenessFailureAndLeavesTheOriginalRowIntact', async () => {
    const original = await repo.createInstance(
      instanceData({ name: 'projects/p/locations/us-central1/instances/i', uid: 'original-uid' })
    );

    const promise = repo.createInstance(
      instanceData({ name: 'projects/p/locations/us-central1/instances/i', uid: 'clobbering-uid' })
    );

    await expect(promise).rejects.toThrow(/name|unique|exists/i);

    // Re-read from storage rather than trusting the rejection alone, so a
    // create() that throws AFTER already clobbering the first row (or that
    // silently inserted a second row under the same name) cannot pass.
    const page = await repo.listInstances('p', 'us-central1');

    expect(page.instances).toHaveLength(1);
    expect(page.instances[0]?.uid).toBe(original.uid);
  });

  test('getInstanceByName_givenExistingInstance_returnsIt', async () => {
    await repo.createInstance(
      instanceData({ name: 'projects/p/locations/us-central1/instances/i' })
    );

    const found = await repo.getInstanceByName('projects/p/locations/us-central1/instances/i');

    expect(found?.name).toBe('projects/p/locations/us-central1/instances/i');
  });

  test('getInstanceByName_givenMissingInstance_returnsNull', async () => {
    const found = await repo.getInstanceByName(
      'projects/p/locations/us-central1/instances/missing'
    );

    expect(found).toBeNull();
  });

  test('listInstances_scopesToProjectViaLikePrefix_andDoesNotLeakOtherProjects', async () => {
    await repo.createInstance(
      instanceData({ name: 'projects/p1/locations/us-central1/instances/a' })
    );
    await repo.createInstance(
      instanceData({ name: 'projects/p1/locations/us-central1/instances/b' })
    );
    await repo.createInstance(
      instanceData({ name: 'projects/p2/locations/us-central1/instances/c' })
    );

    const result = await repo.listInstances('p1', 'us-central1');

    expect(result.instances).toHaveLength(2);
    expect(result.instances.every(i => i.name.startsWith('projects/p1/'))).toBe(true);
  });

  test('listInstances_scopesToLocation_andDoesNotLeakInstancesFromOtherRegionsInTheSameProject', async () => {
    await repo.createInstance(
      instanceData({ name: 'projects/p/locations/us-central1/instances/a' })
    );
    await repo.createInstance(
      instanceData({ name: 'projects/p/locations/europe-west1/instances/b' })
    );

    const result = await repo.listInstances('p', 'us-central1');

    expect(result.instances).toHaveLength(1);
    expect(result.instances[0]?.name).toBe('projects/p/locations/us-central1/instances/a');
  });

  test('listInstances_paginatesWithStringifiedOffsetTokens', async () => {
    await repo.createInstance(
      instanceData({ name: 'projects/p/locations/us-central1/instances/a' })
    );
    await repo.createInstance(
      instanceData({ name: 'projects/p/locations/us-central1/instances/b' })
    );

    const page1 = await repo.listInstances('p', 'us-central1', 1);

    expect(page1.instances).toHaveLength(1);
    expect(page1.nextPageToken).toBe('1');

    const page2 = await repo.listInstances('p', 'us-central1', 1, page1.nextPageToken);

    expect(page2.instances).toHaveLength(1);
    expect(page2.instances[0]?.name).not.toBe(page1.instances[0]?.name);
  });

  test('listInstances_givenAMalformedOrNegativePageToken_startsFromTheBeginningInsteadOfReturningAnEmptyOrFromEndPage', async () => {
    await repo.createInstance(
      instanceData({ name: 'projects/p/locations/us-central1/instances/a' })
    );
    await repo.createInstance(
      instanceData({ name: 'projects/p/locations/us-central1/instances/b' })
    );

    // A raw parseInt turns 'abc' into NaN (which the memory provider slices to
    // an empty page) and '-1' into a from-end slice, so a junk token silently
    // returned wrong results rather than the first page.
    for (const pageToken of ['abc', '-1']) {
      const page = await repo.listInstances('p', 'us-central1', 1, pageToken);

      expect(page.instances).toHaveLength(1);
      expect(page.instances[0]?.name).toBe('projects/p/locations/us-central1/instances/a');
    }
  });

  test('updateInstance_updatesFields_andPersistsThemWhileLeavingUnmaskedFieldsUnchanged', async () => {
    await repo.createInstance(
      instanceData({ name: 'projects/p/locations/us-central1/instances/i', shardCount: 1 })
    );

    const updated = await repo.updateInstance('projects/p/locations/us-central1/instances/i', {
      replicaCount: 2,
    });

    expect(updated?.replicaCount).toBe(2);

    // Re-read from storage rather than trusting the return value, so an
    // updateInstance() that merges in memory without ever persisting cannot
    // pass this test.
    const persisted = await repo.getInstanceByName('projects/p/locations/us-central1/instances/i');

    expect(persisted?.replicaCount).toBe(2);
    expect(persisted?.shardCount).toBe(1);
  });

  test('updateInstance_givenMissingInstance_returnsNull', async () => {
    const result = await repo.updateInstance('projects/p/locations/us-central1/instances/missing', {
      replicaCount: 2,
    });

    expect(result).toBeNull();
  });

  test('deleteInstance_removesTheInstance_andReturnsTrue', async () => {
    await repo.createInstance(
      instanceData({ name: 'projects/p/locations/us-central1/instances/i' })
    );

    const deleted = await repo.deleteInstance('projects/p/locations/us-central1/instances/i');

    expect(deleted).toBe(true);

    const found = await repo.getInstanceByName('projects/p/locations/us-central1/instances/i');

    expect(found).toBeNull();
  });

  test('deleteInstance_givenMissingInstance_returnsFalse', async () => {
    const result = await repo.deleteInstance('projects/p/locations/us-central1/instances/missing');

    expect(result).toBe(false);
  });
});
