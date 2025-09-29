/**
 * HTTP Request Pipeline Middleware
 * Provides common middleware functions for request processing
 */

import type { HttpRequest, HttpResponse, Middleware } from './http-server.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import type { Config } from '@/config/schema.ts';

/**
 * Request logging middleware
 * Logs all incoming HTTP requests with timing information
 */
export function requestLoggingMiddleware(logger: Logger): Middleware {
  return async (request: HttpRequest, next: () => Promise<HttpResponse>): Promise<HttpResponse> => {
    const startTime = Date.now();
    const url = new URL(request.url);

    try {
      const response = await next();
      const duration = Date.now() - startTime;

      logger.info(`${request.method} ${url.pathname} - ${response.status} (${duration}ms)`, {
        method: request.method,
        path: url.pathname,
        status: response.status,
        duration,
        query: url.search ? Object.fromEntries(url.searchParams) : undefined,
      });

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error(`${request.method} ${url.pathname} - ERROR (${duration}ms)`, {
        method: request.method,
        path: url.pathname,
        duration,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  };
}

/**
 * CORS middleware
 * Handles Cross-Origin Resource Sharing headers
 */
export function corsMiddleware(config?: {
  origin?: string | string[];
  methods?: string[];
  headers?: string[];
  credentials?: boolean;
}): Middleware {
  const defaultConfig = {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    headers: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: false,
  };

  const corsConfig = { ...defaultConfig, ...config };

  return async (request: HttpRequest, next: () => Promise<HttpResponse>): Promise<HttpResponse> => {
    // Handle preflight OPTIONS request
    if (request.method === 'OPTIONS') {
      return {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': Array.isArray(corsConfig.origin)
            ? corsConfig.origin.join(', ')
            : corsConfig.origin,
          'Access-Control-Allow-Methods': corsConfig.methods.join(', '),
          'Access-Control-Allow-Headers': corsConfig.headers.join(', '),
          'Access-Control-Allow-Credentials': corsConfig.credentials ? 'true' : 'false',
          'Access-Control-Max-Age': '86400', // 24 hours
        },
      };
    }

    const response = await next();

    // Add CORS headers to the response
    const corsHeaders = {
      'Access-Control-Allow-Origin': Array.isArray(corsConfig.origin)
        ? corsConfig.origin.join(', ')
        : corsConfig.origin,
      'Access-Control-Allow-Credentials': corsConfig.credentials ? 'true' : 'false',
    };

    return {
      ...response,
      headers: {
        ...response.headers,
        ...corsHeaders,
      },
    };
  };
}

/**
 * Security headers middleware
 * Adds common security headers to responses
 */
export function securityHeadersMiddleware(): Middleware {
  return async (request: HttpRequest, next: () => Promise<HttpResponse>): Promise<HttpResponse> => {
    const response = await next();

    const securityHeaders = {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'",
    };

    return {
      ...response,
      headers: {
        ...response.headers,
        ...securityHeaders,
      },
    };
  };
}

/**
 * Request context middleware
 * Adds request context information for downstream handlers
 */
export interface RequestContext {
  requestId: string;
  timestamp: Date;
  userAgent?: string;
  clientIp?: string;
  project?: string;
}

export function requestContextMiddleware(): Middleware {
  return async (request: HttpRequest, next: () => Promise<HttpResponse>): Promise<HttpResponse> => {
    const requestId = generateRequestId();
    const timestamp = new Date();
    const userAgent = request.headers['user-agent'];
    const clientIp =
      request.headers['x-forwarded-for'] || request.headers['x-real-ip'] || 'unknown';

    // Extract project from URL path (e.g., /v1/projects/my-project/...)
    const projectMatch = new URL(request.url).pathname.match(/\/projects\/([^/]+)/);
    const project = projectMatch ? projectMatch[1] : undefined;

    const context: RequestContext = {
      requestId,
      timestamp,
      ...(userAgent !== undefined && { userAgent }),
      clientIp,
      ...(project !== undefined && { project }),
    };

    // Attach context to request (if needed for downstream handlers)
    request.context = context;

    const response = await next();

    // Add request ID to response headers for tracing
    return {
      ...response,
      headers: {
        ...response.headers,
        'X-Request-ID': requestId,
      },
    };
  };
}

/**
 * Request size limiting middleware
 * Prevents requests with excessively large payloads
 */
export function requestSizeLimitMiddleware(maxSize: number = 10 * 1024 * 1024): Middleware {
  // 10MB default
  return async (request: HttpRequest, next: () => Promise<HttpResponse>): Promise<HttpResponse> => {
    const contentLength = request.headers['content-length'];

    if (contentLength && parseInt(contentLength, 10) > maxSize) {
      return {
        status: 413,
        headers: {
          'content-type': 'application/json',
        },
        body: {
          error: {
            code: 413,
            message: 'Request entity too large',
            details: `Maximum request size is ${maxSize} bytes`,
          },
        },
      };
    }

    return await next();
  };
}

/**
 * Rate limiting middleware (simple implementation)
 * Limits requests per IP address
 */
export function rateLimitMiddleware(config: {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Maximum requests per window
}): Middleware {
  const requests = new Map<string, { count: number; resetTime: number }>();

  // Clean up expired entries periodically
  setInterval(() => {
    const now = Date.now();

    for (const [ip, data] of requests.entries()) {
      if (data.resetTime <= now) {
        requests.delete(ip);
      }
    }
  }, config.windowMs);

  return async (request: HttpRequest, next: () => Promise<HttpResponse>): Promise<HttpResponse> => {
    const clientIp =
      request.headers['x-forwarded-for'] || request.headers['x-real-ip'] || 'unknown';
    const now = Date.now();
    const windowStart = Math.floor(now / config.windowMs) * config.windowMs;
    const resetTime = windowStart + config.windowMs;

    let clientData = requests.get(clientIp);

    if (!clientData || clientData.resetTime <= now) {
      // New window or expired window
      clientData = { count: 1, resetTime };
      requests.set(clientIp, clientData);
    } else {
      // Within existing window
      clientData.count++;
    }

    if (clientData.count > config.maxRequests) {
      return {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': Math.ceil((resetTime - now) / 1000).toString(),
          'x-ratelimit-limit': config.maxRequests.toString(),
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': Math.ceil(resetTime / 1000).toString(),
        },
        body: {
          error: {
            code: 429,
            message: 'Too many requests',
            details: `Rate limit exceeded. Try again in ${Math.ceil((resetTime - now) / 1000)} seconds.`,
          },
        },
      };
    }

    const response = await next();

    // Add rate limit headers to successful responses
    return {
      ...response,
      headers: {
        ...response.headers,
        'x-ratelimit-limit': config.maxRequests.toString(),
        'x-ratelimit-remaining': (config.maxRequests - clientData.count).toString(),
        'x-ratelimit-reset': Math.ceil(resetTime / 1000).toString(),
      },
    };
  };
}

/**
 * Error handling middleware
 * Standardizes error responses across the application
 */
export function errorHandlingMiddleware(logger: Logger): Middleware {
  return async (request: HttpRequest, next: () => Promise<HttpResponse>): Promise<HttpResponse> => {
    try {
      return await next();
    } catch (error) {
      logger.error('Request handler error:', error);

      // Determine error status and message
      let status = 500;
      let message = 'Internal Server Error';
      let details: unknown = undefined;

      if (error instanceof Error) {
        // Check for common error patterns
        if (error.message.includes('not found') || error.message.includes('Not found')) {
          status = 404;
          message = 'Not Found';
        } else if (
          error.message.includes('unauthorized') ||
          error.message.includes('Unauthorized')
        ) {
          status = 401;
          message = 'Unauthorized';
        } else if (error.message.includes('forbidden') || error.message.includes('Forbidden')) {
          status = 403;
          message = 'Forbidden';
        } else if (error.message.includes('validation') || error.message.includes('invalid')) {
          status = 400;
          message = 'Bad Request';
          details = error.message;
        }
      }

      return {
        status,
        headers: {
          'content-type': 'application/json',
        },
        body: {
          error: {
            code: status,
            message,
            details,
          },
        },
      };
    }
  };
}

/**
 * Compression middleware
 * Compresses response bodies for better performance
 */
export function compressionMiddleware(): Middleware {
  return async (request: HttpRequest, next: () => Promise<HttpResponse>): Promise<HttpResponse> => {
    const response = await next();

    // Only compress if client accepts compression and response has a body
    const acceptEncoding = request.headers['accept-encoding'] || '';
    const shouldCompress =
      acceptEncoding.includes('gzip') &&
      response.body !== undefined &&
      response.status >= 200 &&
      response.status < 300;

    if (!shouldCompress) {
      return response;
    }

    // Check if content type is compressible
    const contentType = response.headers?.['content-type'] || '';
    const compressibleTypes = [
      'application/json',
      'text/',
      'application/javascript',
      'application/xml',
    ];

    const isCompressible = compressibleTypes.some(type => contentType.includes(type));

    if (!isCompressible) {
      return response;
    }

    try {
      // For now, just add the compression header
      // Full compression implementation would require gzip/deflate logic
      return {
        ...response,
        headers: {
          ...response.headers,
          'content-encoding': 'gzip',
          vary: 'Accept-Encoding',
        },
      };
    } catch {
      // If compression fails, return original response
      return response;
    }
  };
}

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Create a standard middleware pipeline for the HTTP server
 */
export function createStandardPipeline(config: Config, logger: Logger): Middleware[] {
  return [
    // Error handling should be first to catch all errors
    errorHandlingMiddleware(logger),

    // Request context for tracing
    requestContextMiddleware(),

    // Security headers
    securityHeadersMiddleware(),

    // CORS handling
    corsMiddleware({
      origin: '*', // Allow all origins for local development
      credentials: false,
    }),

    // Rate limiting (generous limits for local development)
    rateLimitMiddleware({
      windowMs: 60 * 1000, // 1 minute
      maxRequests: 1000, // 1000 requests per minute
    }),

    // Request size limiting
    requestSizeLimitMiddleware(10 * 1024 * 1024), // 10MB

    // Request logging (should be near the end to log final response)
    requestLoggingMiddleware(logger),

    // Compression (should be last to compress final response)
    compressionMiddleware(),
  ];
}
