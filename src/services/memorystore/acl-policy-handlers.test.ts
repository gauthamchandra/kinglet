/**
 * Unit tests for AclPolicyHandlers
 *
 * Pins down the response-shape asymmetry the discovery document mandates:
 * aclPolicies.create returns a bare AclPolicy while .patch/.delete return an Operation.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RouteContext, RouteDefinition, RouteRequest } from '@/core/gateway/request-router.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { AclPolicyHandlers } from './acl-policy-handlers.ts';
import type { AclPolicyService } from './acl-policy-service.ts';
import { MemoryStoreError } from './types.ts';

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/v1/projects/p/locations/us-central1/aclPolicies',
    query: {},
    headers: {},
    params: {},
    body: undefined,
    originalRequest: new Request('http://localhost'),
    ...overrides,
  };
}

function makeContext(): RouteContext {
  return {
    routeId: 'test',
    startTime: Date.now(),
    metadata: {},
    logger: new Logger('test', 'error'),
  };
}

function findRoute(routes: RouteDefinition[], id: string) {
  const route = routes.find(r => r.id === id);

  if (!route) throw new Error(`Route ${id} not found`);

  return route;
}

function makeOperationResponse(verb: string) {
  return {
    name: 'projects/p/locations/us-central1/operations/op-1',
    metadata: {
      '@type': 'type.googleapis.com/google.cloud.memorystore.v1.OperationMetadata',
      createTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:00:00.000Z',
      target: 'projects/p/locations/us-central1/aclPolicies/policy-1',
      verb,
      apiVersion: 'v1',
    },
    done: true,
  };
}

describe('AclPolicyHandlers', () => {
  let mockService: AclPolicyService;
  let handlers: AclPolicyHandlers;

  beforeEach(() => {
    mockService = {
      createAclPolicy: mock(() =>
        Promise.resolve({
          name: 'projects/p/locations/us-central1/aclPolicies/policy-1',
          state: 'ACTIVE',
          rules: [],
        })
      ),
      getAclPolicy: mock(() =>
        Promise.resolve({ name: 'projects/p/locations/us-central1/aclPolicies/policy-1' })
      ),
      listAclPolicies: mock(() => Promise.resolve({ aclPolicies: [] })),
      updateAclPolicy: mock(() => Promise.resolve(makeOperationResponse('update'))),
      deleteAclPolicy: mock(() => Promise.resolve(makeOperationResponse('delete'))),
      listAclPolicyRevisions: mock(() => Promise.resolve({ aclPolicyRevisions: [] })),
      getAclPolicyRevision: mock(() =>
        Promise.resolve({
          name: 'projects/p/locations/us-central1/aclPolicies/policy-1/revisions/1',
        })
      ),
    } as unknown as AclPolicyService;

    handlers = new AclPolicyHandlers(mockService, new Logger('test', 'error'));
  });

  test('handleCreateAclPolicy_returnsTheBareAclPolicyResourceWithoutDoneOrMetadata', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.aclPolicies.create');

    const response = await route.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', location: 'us-central1' },
        query: { aclPolicyId: 'policy-1' },
        body: { rules: [] },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;

    expect(body.name).toBe('projects/p/locations/us-central1/aclPolicies/policy-1');
    expect('done' in body).toBe(false);
    expect('metadata' in body).toBe(false);
  });

  test('handleCreateAclPolicy_missingAclPolicyId_returnsBadRequestAndPersistsNothing', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.aclPolicies.create');

    const response = await route.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', location: 'us-central1' },
        query: {},
        body: { rules: [] },
      }),
      makeContext()
    );

    expect(response.status).toBe(400);
    expect(mockService.createAclPolicy).not.toHaveBeenCalled();
  });

  test('handleUpdateAclPolicy_returnsAnOperationWithDoneTrue', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.aclPolicies.patch');

    const response = await route.handler(
      makeRequest({
        method: 'PATCH',
        params: { project: 'p', location: 'us-central1', aclPolicy: 'policy-1' },
        query: { updateMask: 'rules' },
        body: { rules: [] },
      }),
      makeContext()
    );

    const body = response.body as { done: boolean };

    expect(body.done).toBe(true);
  });

  test('handleDeleteAclPolicy_returnsAnOperationWithDoneTrue', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.aclPolicies.delete');

    const response = await route.handler(
      makeRequest({
        method: 'DELETE',
        params: { project: 'p', location: 'us-central1', aclPolicy: 'policy-1' },
        query: { etag: 'etag-1' },
      }),
      makeContext()
    );

    const body = response.body as { done: boolean };

    expect(body.done).toBe(true);
    expect(mockService.deleteAclPolicy).toHaveBeenCalled();
  });

  test('handleDeleteAclPolicy_givenEtagMismatch_mapsTo409Aborted', async () => {
    (mockService.deleteAclPolicy as ReturnType<typeof mock>).mockImplementation(() => {
      throw new MemoryStoreError('ABORTED', 'Etag mismatch');
    });

    const route = findRoute(handlers.getRoutes(), 'memorystore.aclPolicies.delete');

    const response = await route.handler(
      makeRequest({
        method: 'DELETE',
        params: { project: 'p', location: 'us-central1', aclPolicy: 'policy-1' },
        query: { etag: 'stale-etag' },
      }),
      makeContext()
    );

    const body = response.body as { error: { status: string } };

    expect(response.status).toBe(409);
    expect(body.error.status).toBe('ABORTED');
  });

  test('handleListAclPolicyRevisions_usesTheAclPolicyRevisionsEnvelopeKey', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.aclPolicies.revisions.list');

    const response = await route.handler(
      makeRequest({ params: { project: 'p', location: 'us-central1', aclPolicy: 'policy-1' } }),
      makeContext()
    );

    const body = response.body as Record<string, unknown>;

    expect('aclPolicyRevisions' in body).toBe(true);
  });

  test('handleListAclPolicies_givenAnInvalidPageSize_passesUndefinedToTheService', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.aclPolicies.list');

    await route.handler(
      makeRequest({ params: { project: 'p', location: 'us-central1' }, query: { pageSize: '0' } }),
      makeContext()
    );

    const call = (mockService.listAclPolicies as ReturnType<typeof mock>).mock
      .calls[0] as unknown[];

    expect(call[2]).toBeUndefined();
  });

  test('handleListAclPolicyRevisions_givenAnInvalidPageSize_passesUndefinedToTheService', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.aclPolicies.revisions.list');

    await route.handler(
      makeRequest({
        params: { project: 'p', location: 'us-central1', aclPolicy: 'policy-1' },
        query: { pageSize: 'abc' },
      }),
      makeContext()
    );

    const call = (mockService.listAclPolicyRevisions as ReturnType<typeof mock>).mock
      .calls[0] as unknown[];

    expect(call[1]).toBeUndefined();
  });

  test('getRoutes_returnsAllSevenAclPolicyAndRevisionRouteIds', () => {
    const ids = handlers.getRoutes().map(r => r.id);

    expect(ids).toContain('memorystore.aclPolicies.create');
    expect(ids).toContain('memorystore.aclPolicies.list');
    expect(ids).toContain('memorystore.aclPolicies.get');
    expect(ids).toContain('memorystore.aclPolicies.patch');
    expect(ids).toContain('memorystore.aclPolicies.delete');
    expect(ids).toContain('memorystore.aclPolicies.revisions.list');
    expect(ids).toContain('memorystore.aclPolicies.revisions.get');
    expect(new Set(ids).size).toBe(ids.length);
  });
});
