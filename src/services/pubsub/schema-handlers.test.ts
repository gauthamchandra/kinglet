/**
 * Unit tests for SchemaHandlers
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RouteContext, RouteRequest } from '@/core/gateway/request-router.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { SchemaHandlers } from './schema-handlers.ts';
import type { SchemaService } from './schema-service.ts';
import { PubSubError } from './types.ts';

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/v1/projects/p/schemas',
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

function findRoute(handlers: SchemaHandlers, id: string) {
  const route = handlers.getRoutes().find(r => r.id === id);

  if (!route) throw new Error(`Route ${id} not found`);

  return route;
}

describe('SchemaHandlers', () => {
  let mockService: SchemaService;
  let handlers: SchemaHandlers;

  beforeEach(() => {
    mockService = {
      createSchema: mock(() =>
        Promise.resolve({
          name: 'projects/p/schemas/s',
          type: 'AVRO',
          revisionId: 'rev-1',
          revisionCreateTime: '2024-01-01T00:00:00.000Z',
        })
      ),
      getSchema: mock(() =>
        Promise.resolve({
          name: 'projects/p/schemas/s',
          type: 'AVRO',
          revisionId: 'rev-1',
          revisionCreateTime: '2024-01-01T00:00:00.000Z',
        })
      ),
      listSchemas: mock(() =>
        Promise.resolve({
          schemas: [
            {
              name: 'projects/p/schemas/s',
              type: 'AVRO',
              revisionId: 'rev-1',
              revisionCreateTime: '2024-01-01T00:00:00.000Z',
            },
          ],
        })
      ),
      deleteSchema: mock(() => Promise.resolve()),
      commitSchema: mock(() =>
        Promise.resolve({
          name: 'projects/p/schemas/s',
          type: 'AVRO',
          definition: '{"new":"def"}',
          revisionId: 'rev-2',
          revisionCreateTime: '2024-02-01T00:00:00.000Z',
        })
      ),
      rollbackSchema: mock(() =>
        Promise.resolve({
          name: 'projects/p/schemas/s',
          type: 'AVRO',
          revisionId: 'rev-1',
          revisionCreateTime: '2024-01-01T00:00:00.000Z',
        })
      ),
      listRevisions: mock(() =>
        Promise.resolve({
          schemas: [
            {
              name: 'projects/p/schemas/s',
              type: 'AVRO',
              revisionId: 'rev-1',
              revisionCreateTime: '2024-01-01T00:00:00.000Z',
            },
          ],
        })
      ),
      deleteRevision: mock(() =>
        Promise.resolve({
          name: 'projects/p/schemas/s',
          type: 'AVRO',
          revisionId: 'rev-1',
          revisionCreateTime: '2024-01-01T00:00:00.000Z',
        })
      ),
      validateSchema: mock(() => Promise.resolve({})),
      validateMessage: mock(() => Promise.resolve({})),
    } as unknown as SchemaService;

    handlers = new SchemaHandlers(mockService, new Logger('test', 'error'));
  });

  test('getRoutes returns all 10 route definitions', () => {
    const routes = handlers.getRoutes();

    expect(routes.length).toBe(10);

    const ids = routes.map(r => r.id);

    expect(ids).toContain('pubsub.schemas.create');
    expect(ids).toContain('pubsub.schemas.get');
    expect(ids).toContain('pubsub.schemas.list');
    expect(ids).toContain('pubsub.schemas.delete');
    expect(ids).toContain('pubsub.schemas.commit');
    expect(ids).toContain('pubsub.schemas.rollback');
    expect(ids).toContain('pubsub.schemas.listRevisions');
    expect(ids).toContain('pubsub.schemas.deleteRevision');
    expect(ids).toContain('pubsub.schemas.validate');
    expect(ids).toContain('pubsub.schemas.validateMessage');
  });

  test('handleCreateSchema returns 200 with schema', async () => {
    const createRoute = findRoute(handlers, 'pubsub.schemas.create');

    const response = await createRoute.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p' },
        query: { schemaId: 's' },
        body: { type: 'AVRO' },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.createSchema).toHaveBeenCalled();
  });

  test('handleGetSchema returns 200 with schema', async () => {
    const getRoute = findRoute(handlers, 'pubsub.schemas.get');

    const response = await getRoute.handler(
      makeRequest({
        params: { project: 'p', schema: 's' },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.getSchema).toHaveBeenCalled();
  });

  test('handleGetSchema returns 404 when NOT_FOUND', async () => {
    (mockService.getSchema as ReturnType<typeof mock>).mockImplementation(() => {
      throw new PubSubError('NOT_FOUND', 'Schema not found');
    });

    const getRoute = findRoute(handlers, 'pubsub.schemas.get');

    const response = await getRoute.handler(
      makeRequest({
        params: { project: 'p', schema: 'missing' },
      }),
      makeContext()
    );

    expect(response.status).toBe(404);
  });

  test('handleListSchemas returns 200 with schemas array', async () => {
    const listRoute = findRoute(handlers, 'pubsub.schemas.list');

    const response = await listRoute.handler(
      makeRequest({
        params: { project: 'p' },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.listSchemas).toHaveBeenCalled();
  });

  test('handleDeleteSchema returns 200', async () => {
    const deleteRoute = findRoute(handlers, 'pubsub.schemas.delete');

    const response = await deleteRoute.handler(
      makeRequest({
        method: 'DELETE',
        params: { project: 'p', schema: 's' },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.deleteSchema).toHaveBeenCalled();
  });

  test('handleDeleteSchema returns 404 when NOT_FOUND', async () => {
    (mockService.deleteSchema as ReturnType<typeof mock>).mockImplementation(() => {
      throw new PubSubError('NOT_FOUND', 'Schema not found');
    });

    const deleteRoute = findRoute(handlers, 'pubsub.schemas.delete');

    const response = await deleteRoute.handler(
      makeRequest({
        method: 'DELETE',
        params: { project: 'p', schema: 'missing' },
      }),
      makeContext()
    );

    expect(response.status).toBe(404);
  });

  test('handleCommitSchema returns 200', async () => {
    const commitRoute = findRoute(handlers, 'pubsub.schemas.commit');

    const response = await commitRoute.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', schema: 's' },
        body: { schema: { type: 'AVRO', definition: '{}' } },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.commitSchema).toHaveBeenCalled();
  });

  test('handleRollbackSchema returns 200', async () => {
    const rollbackRoute = findRoute(handlers, 'pubsub.schemas.rollback');

    const response = await rollbackRoute.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p', schema: 's' },
        body: { revisionId: 'rev-1' },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.rollbackSchema).toHaveBeenCalled();
  });

  test('handleListRevisions returns 200', async () => {
    const listRevsRoute = findRoute(handlers, 'pubsub.schemas.listRevisions');

    const response = await listRevsRoute.handler(
      makeRequest({
        params: { project: 'p', schema: 's' },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.listRevisions).toHaveBeenCalled();
  });

  test('handleValidateSchema returns 200', async () => {
    const validateRoute = findRoute(handlers, 'pubsub.schemas.validate');

    const response = await validateRoute.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p' },
        body: { schema: { type: 'AVRO', definition: '{}' } },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.validateSchema).toHaveBeenCalled();
  });

  test('handleValidateMessage returns 200', async () => {
    const validateMsgRoute = findRoute(handlers, 'pubsub.schemas.validateMessage');

    const response = await validateMsgRoute.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p' },
        body: { message: 'dGVzdA==' },
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockService.validateMessage).toHaveBeenCalled();
  });

  test('ALREADY_EXISTS maps to 409', async () => {
    (mockService.createSchema as ReturnType<typeof mock>).mockImplementation(() => {
      throw new PubSubError('ALREADY_EXISTS', 'Schema already exists');
    });

    const createRoute = findRoute(handlers, 'pubsub.schemas.create');

    const response = await createRoute.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p' },
        query: { schemaId: 's' },
        body: { type: 'AVRO' },
      }),
      makeContext()
    );

    expect(response.status).toBe(409);
  });

  test('INVALID_ARGUMENT maps to 400', async () => {
    (mockService.createSchema as ReturnType<typeof mock>).mockImplementation(() => {
      throw new PubSubError('INVALID_ARGUMENT', 'Bad request');
    });

    const createRoute = findRoute(handlers, 'pubsub.schemas.create');

    const response = await createRoute.handler(
      makeRequest({
        method: 'POST',
        params: { project: 'p' },
        query: { schemaId: 's' },
        body: {},
      }),
      makeContext()
    );

    expect(response.status).toBe(400);
  });
});
