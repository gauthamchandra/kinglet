/**
 * Unit tests for HTTP Request Pipeline Middleware
 */

import { test, expect, describe, beforeEach } from 'bun:test';
import {
  requestLoggingMiddleware,
  corsMiddleware,
  securityHeadersMiddleware,
  requestContextMiddleware,
  requestSizeLimitMiddleware,
  rateLimitMiddleware,
  errorHandlingMiddleware,
  compressionMiddleware,
  createStandardPipeline,
  type RequestContext,
} from './middleware.ts';
import type { HttpRequest, HttpResponse } from './http-server.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { ConfigSchema } from '@/config/schema.ts';

describe('HTTP Middleware', () => {
  let mockLogger: Logger;
  let mockRequest: HttpRequest;
  let mockNext: () => Promise<HttpResponse>;
  let mockResponse: HttpResponse;

  beforeEach(() => {
    mockLogger = new Logger('MiddlewareTest', 'error');

    mockRequest = {
      method: 'GET',
      url: 'http://localhost:8765/test',
      headers: {},
      query: {},
    };

    mockResponse = {
      status: 200,
      body: { message: 'success' },
    };

    mockNext = async () => mockResponse;
  });

  describe('requestLoggingMiddleware', () => {
    test('should log successful requests', async () => {
      const middleware = requestLoggingMiddleware(mockLogger);
      const response = await middleware(mockRequest, mockNext);

      expect(response).toEqual(mockResponse);
    });

    test('should log failed requests', async () => {
      const error = new Error('Test error');
      const failingNext = async () => {
        throw error;
      };

      const middleware = requestLoggingMiddleware(mockLogger);

      await expect(middleware(mockRequest, failingNext)).rejects.toThrow('Test error');
    });
  });

  describe('corsMiddleware', () => {
    test('should add CORS headers to response', async () => {
      const middleware = corsMiddleware();
      const response = await middleware(mockRequest, mockNext);

      expect(response.headers).toHaveProperty('Access-Control-Allow-Origin', '*');
      expect(response.headers).toHaveProperty('Access-Control-Allow-Credentials', 'false');
    });

    test('should handle OPTIONS preflight request', async () => {
      const optionsRequest: HttpRequest = {
        ...mockRequest,
        method: 'OPTIONS',
      };

      const middleware = corsMiddleware({
        origin: 'http://example.com',
        methods: ['GET', 'POST'],
        headers: ['Content-Type'],
      });

      const response = await middleware(optionsRequest, mockNext);

      expect(response.status).toBe(200);
      expect(response.headers).toHaveProperty('Access-Control-Allow-Origin', 'http://example.com');
      expect(response.headers).toHaveProperty('Access-Control-Allow-Methods', 'GET, POST');
      expect(response.headers).toHaveProperty('Access-Control-Allow-Headers', 'Content-Type');
      expect(response.headers).toHaveProperty('Access-Control-Max-Age', '86400');
    });

    test('should handle multiple origins', async () => {
      const middleware = corsMiddleware({
        origin: ['http://example.com', 'http://test.com'],
      });

      const response = await middleware(mockRequest, mockNext);

      expect(response.headers).toHaveProperty(
        'Access-Control-Allow-Origin',
        'http://example.com, http://test.com'
      );
    });
  });

  describe('securityHeadersMiddleware', () => {
    test('should add security headers to response', async () => {
      const middleware = securityHeadersMiddleware();
      const response = await middleware(mockRequest, mockNext);

      expect(response.headers).toHaveProperty('X-Content-Type-Options', 'nosniff');
      expect(response.headers).toHaveProperty('X-Frame-Options', 'DENY');
      expect(response.headers).toHaveProperty('X-XSS-Protection', '1; mode=block');
      expect(response.headers).toHaveProperty('Referrer-Policy', 'strict-origin-when-cross-origin');
      expect(response.headers).toHaveProperty('Content-Security-Policy', "default-src 'self'");
    });
  });

  describe('requestContextMiddleware', () => {
    test('should add request context to request and response headers', async () => {
      const middleware = requestContextMiddleware();
      const response = await middleware(mockRequest, mockNext);

      expect(response.headers).toHaveProperty('X-Request-ID');
      expect(response.headers?.['X-Request-ID']).toMatch(/^req-\d+-[a-z0-9]+$/);
    });

    test('should extract project from URL path', async () => {
      const projectRequest: HttpRequest = {
        ...mockRequest,
        url: 'http://localhost:8765/v1/projects/my-project/topics',
      };

      const middleware = requestContextMiddleware();

      // Create a mock next function that can access the request context
      const contextNext = async () => {
        const context = projectRequest.context as RequestContext;

        expect(context.project).toBe('my-project');

        return mockResponse;
      };

      await middleware(projectRequest, contextNext);
    });

    test('should handle requests without project in path', async () => {
      const middleware = requestContextMiddleware();

      const contextNext = async () => {
        const context = mockRequest.context as RequestContext;

        expect(context.project).toBeUndefined();

        return mockResponse;
      };

      await middleware(mockRequest, contextNext);
    });
  });

  describe('requestSizeLimitMiddleware', () => {
    test('should allow requests within size limit', async () => {
      const smallRequest: HttpRequest = {
        ...mockRequest,
        headers: {
          'content-length': '1000',
        },
      };

      const middleware = requestSizeLimitMiddleware(10000); // 10KB limit
      const response = await middleware(smallRequest, mockNext);

      expect(response).toEqual(mockResponse);
    });

    test('should reject requests exceeding size limit', async () => {
      const largeRequest: HttpRequest = {
        ...mockRequest,
        headers: {
          'content-length': '20000',
        },
      };

      const middleware = requestSizeLimitMiddleware(10000); // 10KB limit
      const response = await middleware(largeRequest, mockNext);

      expect(response.status).toBe(413);
      expect(response.body).toHaveProperty('error');
      expect((response.body as { error: { message: string } }).error.message).toBe(
        'Request entity too large'
      );
    });

    test('should allow requests without content-length header', async () => {
      const middleware = requestSizeLimitMiddleware(10000);
      const response = await middleware(mockRequest, mockNext);

      expect(response).toEqual(mockResponse);
    });
  });

  describe('rateLimitMiddleware', () => {
    test('should allow requests within rate limit', async () => {
      const middleware = rateLimitMiddleware({
        windowMs: 60000, // 1 minute
        maxRequests: 10,
      });

      const response = await middleware(mockRequest, mockNext);

      expect(response.status).toBe(200);
      expect(response.headers).toHaveProperty('x-ratelimit-limit', '10');
      expect(response.headers).toHaveProperty('x-ratelimit-remaining', '9');
    });

    test('should reject requests exceeding rate limit', async () => {
      const middleware = rateLimitMiddleware({
        windowMs: 60000, // 1 minute
        maxRequests: 2,
      });

      // First two requests should succeed
      await middleware(mockRequest, mockNext);
      await middleware(mockRequest, mockNext);

      // Third request should be rate limited
      const response = await middleware(mockRequest, mockNext);

      expect(response.status).toBe(429);
      expect(response.headers).toHaveProperty('retry-after');
      expect(response.body).toHaveProperty('error');
      expect((response.body as { error: { message: string } }).error.message).toBe(
        'Too many requests'
      );
    });

    test('should reset rate limit after window expires', async () => {
      const middleware = rateLimitMiddleware({
        windowMs: 10, // 10ms window for quick testing
        maxRequests: 1,
      });

      // First request should succeed
      const response1 = await middleware(mockRequest, mockNext);

      expect(response1.status).toBe(200);

      // Second request should be rate limited
      const response2 = await middleware(mockRequest, mockNext);

      expect(response2.status).toBe(429);

      // Wait for window to expire
      await new Promise(resolve => setTimeout(resolve, 20));

      // Third request should succeed again
      const response3 = await middleware(mockRequest, mockNext);

      expect(response3.status).toBe(200);
    }, 100);
  });

  describe('errorHandlingMiddleware', () => {
    test('should handle generic errors', async () => {
      const error = new Error('Generic error');
      const failingNext = async () => {
        throw error;
      };

      const middleware = errorHandlingMiddleware(mockLogger);
      const response = await middleware(mockRequest, failingNext);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: {
          code: 500,
          message: 'Internal Server Error',
          details: undefined,
        },
      });
    });

    test('should handle not found errors', async () => {
      const error = new Error('Resource not found');
      const failingNext = async () => {
        throw error;
      };

      const middleware = errorHandlingMiddleware(mockLogger);
      const response = await middleware(mockRequest, failingNext);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: {
          code: 404,
          message: 'Not Found',
          details: undefined,
        },
      });
    });

    test('should handle validation errors', async () => {
      const error = new Error('validation failed: invalid input');
      const failingNext = async () => {
        throw error;
      };

      const middleware = errorHandlingMiddleware(mockLogger);
      const response = await middleware(mockRequest, failingNext);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          code: 400,
          message: 'Bad Request',
          details: 'validation failed: invalid input',
        },
      });
    });
  });

  describe('compressionMiddleware', () => {
    test('should add compression headers for compressible content', async () => {
      const compressibleRequest: HttpRequest = {
        ...mockRequest,
        headers: {
          'accept-encoding': 'gzip, deflate',
        },
      };

      const jsonResponse: HttpResponse = {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
        body: { message: 'success' },
      };

      const jsonNext = async () => jsonResponse;

      const middleware = compressionMiddleware();
      const response = await middleware(compressibleRequest, jsonNext);

      expect(response.headers).toHaveProperty('content-encoding', 'gzip');
      expect(response.headers).toHaveProperty('vary', 'Accept-Encoding');
    });

    test('should not compress non-compressible content', async () => {
      const compressibleRequest: HttpRequest = {
        ...mockRequest,
        headers: {
          'accept-encoding': 'gzip, deflate',
        },
      };

      const imageResponse: HttpResponse = {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
        },
        body: 'binary-image-data',
      };

      const imageNext = async () => imageResponse;

      const middleware = compressionMiddleware();
      const response = await middleware(compressibleRequest, imageNext);

      expect(response.headers).not.toHaveProperty('content-encoding');
    });

    test('should not compress when client does not accept compression', async () => {
      const noCompressionRequest: HttpRequest = {
        ...mockRequest,
        headers: {},
      };

      const middleware = compressionMiddleware();
      const response = await middleware(noCompressionRequest, mockNext);

      expect(response).toEqual(mockResponse);
      expect(response.headers).not.toHaveProperty('content-encoding');
    });
  });

  describe('createStandardPipeline', () => {
    test('should create middleware pipeline with all standard components', () => {
      const config = ConfigSchema.parse({
        server: {},
        storage: {},
        auth: {},
        services: { pubsub: {}, scheduler: {}, tasks: {}, secrets: {} },
        logging: {},
      });
      const pipeline = createStandardPipeline(config, mockLogger);

      expect(pipeline).toHaveLength(8);
      expect(typeof pipeline[0]).toBe('function');
      expect(typeof pipeline[7]).toBe('function');
    });

    test('should execute middleware pipeline in order', async () => {
      const config = ConfigSchema.parse({
        server: {},
        storage: {},
        auth: {},
        services: { pubsub: {}, scheduler: {}, tasks: {}, secrets: {} },
        logging: {},
      });
      const pipeline = createStandardPipeline(config, mockLogger);

      // Create a request that will go through the entire pipeline
      const testRequest: HttpRequest = {
        method: 'GET',
        url: 'http://localhost:8765/v1/projects/test-project/test',
        headers: {
          'accept-encoding': 'gzip',
          'user-agent': 'test-agent',
        },
        query: {},
      };

      // Create a simple handler that returns success
      const handler = async (): Promise<HttpResponse> => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { message: 'success' },
      });

      // Execute the pipeline by chaining middleware
      let currentHandler = handler;

      for (let i = pipeline.length - 1; i >= 0; i--) {
        const middleware = pipeline[i];

        if (!middleware) {
          throw new Error(`Middleware not found at index ${i}`);
        }

        const nextHandler = currentHandler;

        currentHandler = async () => middleware(testRequest, nextHandler);
      }

      const response = await currentHandler();

      // Verify that middleware added expected headers
      expect(response.status).toBe(200);
      expect(response.headers).toHaveProperty('X-Request-ID');
      expect(response.headers).toHaveProperty('Access-Control-Allow-Origin');
      expect(response.headers).toHaveProperty('X-Content-Type-Options');
    });
  });
});
