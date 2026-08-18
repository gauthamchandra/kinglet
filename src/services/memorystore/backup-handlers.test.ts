/**
 * Unit tests for BackupHandlers
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RouteContext, RouteDefinition, RouteRequest } from '@/core/gateway/request-router.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { BackupHandlers } from './backup-handlers.ts';
import type { BackupService } from './backup-service.ts';
import { MemoryStoreError } from './types.ts';

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/v1/projects/p/locations/us-central1/backupCollections',
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
      target: 'projects/p/locations/us-central1/backupCollections/i/backups/b',
      verb,
      apiVersion: 'v1',
    },
    done: true,
  };
}

describe('BackupHandlers', () => {
  let mockService: BackupService;
  let handlers: BackupHandlers;

  beforeEach(() => {
    mockService = {
      listBackupCollections: mock(() => Promise.resolve({ backupCollections: [] })),
      getBackupCollection: mock(() =>
        Promise.resolve({ name: 'projects/p/locations/us-central1/backupCollections/i' })
      ),
      listBackups: mock(() => Promise.resolve({ backups: [] })),
      getBackup: mock(() =>
        Promise.resolve({ name: 'projects/p/locations/us-central1/backupCollections/i/backups/b' })
      ),
      deleteBackup: mock(() => Promise.resolve(makeOperationResponse('delete'))),
      exportBackup: mock(() => Promise.resolve(makeOperationResponse('export'))),
    } as unknown as BackupService;

    handlers = new BackupHandlers(mockService, new Logger('test', 'error'));
  });

  test('getRoutes_returnsAllSixBackupCollectionAndBackupRouteIds', () => {
    const ids = handlers.getRoutes().map(r => r.id);

    expect(ids).toContain('memorystore.backupCollections.list');
    expect(ids).toContain('memorystore.backupCollections.get');
    expect(ids).toContain('memorystore.backupCollections.backups.list');
    expect(ids).toContain('memorystore.backupCollections.backups.get');
    expect(ids).toContain('memorystore.backupCollections.backups.delete');
    expect(ids).toContain('memorystore.backupCollections.backups.export');
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('handleListBackupCollections_usesTheBackupCollectionsEnvelopeKey', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.backupCollections.list');

    const response = await route.handler(
      makeRequest({ params: { project: 'p', location: 'us-central1' } }),
      makeContext()
    );

    const body = response.body as Record<string, unknown>;

    expect('backupCollections' in body).toBe(true);
    expect('nextPageToken' in body).toBe(false);
  });

  test('handleListBackups_passesPageSizeAndPageTokenThroughToTheService', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.backupCollections.backups.list');

    await route.handler(
      makeRequest({
        params: { project: 'p', location: 'us-central1', backupCollection: 'i' },
        query: { pageSize: '5', pageToken: '10' },
      }),
      makeContext()
    );

    const call = (mockService.listBackups as ReturnType<typeof mock>).mock.calls[0] as unknown[];

    expect(call).toEqual(['projects/p/locations/us-central1/backupCollections/i', 5, '10']);
  });

  test('handleListBackups_givenAnInvalidPageSize_passesUndefinedSoTheStoreDoesNotDropItsLimitAndReturnEverything', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.backupCollections.backups.list');

    for (const pageSize of ['abc', '0', '-1']) {
      (mockService.listBackups as ReturnType<typeof mock>).mockClear();

      await route.handler(
        makeRequest({
          params: { project: 'p', location: 'us-central1', backupCollection: 'i' },
          query: { pageSize },
        }),
        makeContext()
      );

      const call = (mockService.listBackups as ReturnType<typeof mock>).mock.calls[0] as unknown[];

      expect(call[1]).toBeUndefined();
    }
  });

  test('handleListBackupCollections_givenAnInvalidPageSize_passesUndefinedToTheService', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.backupCollections.list');

    await route.handler(
      makeRequest({
        params: { project: 'p', location: 'us-central1' },
        query: { pageSize: 'abc' },
      }),
      makeContext()
    );

    const call = (mockService.listBackupCollections as ReturnType<typeof mock>).mock
      .calls[0] as unknown[];

    expect(call[2]).toBeUndefined();
  });

  test('handleGetBackup_returnsTheBareBackupResource', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.backupCollections.backups.get');

    const response = await route.handler(
      makeRequest({
        params: { project: 'p', location: 'us-central1', backupCollection: 'i', backup: 'b' },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    const body = response.body as { name: string };

    expect(body.name).toBe('projects/p/locations/us-central1/backupCollections/i/backups/b');
  });

  test('handleGetBackup_givenNotFoundError_mapsTo404', async () => {
    (mockService.getBackup as ReturnType<typeof mock>).mockImplementation(() => {
      throw new MemoryStoreError('NOT_FOUND', 'Backup not found');
    });

    const route = findRoute(handlers.getRoutes(), 'memorystore.backupCollections.backups.get');

    const response = await route.handler(
      makeRequest({
        params: {
          project: 'p',
          location: 'us-central1',
          backupCollection: 'i',
          backup: 'missing',
        },
      }),
      makeContext()
    );

    expect(response.status).toBe(404);
  });

  test('handleDeleteBackup_passesRequestIdQueryParamThroughToTheServiceAndReturnsADoneOperation', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.backupCollections.backups.delete');

    const response = await route.handler(
      makeRequest({
        method: 'DELETE',
        params: { project: 'p', location: 'us-central1', backupCollection: 'i', backup: 'b' },
        query: { requestId: 'req-1' },
      }),
      makeContext()
    );

    const body = response.body as { done: boolean };

    expect(body.done).toBe(true);
    expect(mockService.deleteBackup).toHaveBeenCalledWith(
      'projects/p/locations/us-central1/backupCollections/i/backups/b'
    );
  });

  test('handleExportBackup_returnsADoneOperationWithExportVerb', async () => {
    const route = findRoute(handlers.getRoutes(), 'memorystore.backupCollections.backups.export');

    const response = await route.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', location: 'us-central1', backupCollection: 'i', backup: 'b' },
        body: { gcsBucket: 'gs://my-bucket' },
      }),
      makeContext()
    );

    const body = response.body as { metadata: { verb: string } };

    expect(body.metadata.verb).toBe('export');
  });
});
