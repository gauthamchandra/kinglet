import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { buildInstanceListPrefix, InstanceRepository } from './instance-repository.ts';
import { ALLOYDB_INSTANCES_TABLE, buildInstanceName, instanceRequestToRecord } from './types.ts';

let storage: StorageManager;
let repository: InstanceRepository;

function instanceData(clusterId: string, instanceId: string, location = 'us-central1') {
  return instanceRequestToRecord(buildInstanceName('p', location, clusterId, instanceId), {
    instanceType: 'PRIMARY',
  });
}

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  repository = new InstanceRepository(storage);
  await repository.initialize();
});

test('initialize_createsTheInstancesTable', async () => {
  expect(await storage.listTables()).toContain(ALLOYDB_INSTANCES_TABLE);
});

test('buildInstanceListPrefix_nestsUnderTheClusterAndEndsWithASeparator', () => {
  expect(buildInstanceListPrefix('p', 'us-central1', 'c1')).toBe(
    'projects/p/locations/us-central1/clusters/c1/instances/'
  );
});

describe('listInstances', () => {
  test('listInstances_returnsTheClustersInstancesSortedByName', async () => {
    for (const instanceId of ['i2', 'i1']) {
      await repository.create(instanceData('c1', instanceId));
    }

    const result = await repository.listInstances('p', 'us-central1', 'c1');

    expect(result.instances.map(instance => instance.name)).toEqual([
      buildInstanceName('p', 'us-central1', 'c1', 'i1'),
      buildInstanceName('p', 'us-central1', 'c1', 'i2'),
    ]);
  });

  /**
   * Instances are cluster-scoped, so a sibling cluster whose id merely shares a
   * prefix must not contribute to the listing.
   */
  test('listInstances_scopesToItsOwnClusterEvenWhenASiblingIdSharesAPrefix', async () => {
    await repository.create(instanceData('c1', 'i1'));
    await repository.create(instanceData('c10', 'i1'));
    await repository.create(instanceData('c1', 'i1', 'europe-west1'));

    const result = await repository.listInstances('p', 'us-central1', 'c1');

    expect(result.instances.map(instance => instance.name)).toEqual([
      buildInstanceName('p', 'us-central1', 'c1', 'i1'),
    ]);
  });

  test('listInstances_propagatesPaginationToTheCaller', async () => {
    for (const instanceId of ['i1', 'i2', 'i3']) {
      await repository.create(instanceData('c1', instanceId));
    }

    const firstPage = await repository.listInstances('p', 'us-central1', 'c1', 2);

    expect(firstPage.instances).toHaveLength(2);
    expect(firstPage.nextPageToken).toBe('2');
  });

  test('listInstances_givenNoInstances_returnsAnEmptyList', async () => {
    expect((await repository.listInstances('p', 'us-central1', 'c1')).instances).toEqual([]);
  });
});
