/**
 * Unit tests for HTTP Response Handlers and Formatters
 */

import { test, expect, describe, beforeEach } from 'bun:test';
import {
  StandardResponseFormatter,
  ResponseUtils,
  createResponseSystem,
  type GcpErrorResponse,
} from './response-handlers.ts';
import { Logger } from '@/shared/utils/logger.ts';

describe('Response Handlers', () => {
  let logger: Logger;
  let formatter: StandardResponseFormatter;
  let utils: ResponseUtils;

  beforeEach(() => {
    logger = new Logger('ResponseHandlerTest', 'error');
    formatter = new StandardResponseFormatter(logger);
    utils = new ResponseUtils(formatter);
  });

  describe('StandardResponseFormatter', () => {
    describe('formatJson', () => {
      test('should format JSON response with default status', () => {
        const data = { message: 'success', id: 123 };
        const response = formatter.formatJson(data);

        expect(response.status).toBe(200);
        expect(response.headers).toEqual({
          'content-type': 'application/json; charset=utf-8',
        });
        expect(response.body).toEqual(data);
      });

      test('should format JSON response with custom status and headers', () => {
        const data = { created: true };
        const response = formatter.formatJson(data, 201, { location: '/api/resource/123' });

        expect(response.status).toBe(201);
        expect(response.headers).toEqual({
          'content-type': 'application/json; charset=utf-8',
          location: '/api/resource/123',
        });
        expect(response.body).toEqual(data);
      });
    });

    describe('formatError', () => {
      test('should format error from Error instance', () => {
        const error = new Error('Something went wrong');
        const response = formatter.formatError(error);

        expect(response.status).toBe(500);
        expect(response.headers).toEqual({
          'content-type': 'application/json; charset=utf-8',
        });

        const body = response.body as GcpErrorResponse;

        expect(body.error.code).toBe(500);
        expect(body.error.message).toBe('Something went wrong');
        expect(body.error.status).toBe('INTERNAL');
      });

      test('should format error from string', () => {
        const response = formatter.formatError('Invalid input provided');

        expect(response.status).toBe(400);
        const body = response.body as GcpErrorResponse;

        expect(body.error.code).toBe(400);
        expect(body.error.message).toBe('Invalid input provided');
        expect(body.error.status).toBe('INVALID_ARGUMENT');
      });

      test('should format error from HTTP status code', () => {
        const response = formatter.formatError(404);

        expect(response.status).toBe(404);
        const body = response.body as GcpErrorResponse;

        expect(body.error.code).toBe(404);
        expect(body.error.message).toBe('Not Found');
        expect(body.error.status).toBe('NOT_FOUND');
      });

      test('should parse specific error patterns', () => {
        const notFoundError = new Error('Resource not found');
        const response = formatter.formatError(notFoundError);

        expect(response.status).toBe(404);
        const body = response.body as GcpErrorResponse;

        expect(body.error.status).toBe('NOT_FOUND');
      });

      test('should include details when provided', () => {
        const error = new Error('Validation failed');
        const details = { field: 'email', value: 'invalid-email' };
        const response = formatter.formatError(error, details);

        const body = response.body as GcpErrorResponse;

        expect(body.error.details).toHaveLength(1);
        if (!body.error.details?.[0]) throw new Error('error details should exist');
        expect(body.error.details[0]['@type']).toBe('type.googleapis.com/google.rpc.DebugInfo');
        expect(body.error.details[0].field).toBe('email');
      });
    });

    describe('formatGcpError', () => {
      test('should format GCP-style error response', () => {
        const response = formatter.formatGcpError(400, 'Invalid argument', 'INVALID_ARGUMENT', [
          {
            '@type': 'type.googleapis.com/google.rpc.BadRequest',
            fieldViolations: [{ field: 'name', description: 'Name is required' }],
          },
        ]);

        expect(response.status).toBe(400);
        expect(response.headers).toEqual({
          'content-type': 'application/json; charset=utf-8',
        });

        const body = response.body as GcpErrorResponse;

        expect(body.error.code).toBe(400);
        expect(body.error.message).toBe('Invalid argument');
        expect(body.error.status).toBe('INVALID_ARGUMENT');
        expect(body.error.details).toHaveLength(1);
      });
    });

    describe('formatEmpty', () => {
      test('should format empty response with default status', () => {
        const response = formatter.formatEmpty();

        expect(response.status).toBe(204);
        expect(response.headers).toEqual({
          'content-length': '0',
        });
        expect(response.body).toBeUndefined();
      });

      test('should format empty response with custom status and headers', () => {
        const response = formatter.formatEmpty(200, { 'custom-header': 'value' });

        expect(response.status).toBe(200);
        expect(response.headers).toEqual({
          'content-length': '0',
          'custom-header': 'value',
        });
      });
    });

    describe('formatStream', () => {
      test('should format streaming response', async () => {
        const mockStream = async function* () {
          yield { event: 'data', value: 1 };
          yield { event: 'data', value: 2 };
        };

        const response = formatter.formatStream(mockStream());

        expect(response.status).toBe(200);
        expect(response.headers).toEqual({
          'content-type': 'application/x-ndjson',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        expect(response.body).toBeDefined();
      });
    });
  });

  describe('ResponseUtils', () => {
    describe('success', () => {
      test('should create successful response', () => {
        const data = { id: 1, name: 'test' };
        const response = utils.success(data);

        expect(response.status).toBe(200);
        expect(response.body).toEqual(data);
      });

      test('should create successful response with custom status', () => {
        const data = { message: 'accepted' };
        const response = utils.success(data, 202);

        expect(response.status).toBe(202);
        expect(response.body).toEqual(data);
      });
    });

    describe('created', () => {
      test('should create resource creation response', () => {
        const data = { id: 123, name: 'new-resource' };
        const response = utils.created(data);

        expect(response.status).toBe(201);
        expect(response.body).toEqual(data);
      });

      test('should create resource creation response with location', () => {
        const data = { id: 123 };
        const response = utils.created(data, '/api/resources/123');

        expect(response.status).toBe(201);
        if (!response.headers) throw new Error('headers should exist');
        expect(response.headers.location).toBe('/api/resources/123');
      });
    });

    describe('updated', () => {
      test('should create resource update response', () => {
        const data = { id: 123, name: 'updated-resource' };
        const response = utils.updated(data);

        expect(response.status).toBe(200);
        expect(response.body).toEqual(data);
      });
    });

    describe('deleted', () => {
      test('should create resource deletion response', () => {
        const response = utils.deleted();

        expect(response.status).toBe(204);
        if (!response.headers) throw new Error('headers should exist');
        expect(response.headers['content-length']).toBe('0');
      });
    });

    describe('notFound', () => {
      test('should create not found response', () => {
        const response = utils.notFound();

        expect(response.status).toBe(404);
        const body = response.body as GcpErrorResponse;

        expect(body.error.message).toBe('Resource not found');
        expect(body.error.status).toBe('NOT_FOUND');
      });

      test('should create not found response with resource details', () => {
        const response = utils.notFound('Topic', 'projects/test/topics/my-topic');

        expect(response.status).toBe(404);
        const body = response.body as GcpErrorResponse;

        expect(body.error.message).toBe('Topic projects/test/topics/my-topic not found');
        if (!body.error.details?.[0]) throw new Error('error details should exist');
        expect(body.error.details[0]).toEqual({
          '@type': 'type.googleapis.com/google.rpc.ResourceInfo',
          resourceType: 'Topic',
          resourceName: 'projects/test/topics/my-topic',
        });
      });
    });

    describe('badRequest', () => {
      test('should create bad request response', () => {
        const response = utils.badRequest('Invalid input');

        expect(response.status).toBe(400);
        const body = response.body as GcpErrorResponse;

        expect(body.error.message).toBe('Invalid input');
        expect(body.error.status).toBe('INVALID_ARGUMENT');
      });

      test('should create bad request response with field violations', () => {
        const fieldViolations = [
          { field: 'name', description: 'Name is required' },
          { field: 'email', description: 'Email format is invalid' },
        ];

        const response = utils.badRequest('Validation failed', fieldViolations);

        expect(response.status).toBe(400);
        const body = response.body as GcpErrorResponse;

        if (!body.error.details?.[0]) throw new Error('error details should exist');
        expect(body.error.details[0]).toEqual({
          '@type': 'type.googleapis.com/google.rpc.BadRequest',
          fieldViolations,
        });
      });
    });

    describe('alreadyExists', () => {
      test('should create already exists response', () => {
        const response = utils.alreadyExists('Topic', 'projects/test/topics/my-topic');

        expect(response.status).toBe(409);
        const body = response.body as GcpErrorResponse;

        expect(body.error.message).toBe('Topic projects/test/topics/my-topic already exists');
        expect(body.error.status).toBe('ALREADY_EXISTS');
      });
    });

    describe('unauthorized', () => {
      test('should create unauthorized response', () => {
        const response = utils.unauthorized();

        expect(response.status).toBe(401);
        const body = response.body as GcpErrorResponse;

        expect(body.error.message).toBe('Authentication required');
        expect(body.error.status).toBe('UNAUTHENTICATED');
      });
    });

    describe('forbidden', () => {
      test('should create forbidden response', () => {
        const response = utils.forbidden();

        expect(response.status).toBe(403);
        const body = response.body as GcpErrorResponse;

        expect(body.error.message).toBe('Insufficient permissions');
        expect(body.error.status).toBe('PERMISSION_DENIED');
      });
    });

    describe('serviceUnavailable', () => {
      test('should create service unavailable response', () => {
        const response = utils.serviceUnavailable();

        expect(response.status).toBe(503);
        const body = response.body as GcpErrorResponse;

        expect(body.error.message).toBe('Service temporarily unavailable');
        expect(body.error.status).toBe('UNAVAILABLE');
      });
    });

    describe('rateLimitExceeded', () => {
      test('should create rate limit exceeded response', () => {
        const response = utils.rateLimitExceeded();

        expect(response.status).toBe(429);
        const body = response.body as GcpErrorResponse;

        expect(body.error.message).toBe('Rate limit exceeded');
        expect(body.error.status).toBe('RESOURCE_EXHAUSTED');
      });

      test('should create rate limit exceeded response with retry-after header', () => {
        const response = utils.rateLimitExceeded(60);

        expect(response.status).toBe(429);
        if (!response.headers) throw new Error('headers should exist');
        expect(response.headers['retry-after']).toBe('60');
      });
    });

    describe('paginated', () => {
      test('should create paginated response with items only', () => {
        const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
        const response = utils.paginated(items);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ items });
      });

      test('should create paginated response with next page token', () => {
        const items = [{ id: 1 }, { id: 2 }];
        const response = utils.paginated(items, 'next-page-token-123');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          items,
          nextPageToken: 'next-page-token-123',
        });
      });

      test('should create paginated response with total size', () => {
        const items = [{ id: 1 }, { id: 2 }];
        const response = utils.paginated(items, undefined, 100);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          items,
          totalSize: 100,
        });
      });

      test('should create complete paginated response', () => {
        const items = [{ id: 1 }, { id: 2 }];
        const response = utils.paginated(items, 'next-token', 100);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          items,
          nextPageToken: 'next-token',
          totalSize: 100,
        });
      });
    });
  });

  describe('createResponseSystem', () => {
    test('should create formatter and utils', () => {
      const system = createResponseSystem(logger);

      expect(system.formatter).toBeInstanceOf(StandardResponseFormatter);
      expect(system.utils).toBeInstanceOf(ResponseUtils);
    });

    test('should create working system', () => {
      const system = createResponseSystem(logger);
      const data = { test: 'data' };
      const response = system.utils.success(data);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(data);
    });
  });
});
