/**
 * End-to-End Test: AlloyDB for PostgreSQL Control-Plane Lifecycle
 *
 * Black-box tests driving the cluster → instance → user lifecycle over HTTP, then
 * the same core lifecycle again through the official @google-cloud/alloydb client,
 * which is the real consumer this emulation has to satisfy.
 *
 * There is no data-plane test: this release emulates the control plane only, so
 * nothing listens on a PostgreSQL port.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AlloyDBAdminClient, protos } from '@google-cloud/alloydb';
import type { Server } from 'bun';
import { createLocationRoutes } from '@/core/gateway/location-routes.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { AlloyDbService } from '@/services/alloydb/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { buildProductionRouter, createFakeAuth } from './e2e-helpers.ts';

let emulatorServer: Server;
let emulatorPort: number;
let alloydbService: AlloyDbService;

function emulatorUrl(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(emulatorUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  emulatorPort = await getAvailablePort();

  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const logger = new Logger('e2e-alloydb', 'error');
  alloydbService = new AlloyDbService(storage, logger);
  await alloydbService.initialize();

  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: buildProductionRouter([...createLocationRoutes(logger), ...alloydbService.getRoutes()]),
  });
});

afterAll(() => {
  emulatorServer.stop();
});

describe('AlloyDB E2E: Raw HTTP API', () => {
  const project = 'test-project';
  const location = 'us-central1';
  const clusterId = 'e2e-cluster';
  const instanceId = 'e2e-instance';
  const userId = 'e2e-user';

  const clustersPath = `/v1/projects/${project}/locations/${location}/clusters`;
  const clusterPath = `${clustersPath}/${clusterId}`;
  const clusterName = `projects/${project}/locations/${location}/clusters/${clusterId}`;

  let createOperationName: string;

  test('1. Create a cluster - returns a done Operation carrying the Cluster', async () => {
    const response = await postJson(`${clustersPath}?clusterId=${clusterId}`, {
      initialUser: { user: 'postgres', password: 'e2e-secret' },
      network: `projects/${project}/global/networks/default`,
      databaseVersion: 'POSTGRES_16',
      labels: { env: 'e2e' },
    });

    expect(response.status).toBe(200);

    const operation = await response.json();

    expect(operation.done).toBe(true);
    expect(operation.metadata['@type']).toBe(
      'type.googleapis.com/google.cloud.alloydb.v1.OperationMetadata'
    );
    expect(operation.metadata.verb).toBe('create');
    expect(operation.metadata.target).toBe(clusterName);

    const cluster = operation.response;

    expect(cluster['@type']).toBe('type.googleapis.com/google.cloud.alloydb.v1.Cluster');
    expect(cluster.name).toBe(clusterName);
    expect(cluster.state).toBe('READY');
    expect(cluster.clusterType).toBe('PRIMARY');
    expect(cluster.databaseVersion).toBe('POSTGRES_16');
    expect(cluster.labels).toEqual({ env: 'e2e' });

    createOperationName = operation.name;
  });

  /** `initialUser` is input-only and carries a password; it must never come back. */
  test('2. Get the cluster - never echoes the initial user password', async () => {
    const response = await fetch(emulatorUrl(clusterPath));

    expect(response.status).toBe(200);

    const cluster = await response.json();

    expect(cluster.name).toBe(clusterName);
    expect(cluster).not.toHaveProperty('initialUser');
    expect(JSON.stringify(cluster)).not.toContain('e2e-secret');
  });

  test('3. Create a cluster with a duplicate id - 409 ALREADY_EXISTS', async () => {
    const response = await postJson(`${clustersPath}?clusterId=${clusterId}`, {
      initialUser: { user: 'postgres', password: 'e2e-secret' },
      networkConfig: { network: 'projects/p/global/networks/default' },
    });

    expect(response.status).toBe(409);

    const { error } = await response.json();

    expect(error.code).toBe(409);
    expect(error.status).toBe('ALREADY_EXISTS');
  });

  test('4. Create a cluster without clusterId - 400 INVALID_ARGUMENT', async () => {
    const response = await postJson(clustersPath, {
      initialUser: { user: 'postgres' },
      networkConfig: { network: 'projects/p/global/networks/default' },
    });

    expect(response.status).toBe(400);

    const { error } = await response.json();

    expect(error.status).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain('clusterId');
  });

  test('5. Create a cluster without initialUser - 400 INVALID_ARGUMENT', async () => {
    const response = await postJson(`${clustersPath}?clusterId=no-initial-user`, {
      network: 'default',
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error.status).toBe('INVALID_ARGUMENT');
  });

  test('6. List clusters - keys on "clusters"', async () => {
    const response = await fetch(emulatorUrl(clustersPath));

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(Array.isArray(body.clusters)).toBe(true);
    expect(body.clusters.map((cluster: { name: string }) => cluster.name)).toContain(clusterName);
    expect(body).not.toHaveProperty('items');
  });

  test('7. Patch the cluster with an updateMask - applies only the masked field', async () => {
    const response = await fetch(emulatorUrl(`${clusterPath}?updateMask=displayName`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'renamed by e2e', labels: { ignored: 'yes' } }),
    });

    expect(response.status).toBe(200);

    const operation = await response.json();

    expect(operation.response.displayName).toBe('renamed by e2e');
    expect(operation.response.labels).toEqual({ env: 'e2e' });
  });

  test('8. Patch with a mask naming an output-only field - 400 INVALID_ARGUMENT', async () => {
    const response = await fetch(emulatorUrl(`${clusterPath}?updateMask=state`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'FAILED' }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error.status).toBe('INVALID_ARGUMENT');
  });

  test('9. Create an instance under the cluster', async () => {
    const response = await postJson(`${clusterPath}/instances?instanceId=${instanceId}`, {
      instanceType: 'PRIMARY',
      machineConfig: { cpuCount: 2 },
    });

    expect(response.status).toBe(200);

    const instance = (await response.json()).response;

    expect(instance.name).toBe(`${clusterName}/instances/${instanceId}`);
    expect(instance.state).toBe('READY');
    expect(instance.instanceType).toBe('PRIMARY');
    expect(instance.machineConfig).toEqual({ cpuCount: 2 });
    // No data plane yet, so the address is loopback rather than connectable.
    expect(instance.ipAddress).toBe('127.0.0.1');
  });

  test('10. Get the instance connectionInfo singleton', async () => {
    const response = await fetch(
      emulatorUrl(`${clusterPath}/instances/${instanceId}/connectionInfo`)
    );

    expect(response.status).toBe(200);

    const connectionInfo = await response.json();

    expect(connectionInfo.name).toBe(`${clusterName}/instances/${instanceId}/connectionInfo`);
    expect(connectionInfo.ipAddress).toBe('127.0.0.1');
    expect(connectionInfo.instanceUid).toBeTypeOf('string');
  });

  test('11. Create an instance under a missing cluster - 404 naming the Cluster', async () => {
    const response = await postJson(`${clustersPath}/does-not-exist/instances?instanceId=orphan`, {
      instanceType: 'PRIMARY',
    });

    expect(response.status).toBe(404);

    const { error } = await response.json();

    expect(error.status).toBe('NOT_FOUND');
    expect(error.message).toContain('Cluster');
  });

  /**
   * `users.create` declares `User` as its response, not `Operation` — the one
   * AlloyDB resource whose mutations are synchronous.
   */
  test('12. Create a user - returns the User directly, not an Operation', async () => {
    const response = await postJson(`${clusterPath}/users?userId=${userId}`, {
      password: 'user-secret',
      databaseRoles: ['pg_monitor'],
      userType: 'ALLOYDB_BUILT_IN',
    });

    expect(response.status).toBe(200);

    const user = await response.json();

    expect(user.name).toBe(`${clusterName}/users/${userId}`);
    expect(user.userType).toBe('ALLOYDB_BUILT_IN');
    expect(user.databaseRoles).toEqual(['pg_monitor']);
    expect(user).not.toHaveProperty('done');
    expect(user).not.toHaveProperty('metadata');
    expect(JSON.stringify(user)).not.toContain('user-secret');
  });

  test('13. List users - keys on "users"', async () => {
    const response = await fetch(emulatorUrl(`${clusterPath}/users`));

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.users.map((user: { name: string }) => user.name)).toContain(
      `${clusterName}/users/${userId}`
    );
  });

  /** `users.delete` declares `google.protobuf.Empty`: 200 with an empty object. */
  test('14. Delete the user - 200 with an empty body', async () => {
    const response = await fetch(emulatorUrl(`${clusterPath}/users/${userId}`), {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});

    const afterwards = await fetch(emulatorUrl(`${clusterPath}/users/${userId}`));

    expect(afterwards.status).toBe(404);
  });

  test('15. Get the create Operation back from the operations collection', async () => {
    const response = await fetch(emulatorUrl(`/v1/${createOperationName}`));

    expect(response.status).toBe(200);

    const operation = await response.json();

    expect(operation.name).toBe(createOperationName);
    expect(operation.done).toBe(true);
  });

  test('16. List operations - keys on "operations"', async () => {
    const response = await fetch(
      emulatorUrl(`/v1/projects/${project}/locations/${location}/operations`)
    );

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.operations.length).toBeGreaterThan(0);
    expect(body).not.toHaveProperty('items');
  });

  test('17. Cancel the create Operation - records the request, stays done', async () => {
    const response = await postJson(`/v1/${createOperationName}:cancel`, {});

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});

    const operation = await (await fetch(emulatorUrl(`/v1/${createOperationName}`))).json();

    expect(operation.metadata.requestedCancellation).toBe(true);
    expect(operation.done).toBe(true);
  });

  test('18. Delete the cluster while it has an instance - 400 FAILED_PRECONDITION', async () => {
    const response = await fetch(emulatorUrl(clusterPath), { method: 'DELETE' });

    expect(response.status).toBe(400);
    expect((await response.json()).error.status).toBe('FAILED_PRECONDITION');
  });

  test('19. Delete the cluster with force=true - cascades to its instances', async () => {
    const response = await fetch(emulatorUrl(`${clusterPath}?force=true`), { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect((await response.json()).done).toBe(true);

    expect((await fetch(emulatorUrl(clusterPath))).status).toBe(404);
    expect((await fetch(emulatorUrl(`${clusterPath}/instances/${instanceId}`))).status).toBe(404);
  });

  test('20. List supported database flags', async () => {
    const response = await fetch(
      emulatorUrl(`/v1/projects/${project}/locations/${location}/supportedDatabaseFlags`)
    );

    expect(response.status).toBe(200);

    const flags = (await response.json()).supportedDatabaseFlags as Array<{
      flagName: string;
      valueType: string;
    }>;

    expect(flags.some(flag => flag.flagName === 'max_connections')).toBe(true);
  });

  test('21. Get a location, and 404 for one that is not served', async () => {
    const served = await fetch(emulatorUrl(`/v1/projects/${project}/locations/${location}`));

    expect(served.status).toBe(200);
    expect((await served.json()).locationId).toBe(location);

    const unserved = await fetch(emulatorUrl(`/v1/projects/${project}/locations/mars-central1`));

    expect(unserved.status).toBe(404);
  });
});

describe('AlloyDB E2E: Official @google-cloud/alloydb client', () => {
  const project = 'client-project';
  const location = 'us-central1';
  const clusterId = 'client-cluster';
  const instanceId = 'client-instance';
  const parent = `projects/${project}/locations/${location}`;

  let client: AlloyDBAdminClient;

  /**
   * Enum decoding differs by response path, so the assertions below deliberately
   * differ too:
   *
   * <ul>
   *   <li>A resource unwrapped from an LRO (`operation.promise()`) keeps proto
   *       enum <b>numbers</b> — `state` is 1.
   *   <li>A resource returned directly from a unary call (`getCluster`,
   *       `createUser`) is decoded with string enums — `clusterType` is
   *       'PRIMARY'.
   * </ul>
   *
   * Both happen identically against real GCP: the emulator sends the enum name on
   * the wire either way, which the raw-HTTP suite above asserts. The numeric
   * expectations reference the client's own enum rather than a bare `1` so the
   * distinction is legible.
   */
  const alloydbProtos = protos.google.cloud.alloydb.v1;

  beforeAll(() => {
    client = new AlloyDBAdminClient({
      fallback: 'rest',
      apiEndpoint: 'localhost',
      port: emulatorPort,
      protocol: 'http',
      auth: createFakeAuth(project) as never,
    });
  });

  test('1. Create a cluster via the client library', async () => {
    const [operation] = await client.createCluster({
      parent,
      clusterId,
      cluster: {
        network: `projects/${project}/global/networks/default`,
        initialUser: { user: 'postgres', password: 'client-secret' },
      },
    });

    // Emulated operations are born done, so the LRO resolves without polling.
    const [cluster] = await operation.promise();

    expect(cluster.name).toBe(`${parent}/clusters/${clusterId}`);
    expect(cluster.state).toBe(alloydbProtos.Cluster.State.READY);
  });

  test('2. Get the cluster via the client library', async () => {
    const [cluster] = await client.getCluster({ name: `${parent}/clusters/${clusterId}` });

    expect(cluster.name).toBe(`${parent}/clusters/${clusterId}`);
    expect(cluster.clusterType).toBe('PRIMARY');
  });

  test('3. List clusters via the client library', async () => {
    const [clusters] = await client.listClusters({ parent });

    expect(clusters.map(cluster => cluster.name)).toContain(`${parent}/clusters/${clusterId}`);
  });

  test('4. Create and read an instance via the client library', async () => {
    const [operation] = await client.createInstance({
      parent: `${parent}/clusters/${clusterId}`,
      instanceId,
      instance: { instanceType: 'PRIMARY' },
    });

    const [instance] = await operation.promise();

    expect(instance.name).toBe(`${parent}/clusters/${clusterId}/instances/${instanceId}`);
    expect(instance.state).toBe(alloydbProtos.Instance.State.READY);

    const [fetched] = await client.getInstance({ name: instance.name as string });

    expect(fetched.ipAddress).toBe('127.0.0.1');
  });

  /** Synchronous, unlike every cluster and instance mutation. */
  test('5. Create a user via the client library - no LRO involved', async () => {
    const [user] = await client.createUser({
      parent: `${parent}/clusters/${clusterId}`,
      userId: 'client-user',
      user: { userType: 'ALLOYDB_BUILT_IN', databaseRoles: ['pg_monitor'] },
    });

    expect(user.name).toBe(`${parent}/clusters/${clusterId}/users/client-user`);
    expect(user.userType).toBe('ALLOYDB_BUILT_IN');
    expect(user.databaseRoles).toEqual(['pg_monitor']);
  });

  test('6. Get connection info via the client library', async () => {
    const [connectionInfo] = await client.getConnectionInfo({
      parent: `${parent}/clusters/${clusterId}/instances/${instanceId}`,
    });

    expect(connectionInfo.ipAddress).toBe('127.0.0.1');
    expect(connectionInfo.instanceUid).toBeTypeOf('string');
  });

  test('7. Delete the cluster with force via the client library', async () => {
    const [operation] = await client.deleteCluster({
      name: `${parent}/clusters/${clusterId}`,
      force: true,
    });

    await operation.promise();

    await expect(client.getCluster({ name: `${parent}/clusters/${clusterId}` })).rejects.toThrow();
  });
});
