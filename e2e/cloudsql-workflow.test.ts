/**
 * End-to-End Test: Cloud SQL Workflow
 *
 * Black-box control-plane lifecycle through HTTP (sqladmin v1 REST surface).
 * There is no @google-cloud/* client for the SQL Admin API; raw REST is the
 * verification path. The data plane (connectable Postgres) is deferred.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { StorageManager } from '@/core/storage/manager.ts';
import { CloudSqlService } from '@/services/cloudsql/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { buildRouter } from './e2e-helpers.ts';

let emulatorServer: Server;
let emulatorPort: number;
let cloudSqlService: CloudSqlService;

const PROJECT = 'e2e-project';

function url(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

beforeAll(async () => {
  emulatorPort = await getAvailablePort();

  const storage = new StorageManager();

  await storage.initialize({ type: 'memory' });

  cloudSqlService = new CloudSqlService(storage, new Logger('e2e', 'error'));

  await cloudSqlService.initialize();

  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: buildRouter(cloudSqlService.getRoutes()),
  });
});

afterAll(async () => {
  emulatorServer.stop();
  await cloudSqlService.stop();
});

describe('Cloud SQL e2e', () => {
  test('full instance lifecycle over the REST surface', async () => {
    // 1. Create the instance
    const createResp = await fetch(url(`/v1/projects/${PROJECT}/instances`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'orders-db',
        databaseVersion: 'POSTGRES_16',
        rootPassword: 'root-pass',
      }),
    });

    expect(createResp.status).toBe(200);

    const createOp = (await createResp.json()) as {
      kind: string;
      name: string;
      status: string;
      operationType: string;
    };

    expect(createOp.kind).toBe('sql#operation');
    expect(createOp.operationType).toBe('CREATE');
    expect(createOp.status).toBe('DONE');

    // 2. Poll the operation like a real client would
    const opResp = await fetch(url(`/v1/projects/${PROJECT}/operations/${createOp.name}`));

    expect(opResp.status).toBe(200);

    const fetchedOp = (await opResp.json()) as { status: string };

    expect(fetchedOp.status).toBe('DONE');

    // 3. instances.get returns a faithful resource
    const getResp = await fetch(url(`/v1/projects/${PROJECT}/instances/orders-db`));

    expect(getResp.status).toBe(200);

    const instance = (await getResp.json()) as {
      kind: string;
      state: string;
      connectionName: string;
      ipAddresses: Array<{ type: string; ipAddress: string }>;
    };

    expect(instance.kind).toBe('sql#instance');
    expect(instance.state).toBe('RUNNABLE');
    expect(instance.connectionName).toBe(`${PROJECT}:us-central1:orders-db`);
    expect(instance.ipAddresses).toEqual([{ type: 'PRIMARY', ipAddress: '127.0.0.1' }]);

    // 4. databases CRUD
    const dbCreateResp = await fetch(url(`/v1/projects/${PROJECT}/instances/orders-db/databases`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'analytics' }),
    });

    expect(dbCreateResp.status).toBe(200);

    const dbListResp = await fetch(url(`/v1/projects/${PROJECT}/instances/orders-db/databases`));
    const dbList = (await dbListResp.json()) as { kind: string; items: Array<{ name: string }> };

    expect(dbList.kind).toBe('sql#databasesList');
    expect(dbList.items.map(d => d.name).sort()).toEqual(['analytics', 'postgres']);

    // 5. users CRUD, including the query-parameter delete quirk
    const userCreateResp = await fetch(url(`/v1/projects/${PROJECT}/instances/orders-db/users`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'analyst', password: 'pw' }),
    });

    expect(userCreateResp.status).toBe(200);

    const userListResp = await fetch(url(`/v1/projects/${PROJECT}/instances/orders-db/users`));
    const userList = (await userListResp.json()) as {
      kind: string;
      items: Array<{ name: string }>;
    };

    expect(userList.kind).toBe('sql#usersList');
    expect(userList.items.map(u => u.name).sort()).toEqual(['analyst', 'postgres']);
    expect(JSON.stringify(userList)).not.toContain('pw');

    const userDeleteResp = await fetch(
      url(`/v1/projects/${PROJECT}/instances/orders-db/users?name=analyst`),
      { method: 'DELETE' }
    );

    expect(userDeleteResp.status).toBe(200);

    // 6. operations.list filtered by instance
    const opsResp = await fetch(url(`/v1/projects/${PROJECT}/operations?instance=orders-db`));
    const opsList = (await opsResp.json()) as { kind: string; items: Array<{ status: string }> };

    expect(opsList.kind).toBe('sql#operationsList');
    expect(opsList.items.length).toBeGreaterThanOrEqual(3);
    expect(opsList.items.every(op => op.status === 'DONE')).toBe(true);

    // 7. Delete the instance
    const deleteResp = await fetch(url(`/v1/projects/${PROJECT}/instances/orders-db`), {
      method: 'DELETE',
    });

    expect(deleteResp.status).toBe(200);

    const goneResp = await fetch(url(`/v1/projects/${PROJECT}/instances/orders-db`));

    expect(goneResp.status).toBe(404);
  });

  test('rejects MySQL instances with a 400 INVALID_ARGUMENT envelope', async () => {
    const resp = await fetch(url(`/v1/projects/${PROJECT}/instances`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'mysql-db', databaseVersion: 'MYSQL_8_0' }),
    });

    expect(resp.status).toBe(400);

    const body = (await resp.json()) as { error: { code: number; status: string } };

    expect(body.error.code).toBe(400);
    expect(body.error.status).toBe('INVALID_ARGUMENT');
  });

  test('update without matching settingsVersion returns 409 FAILED_PRECONDITION', async () => {
    const createResp = await fetch(url(`/v1/projects/${PROJECT}/instances`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'conflict-db', databaseVersion: 'POSTGRES_16' }),
    });

    expect(createResp.status).toBe(200);

    const resp = await fetch(url(`/v1/projects/${PROJECT}/instances/conflict-db`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { settingsVersion: 99 } }),
    });

    expect(resp.status).toBe(409);

    const body = (await resp.json()) as { error: { status: string } };

    expect(body.error.status).toBe('FAILED_PRECONDITION');
  });
});
