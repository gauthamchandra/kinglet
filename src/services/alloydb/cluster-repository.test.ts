import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { buildClusterListPrefix, ClusterRepository } from './cluster-repository.ts';
import { ALLOYDB_CLUSTERS_TABLE, buildClusterName, clusterRequestToRecord } from './types.ts';

let storage: StorageManager;
let repository: ClusterRepository;

function clusterData(clusterId: string, location = 'us-central1', project = 'p') {
  return clusterRequestToRecord(buildClusterName(project, location, clusterId), {
    initialUser: { user: 'postgres' },
  });
}

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  repository = new ClusterRepository(storage);
  await repository.initialize();
});

test('initialize_createsTheClustersTable', async () => {
  expect(await storage.listTables()).toContain(ALLOYDB_CLUSTERS_TABLE);
});

test('buildClusterListPrefix_endsWithASeparatorSoSiblingIdsStayIsolated', () => {
  expect(buildClusterListPrefix('p', 'us-central1')).toBe(
    'projects/p/locations/us-central1/clusters/'
  );
});

describe('listClusters', () => {
  test('listClusters_returnsTheLocationsClustersSortedByName', async () => {
    for (const clusterId of ['c3', 'c1', 'c2']) {
      await repository.create(clusterData(clusterId));
    }

    const result = await repository.listClusters('p', 'us-central1');

    expect(result.clusters.map(cluster => cluster.name)).toEqual([
      buildClusterName('p', 'us-central1', 'c1'),
      buildClusterName('p', 'us-central1', 'c2'),
      buildClusterName('p', 'us-central1', 'c3'),
    ]);
    expect(result.nextPageToken).toBeUndefined();
  });

  test('listClusters_scopesToTheRequestedProjectAndLocation', async () => {
    await repository.create(clusterData('c1'));
    await repository.create(clusterData('c1', 'europe-west1'));
    await repository.create(clusterData('c1', 'us-central1', 'other'));

    const result = await repository.listClusters('p', 'us-central1');

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.name).toBe(buildClusterName('p', 'us-central1', 'c1'));
  });

  test('listClusters_propagatesPaginationToTheCaller', async () => {
    for (const clusterId of ['c1', 'c2', 'c3']) {
      await repository.create(clusterData(clusterId));
    }

    const firstPage = await repository.listClusters('p', 'us-central1', 2);

    expect(firstPage.clusters).toHaveLength(2);
    expect(firstPage.nextPageToken).toBe('2');

    const secondPage = await repository.listClusters(
      'p',
      'us-central1',
      2,
      firstPage.nextPageToken
    );

    expect(secondPage.clusters.map(cluster => cluster.name)).toEqual([
      buildClusterName('p', 'us-central1', 'c3'),
    ]);
  });

  test('listClusters_givenNoClusters_returnsAnEmptyList', async () => {
    expect((await repository.listClusters('p', 'us-central1')).clusters).toEqual([]);
  });
});
