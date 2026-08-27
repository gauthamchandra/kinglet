/**
 * HTTP-layer tests for every AlloyDB handler class.
 *
 * <p>Exercised through real services over in-memory storage rather than mocks:
 * the thing worth pinning is that a request's query parameters reach the right
 * argument and that the response body is shaped the way a GCP client expects,
 * neither of which a mocked service would prove.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { RouteDefinition, RouteRequest } from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import { OperationsStore } from '@/core/operations/operations-store.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import { ClusterHandlers } from './cluster-handlers.ts';
import { ClusterRepository } from './cluster-repository.ts';
import { ClusterService } from './cluster-service.ts';
import { InstanceHandlers } from './instance-handlers.ts';
import { InstanceRepository } from './instance-repository.ts';
import { InstanceService } from './instance-service.ts';
import { LocationHandlers } from './location-handlers.ts';
import { ALLOYDB_OPERATIONS_TABLE, buildClusterName, buildInstanceName } from './types.ts';
import { UserHandlers } from './user-handlers.ts';
import { UserRepository } from './user-repository.ts';
import { UserService } from './user-service.ts';

const PROJECT = 'p';
const LOCATION = 'us-central1';

let clusterHandlers: ClusterHandlers;
let instanceHandlers: InstanceHandlers;
let userHandlers: UserHandlers;
let locationHandlers: LocationHandlers;

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/',
    query: {},
    headers: {},
    params: { project: PROJECT, location: LOCATION },
    originalRequest: new Request('http://localhost/'),
    ...overrides,
  };
}

async function invoke(
  routes: RouteDefinition[],
  routeId: string,
  overrides: Partial<RouteRequest> = {}
) {
  const route = routes.find(candidate => candidate.id === routeId);

  if (!route) throw new Error(`No route registered with id "${routeId}"`);

  return route.handler(request(overrides), {
    routeId,
    startTime: 0,
    metadata: {},
    logger: new Logger('test', 'error'),
  });
}

function body(response: { body?: unknown }): Record<string, unknown> {
  return response.body as Record<string, unknown>;
}

function errorOf(response: { body?: unknown }) {
  return (response.body as { error: { code: number; message: string; status: string } }).error;
}

/** Create a cluster through the handler layer so later requests have a parent. */
async function createCluster(clusterId: string) {
  return invoke(clusterHandlers.getRoutes(), 'alloydb.clusters.create', {
    method: 'POST',
    query: { clusterId },
    body: {
      initialUser: { user: 'postgres', password: 'hunter2' },
      networkConfig: { network: 'projects/p/global/networks/default' },
    },
  });
}

beforeEach(async () => {
  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const clusters = new ClusterRepository(storage);
  const instances = new InstanceRepository(storage);
  const users = new UserRepository(storage);
  const operations = new OperationsStore(storage, {
    tableName: ALLOYDB_OPERATIONS_TABLE,
    apiTypePrefix: 'google.cloud.alloydb.v1',
  });

  await Promise.all([
    clusters.initialize(),
    instances.initialize(),
    users.initialize(),
    operations.initialize(),
  ]);

  const responseUtils = new ResponseUtils(
    new StandardResponseFormatter(new Logger('test', 'error'))
  );

  const clusterMutex = new ResourceMutex();

  clusterHandlers = new ClusterHandlers(
    new ClusterService(clusters, instances, users, operations, clusterMutex),
    responseUtils
  );
  instanceHandlers = new InstanceHandlers(
    new InstanceService(instances, clusters, operations, clusterMutex),
    responseUtils
  );
  userHandlers = new UserHandlers(new UserService(users, clusters, clusterMutex), responseUtils);
  locationHandlers = new LocationHandlers(responseUtils);
});

describe('route ids', () => {
  test('everyRouteId_isPrefixedWithAlloydb', () => {
    const routes = [
      ...clusterHandlers.getRoutes(),
      ...instanceHandlers.getRoutes(),
      ...userHandlers.getRoutes(),
      ...locationHandlers.getRoutes(),
    ];

    for (const route of routes) {
      expect(route.id).toStartWith('alloydb.');
    }
  });

  test('everyRouteId_isUnique', () => {
    const ids = [
      ...clusterHandlers.getRoutes(),
      ...instanceHandlers.getRoutes(),
      ...userHandlers.getRoutes(),
      ...locationHandlers.getRoutes(),
    ].map(route => route.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The router scores candidate routes and picks one winner per path, so a
   * literal sub-resource segment has to be registered before the parameterised
   * sibling that would otherwise swallow it.
   */
  test('getConnectionInfo_isRegisteredBeforeTheInstanceGetThatCouldShadowIt', () => {
    const ids = instanceHandlers.getRoutes().map(route => route.id);

    expect(ids.indexOf('alloydb.clusters.instances.getConnectionInfo')).toBeLessThan(
      ids.indexOf('alloydb.clusters.instances.get')
    );
  });
});

describe('cluster handlers', () => {
  test('create_returns200WithTheOperation', async () => {
    const response = await createCluster('c1');

    expect(response.status).toBe(200);
    expect(body(response).done).toBe(true);
  });

  /**
   * The id is a query parameter, not a body field. Omitting it must be a clean
   * 400 rather than a cluster named after an empty string.
   */
  test('create_withoutTheClusterIdQueryParameter_returns400InvalidArgument', async () => {
    const response = await invoke(clusterHandlers.getRoutes(), 'alloydb.clusters.create', {
      method: 'POST',
      body: { initialUser: { user: 'postgres' } },
    });

    expect(response.status).toBe(400);
    expect(errorOf(response).status).toBe('INVALID_ARGUMENT');
    expect(errorOf(response).message).toContain('clusterId');
  });

  test('create_withoutAnInitialUser_returns400', async () => {
    const response = await invoke(clusterHandlers.getRoutes(), 'alloydb.clusters.create', {
      method: 'POST',
      query: { clusterId: 'c1' },
      body: { networkConfig: { network: 'projects/p/global/networks/default' } },
    });

    expect(response.status).toBe(400);
    expect(errorOf(response).status).toBe('INVALID_ARGUMENT');
  });

  test('create_withNoBodyAtAll_returns400RatherThanCrashing', async () => {
    const response = await invoke(clusterHandlers.getRoutes(), 'alloydb.clusters.create', {
      method: 'POST',
      query: { clusterId: 'c1' },
    });

    expect(response.status).toBe(400);
    expect(errorOf(response).status).toBe('INVALID_ARGUMENT');
  });

  test('create_givenADuplicate_returns409AlreadyExists', async () => {
    await createCluster('c1');

    const response = await createCluster('c1');

    expect(response.status).toBe(409);
    expect(errorOf(response).status).toBe('ALREADY_EXISTS');
  });

  test('get_returns200AndNeverEchoesTheInitialUserPassword', async () => {
    await createCluster('c1');

    const response = await invoke(clusterHandlers.getRoutes(), 'alloydb.clusters.get', {
      params: { project: PROJECT, location: LOCATION, cluster: 'c1' },
    });

    expect(response.status).toBe(200);
    expect(body(response).name).toBe(buildClusterName(PROJECT, LOCATION, 'c1'));
    expect(JSON.stringify(response.body)).not.toContain('hunter2');
  });

  test('get_givenAnUnknownCluster_returns404', async () => {
    const response = await invoke(clusterHandlers.getRoutes(), 'alloydb.clusters.get', {
      params: { project: PROJECT, location: LOCATION, cluster: 'missing' },
    });

    expect(response.status).toBe(404);
    expect(errorOf(response).status).toBe('NOT_FOUND');
  });

  /**
   * GCP list responses key on the resource name, so `clusters` — not `items`,
   * which is what ResponseUtils.paginated would have emitted.
   */
  test('list_keysTheResponseOnClustersRatherThanItems', async () => {
    await createCluster('c1');

    const response = await invoke(clusterHandlers.getRoutes(), 'alloydb.clusters.list');

    expect(response.status).toBe(200);
    expect(body(response)).toHaveProperty('clusters');
    expect(body(response)).not.toHaveProperty('items');
  });

  test('list_withoutMorePages_omitsNextPageTokenEntirely', async () => {
    await createCluster('c1');

    const response = await invoke(clusterHandlers.getRoutes(), 'alloydb.clusters.list');

    expect(body(response)).not.toHaveProperty('nextPageToken');
  });

  test('list_withAPageSizeSmallerThanTheResultSet_returnsANextPageToken', async () => {
    await createCluster('c1');
    await createCluster('c2');

    const response = await invoke(clusterHandlers.getRoutes(), 'alloydb.clusters.list', {
      query: { pageSize: '1' },
    });

    expect((body(response).clusters as unknown[]).length).toBe(1);
    expect(body(response).nextPageToken).toBe('1');
  });

  test('list_followingTheNextPageToken_returnsTheRemainder', async () => {
    await createCluster('c1');
    await createCluster('c2');

    const response = await invoke(clusterHandlers.getRoutes(), 'alloydb.clusters.list', {
      query: { pageSize: '1', pageToken: '1' },
    });

    const clusters = body(response).clusters as Array<{ name: string }>;

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.name).toBe(buildClusterName(PROJECT, LOCATION, 'c2'));
  });

  test('patch_appliesTheUpdateMaskFromTheQueryString', async () => {
    await createCluster('c1');

    const response = await invoke(clusterHandlers.getRoutes(), 'alloydb.clusters.patch', {
      method: 'PATCH',
      params: { project: PROJECT, location: LOCATION, cluster: 'c1' },
      query: { updateMask: 'displayName' },
      body: { displayName: 'renamed' },
    });

    expect(response.status).toBe(200);
    expect((body(response).response as Record<string, unknown>).displayName).toBe('renamed');
  });

  test('patch_withAMaskNamingAnOutputOnlyField_returns400', async () => {
    await createCluster('c1');

    const response = await invoke(clusterHandlers.getRoutes(), 'alloydb.clusters.patch', {
      method: 'PATCH',
      params: { project: PROJECT, location: LOCATION, cluster: 'c1' },
      query: { updateMask: 'state' },
      body: { state: 'FAILED' },
    });

    expect(response.status).toBe(400);
    expect(errorOf(response).status).toBe('INVALID_ARGUMENT');
  });

  test('delete_returns200WithTheOperation', async () => {
    await createCluster('c1');

    const response = await invoke(clusterHandlers.getRoutes(), 'alloydb.clusters.delete', {
      method: 'DELETE',
      params: { project: PROJECT, location: LOCATION, cluster: 'c1' },
    });

    expect(response.status).toBe(200);
    expect(body(response).done).toBe(true);
  });

  test('delete_withChildInstancesAndNoForce_returns400FailedPrecondition', async () => {
    await createCluster('c1');
    await invoke(instanceHandlers.getRoutes(), 'alloydb.clusters.instances.create', {
      method: 'POST',
      params: { project: PROJECT, location: LOCATION, cluster: 'c1' },
      query: { instanceId: 'i1' },
      body: { instanceType: 'PRIMARY' },
    });

    const response = await invoke(clusterHandlers.getRoutes(), 'alloydb.clusters.delete', {
      method: 'DELETE',
      params: { project: PROJECT, location: LOCATION, cluster: 'c1' },
    });

    expect(response.status).toBe(400);
    expect(errorOf(response).status).toBe('FAILED_PRECONDITION');
  });

  test('delete_withForceInTheQueryString_cascadesAndReturns200', async () => {
    await createCluster('c1');
    await invoke(instanceHandlers.getRoutes(), 'alloydb.clusters.instances.create', {
      method: 'POST',
      params: { project: PROJECT, location: LOCATION, cluster: 'c1' },
      query: { instanceId: 'i1' },
      body: { instanceType: 'PRIMARY' },
    });

    const response = await invoke(clusterHandlers.getRoutes(), 'alloydb.clusters.delete', {
      method: 'DELETE',
      params: { project: PROJECT, location: LOCATION, cluster: 'c1' },
      query: { force: 'true' },
    });

    expect(response.status).toBe(200);
  });

  test('delete_withValidateOnly_leavesTheClusterFetchable', async () => {
    await createCluster('c1');

    await invoke(clusterHandlers.getRoutes(), 'alloydb.clusters.delete', {
      method: 'DELETE',
      params: { project: PROJECT, location: LOCATION, cluster: 'c1' },
      query: { validateOnly: 'true' },
    });

    const afterwards = await invoke(clusterHandlers.getRoutes(), 'alloydb.clusters.get', {
      params: { project: PROJECT, location: LOCATION, cluster: 'c1' },
    });

    expect(afterwards.status).toBe(200);
  });
});

describe('instance handlers', () => {
  beforeEach(async () => {
    await createCluster('c1');
  });

  const instanceParams = { project: PROJECT, location: LOCATION, cluster: 'c1', instance: 'i1' };

  async function createInstance() {
    return invoke(instanceHandlers.getRoutes(), 'alloydb.clusters.instances.create', {
      method: 'POST',
      params: { project: PROJECT, location: LOCATION, cluster: 'c1' },
      query: { instanceId: 'i1' },
      body: { instanceType: 'PRIMARY' },
    });
  }

  test('create_returns200WithTheOperation', async () => {
    const response = await createInstance();

    expect(response.status).toBe(200);
    expect(body(response).done).toBe(true);
  });

  test('create_withoutTheInstanceIdQueryParameter_returns400', async () => {
    const response = await invoke(
      instanceHandlers.getRoutes(),
      'alloydb.clusters.instances.create',
      {
        method: 'POST',
        params: { project: PROJECT, location: LOCATION, cluster: 'c1' },
        body: {},
      }
    );

    expect(response.status).toBe(400);
    expect(errorOf(response).message).toContain('instanceId');
  });

  test('create_underAMissingCluster_returns404NamingTheCluster', async () => {
    const response = await invoke(
      instanceHandlers.getRoutes(),
      'alloydb.clusters.instances.create',
      {
        method: 'POST',
        params: { project: PROJECT, location: LOCATION, cluster: 'missing' },
        query: { instanceId: 'i1' },
        body: { instanceType: 'PRIMARY' },
      }
    );

    expect(response.status).toBe(404);
    expect(errorOf(response).message).toContain('Cluster');
  });

  test('get_returns200WithTheInstance', async () => {
    await createInstance();

    const response = await invoke(instanceHandlers.getRoutes(), 'alloydb.clusters.instances.get', {
      params: instanceParams,
    });

    expect(response.status).toBe(200);
    expect(body(response).name).toBe(buildInstanceName(PROJECT, LOCATION, 'c1', 'i1'));
  });

  test('list_keysTheResponseOnInstances', async () => {
    await createInstance();

    const response = await invoke(instanceHandlers.getRoutes(), 'alloydb.clusters.instances.list', {
      params: { project: PROJECT, location: LOCATION, cluster: 'c1' },
    });

    expect(body(response)).toHaveProperty('instances');
    expect(body(response)).not.toHaveProperty('items');
  });

  test('getConnectionInfo_returnsTheSingletonSubresource', async () => {
    await createInstance();

    const response = await invoke(
      instanceHandlers.getRoutes(),
      'alloydb.clusters.instances.getConnectionInfo',
      { params: instanceParams }
    );

    expect(response.status).toBe(200);
    expect(body(response).name).toBe(
      `${buildInstanceName(PROJECT, LOCATION, 'c1', 'i1')}/connectionInfo`
    );
    expect(body(response).ipAddress).toBe('127.0.0.1');
  });

  test('patch_appliesTheUpdateMask', async () => {
    await createInstance();

    const response = await invoke(
      instanceHandlers.getRoutes(),
      'alloydb.clusters.instances.patch',
      {
        method: 'PATCH',
        params: instanceParams,
        query: { updateMask: 'displayName' },
        body: { displayName: 'renamed' },
      }
    );

    expect((body(response).response as Record<string, unknown>).displayName).toBe('renamed');
  });

  test('delete_returns200WithTheOperation', async () => {
    await createInstance();

    const response = await invoke(
      instanceHandlers.getRoutes(),
      'alloydb.clusters.instances.delete',
      { method: 'DELETE', params: instanceParams }
    );

    expect(response.status).toBe(200);
    expect(body(response).done).toBe(true);
  });
});

describe('user handlers', () => {
  beforeEach(async () => {
    await createCluster('c1');
  });

  const userParams = { project: PROJECT, location: LOCATION, cluster: 'c1', user: 'admin' };

  async function createUser() {
    return invoke(userHandlers.getRoutes(), 'alloydb.clusters.users.create', {
      method: 'POST',
      params: { project: PROJECT, location: LOCATION, cluster: 'c1' },
      query: { userId: 'admin' },
      body: { password: 'hunter2', databaseRoles: ['pg_monitor'] },
    });
  }

  /**
   * <b>IMPORTANT:</b> `users.create` declares `User` as its response, not
   * `Operation`. An LRO envelope here would break every real client.
   */
  test('create_returnsTheUserResourceRatherThanAnOperation', async () => {
    const response = await createUser();

    expect(response.status).toBe(200);
    expect(body(response).name).toBe('projects/p/locations/us-central1/clusters/c1/users/admin');
    expect(body(response)).not.toHaveProperty('done');
    expect(body(response)).not.toHaveProperty('metadata');
  });

  test('create_neverEchoesThePassword', async () => {
    const response = await createUser();

    expect(JSON.stringify(response.body)).not.toContain('hunter2');
  });

  test('create_withoutTheUserIdQueryParameter_returns400', async () => {
    const response = await invoke(userHandlers.getRoutes(), 'alloydb.clusters.users.create', {
      method: 'POST',
      params: { project: PROJECT, location: LOCATION, cluster: 'c1' },
      body: {},
    });

    expect(response.status).toBe(400);
    expect(errorOf(response).message).toContain('userId');
  });

  test('get_returns200WithTheUser', async () => {
    await createUser();

    const response = await invoke(userHandlers.getRoutes(), 'alloydb.clusters.users.get', {
      params: userParams,
    });

    expect(response.status).toBe(200);
    expect(body(response).databaseRoles).toEqual(['pg_monitor']);
  });

  test('list_keysTheResponseOnUsers', async () => {
    await createUser();

    const response = await invoke(userHandlers.getRoutes(), 'alloydb.clusters.users.list', {
      params: { project: PROJECT, location: LOCATION, cluster: 'c1' },
    });

    expect(body(response)).toHaveProperty('users');
    expect(body(response)).not.toHaveProperty('items');
  });

  test('patch_returnsTheUpdatedUserRatherThanAnOperation', async () => {
    await createUser();

    const response = await invoke(userHandlers.getRoutes(), 'alloydb.clusters.users.patch', {
      method: 'PATCH',
      params: userParams,
      query: { updateMask: 'databaseRoles' },
      body: { databaseRoles: ['pg_read_all_data'] },
    });

    expect(body(response).databaseRoles).toEqual(['pg_read_all_data']);
    expect(body(response)).not.toHaveProperty('done');
  });

  /** `users.delete` declares `google.protobuf.Empty`: 200 with an empty object. */
  test('delete_returns200WithAnEmptyObject', async () => {
    await createUser();

    const response = await invoke(userHandlers.getRoutes(), 'alloydb.clusters.users.delete', {
      method: 'DELETE',
      params: userParams,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({});
  });

  test('delete_givenAnUnknownUser_returns404', async () => {
    const response = await invoke(userHandlers.getRoutes(), 'alloydb.clusters.users.delete', {
      method: 'DELETE',
      params: { ...userParams, user: 'missing' },
    });

    expect(response.status).toBe(404);
    expect(errorOf(response).status).toBe('NOT_FOUND');
  });
});

describe('location handlers', () => {
  test('supportedDatabaseFlagsList_returnsFlagsNamedUnderTheLocation', async () => {
    const response = await invoke(
      locationHandlers.getRoutes(),
      'alloydb.supportedDatabaseFlags.list'
    );

    const flags = body(response).supportedDatabaseFlags as Array<{
      name: string;
      flagName: string;
      valueType: string;
    }>;

    expect(response.status).toBe(200);
    expect(flags.length).toBeGreaterThan(0);

    const maxConnections = flags.find(flag => flag.flagName === 'max_connections');

    expect(maxConnections?.valueType).toBe('INTEGER');
    expect(maxConnections?.name).toBe('projects/p/locations/us-central1/flags/max_connections');
  });
});

describe('static list pagination', () => {
  /**
   * `supportedDatabaseFlags.list` declares `pageSize`/`pageToken` in the discovery
   * document. Serving the whole constant array regardless would make a client that
   * pages hang or double-process.
   */
  test('supportedDatabaseFlagsList_honoursPageSize', async () => {
    const response = await invoke(
      locationHandlers.getRoutes(),
      'alloydb.supportedDatabaseFlags.list',
      { query: { pageSize: '2' } }
    );

    expect((body(response).supportedDatabaseFlags as unknown[]).length).toBe(2);
    expect(body(response).nextPageToken).toBe('2');
  });

  test('supportedDatabaseFlagsList_withoutAPageSize_returnsEveryFlagAndNoToken', async () => {
    const response = await invoke(
      locationHandlers.getRoutes(),
      'alloydb.supportedDatabaseFlags.list'
    );

    expect((body(response).supportedDatabaseFlags as unknown[]).length).toBeGreaterThan(0);
    expect(body(response)).not.toHaveProperty('nextPageToken');
  });
});
