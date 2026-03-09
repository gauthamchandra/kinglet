/**
 * HTTP Response Handlers and Formatters
 * Provides consistent response formatting across the application
 */

import type { Logger } from '@/shared/utils/logger.ts';
import type { RouteResponse } from './request-router.ts';

export interface GcpErrorDetail {
  '@type': string;
  [key: string]: unknown;
}

export interface GcpError {
  code: number;
  message: string;
  status: string;
  details?: GcpErrorDetail[];
}

export interface GcpErrorResponse {
  error: GcpError;
}

export interface ResponseFormatter {
  formatJson<T>(data: T, status?: number, headers?: Record<string, string>): RouteResponse;
  formatError(error: Error | string | number, details?: unknown): RouteResponse;
  formatGcpError(
    code: number,
    message: string,
    status: string,
    details?: GcpErrorDetail[]
  ): RouteResponse;
  formatEmpty(status?: number, headers?: Record<string, string>): RouteResponse;
  formatStream(
    data: AsyncIterable<unknown>,
    status?: number,
    headers?: Record<string, string>
  ): RouteResponse;
}

export class StandardResponseFormatter implements ResponseFormatter {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Format a successful JSON response
   */
  formatJson<T>(
    data: T,
    status: number = 200,
    headers: Record<string, string> = {}
  ): RouteResponse {
    const responseHeaders = {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    };

    return {
      status,
      headers: responseHeaders,
      body: data,
    };
  }

  /**
   * Format an error response with consistent structure
   */
  formatError(error: Error | string | number, details?: unknown): RouteResponse {
    let code = 500;
    let message = 'Internal Server Error';
    let status = 'INTERNAL';

    if (typeof error === 'number') {
      code = error;
      ({ message, status } = this.getErrorInfo(code));
    } else if (typeof error === 'string') {
      message = error;
      code = 400;
      status = 'INVALID_ARGUMENT';
    } else if (error instanceof Error) {
      message = error.message;
      const errorInfo = this.parseErrorMessage(error.message);

      code = errorInfo.code;
      status = errorInfo.status;
    }

    const errorDetails = details
      ? [
          {
            '@type': 'type.googleapis.com/google.rpc.DebugInfo',
            ...(typeof details === 'object' && details !== null
              ? (details as Record<string, unknown>)
              : { value: details }),
          },
        ]
      : undefined;

    const errorResponse: GcpErrorResponse = {
      error: {
        code,
        message,
        status,
        ...(errorDetails && { details: errorDetails }),
      },
    };

    this.logger.warn(`Error response: ${code} ${message}`, { error, details });

    return {
      status: code,
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
      body: errorResponse,
    };
  }

  /**
   * Format a GCP-style error response
   */
  formatGcpError(
    code: number,
    message: string,
    status: string,
    details?: GcpErrorDetail[]
  ): RouteResponse {
    const error: GcpError = {
      code,
      message,
      status,
    };

    if (details !== undefined) {
      error.details = details;
    }

    const errorResponse: GcpErrorResponse = {
      error,
    };

    return {
      status: code,
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
      body: errorResponse,
    };
  }

  /**
   * Format an empty response (e.g., for DELETE operations)
   */
  formatEmpty(status: number = 204, headers: Record<string, string> = {}): RouteResponse {
    return {
      status,
      headers: {
        'content-length': '0',
        ...headers,
      },
    };
  }

  /**
   * Format a streaming response (for real-time data)
   */
  formatStream(
    data: AsyncIterable<unknown>,
    status: number = 200,
    headers: Record<string, string> = {}
  ): RouteResponse {
    const responseHeaders = {
      'content-type': 'application/x-ndjson', // Newline-delimited JSON
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...headers,
    };

    return {
      status,
      headers: responseHeaders,
      body: data,
    };
  }

  /**
   * Parse error message to extract HTTP status code and GCP status
   */
  private parseErrorMessage(message: string): { code: number; status: string } {
    // Check for common error patterns
    if (message.includes('not found') || message.includes('Not found')) {
      return { code: 404, status: 'NOT_FOUND' };
    }

    if (message.includes('already exists') || message.includes('Already exists')) {
      return { code: 409, status: 'ALREADY_EXISTS' };
    }

    if (message.includes('invalid') || message.includes('validation')) {
      return { code: 400, status: 'INVALID_ARGUMENT' };
    }

    if (message.includes('unauthorized') || message.includes('Unauthorized')) {
      return { code: 401, status: 'UNAUTHENTICATED' };
    }

    if (message.includes('forbidden') || message.includes('Forbidden')) {
      return { code: 403, status: 'PERMISSION_DENIED' };
    }

    if (message.includes('timeout') || message.includes('deadline')) {
      return { code: 408, status: 'DEADLINE_EXCEEDED' };
    }

    if (message.includes('unavailable') || message.includes('service')) {
      return { code: 503, status: 'UNAVAILABLE' };
    }

    // Default to internal server error
    return { code: 500, status: 'INTERNAL' };
  }

  /**
   * Get error information for HTTP status codes
   */
  private getErrorInfo(code: number): { message: string; status: string } {
    const errorMap: Record<number, { message: string; status: string }> = {
      400: { message: 'Bad Request', status: 'INVALID_ARGUMENT' },
      401: { message: 'Unauthorized', status: 'UNAUTHENTICATED' },
      403: { message: 'Forbidden', status: 'PERMISSION_DENIED' },
      404: { message: 'Not Found', status: 'NOT_FOUND' },
      405: { message: 'Method Not Allowed', status: 'UNIMPLEMENTED' },
      408: { message: 'Request Timeout', status: 'DEADLINE_EXCEEDED' },
      409: { message: 'Conflict', status: 'ALREADY_EXISTS' },
      410: { message: 'Gone', status: 'NOT_FOUND' },
      413: { message: 'Request Entity Too Large', status: 'OUT_OF_RANGE' },
      415: { message: 'Unsupported Media Type', status: 'INVALID_ARGUMENT' },
      422: { message: 'Unprocessable Entity', status: 'INVALID_ARGUMENT' },
      429: { message: 'Too Many Requests', status: 'RESOURCE_EXHAUSTED' },
      500: { message: 'Internal Server Error', status: 'INTERNAL' },
      501: { message: 'Not Implemented', status: 'UNIMPLEMENTED' },
      502: { message: 'Bad Gateway', status: 'UNAVAILABLE' },
      503: { message: 'Service Unavailable', status: 'UNAVAILABLE' },
      504: { message: 'Gateway Timeout', status: 'DEADLINE_EXCEEDED' },
    };

    return errorMap[code] || { message: 'Unknown Error', status: 'UNKNOWN' };
  }
}

/**
 * Utility functions for common response patterns
 */
export class ResponseUtils {
  private formatter: ResponseFormatter;

  constructor(formatter: ResponseFormatter) {
    this.formatter = formatter;
  }

  /**
   * Create a successful response with data
   */
  success<T>(data: T, status: number = 200): RouteResponse {
    return this.formatter.formatJson(data, status);
  }

  /**
   * Create a successful response for resource creation
   */
  created<T>(data: T, location?: string): RouteResponse {
    const headers = location ? { location } : {};

    return this.formatter.formatJson(data, 201, headers);
  }

  /**
   * Create a successful response for resource updates
   */
  updated<T>(data: T): RouteResponse {
    return this.formatter.formatJson(data, 200);
  }

  /**
   * Create a successful response for resource deletion
   */
  deleted(): RouteResponse {
    return this.formatter.formatEmpty(204);
  }

  /**
   * Create a not found error response
   */
  notFound(resource?: string, resourceName?: string): RouteResponse {
    const message =
      resource && resourceName ? `${resource} ${resourceName} not found` : 'Resource not found';

    return this.formatter.formatGcpError(404, message, 'NOT_FOUND', [
      {
        '@type': 'type.googleapis.com/google.rpc.ResourceInfo',
        resourceType: resource || 'resource',
        resourceName: resourceName || 'unknown',
      },
    ]);
  }

  /**
   * Create a bad request error response
   */
  badRequest(
    message: string = 'Bad Request',
    fieldViolations?: Array<{ field: string; description: string }>
  ): RouteResponse {
    const details: GcpErrorDetail[] = [];

    if (fieldViolations && fieldViolations.length > 0) {
      details.push({
        '@type': 'type.googleapis.com/google.rpc.BadRequest',
        fieldViolations,
      });
    }

    return this.formatter.formatGcpError(
      400,
      message,
      'INVALID_ARGUMENT',
      details.length > 0 ? details : undefined
    );
  }

  /**
   * Create an already exists error response
   */
  alreadyExists(resource: string, resourceName: string): RouteResponse {
    return this.formatter.formatGcpError(
      409,
      `${resource} ${resourceName} already exists`,
      'ALREADY_EXISTS',
      [
        {
          '@type': 'type.googleapis.com/google.rpc.ResourceInfo',
          resourceType: resource,
          resourceName,
        },
      ]
    );
  }

  /**
   * Create a failed precondition error response (HTTP 400, standard gRPC mapping)
   */
  failedPrecondition(message: string = 'Failed precondition'): RouteResponse {
    return this.formatter.formatGcpError(400, message, 'FAILED_PRECONDITION');
  }

  /**
   * Create a conflict error response (HTTP 409).
   * Used by GCS for FAILED_PRECONDITION cases like deleting a non-empty bucket,
   * where the REST API returns 409 instead of the standard gRPC mapping of 400.
   */
  conflict(message: string = 'Conflict'): RouteResponse {
    return this.formatter.formatGcpError(409, message, 'FAILED_PRECONDITION');
  }

  /**
   * Create an unauthorized error response
   */
  unauthorized(message: string = 'Authentication required'): RouteResponse {
    return this.formatter.formatGcpError(401, message, 'UNAUTHENTICATED');
  }

  /**
   * Create a forbidden error response
   */
  forbidden(message: string = 'Insufficient permissions'): RouteResponse {
    return this.formatter.formatGcpError(403, message, 'PERMISSION_DENIED');
  }

  /**
   * Create a service unavailable error response
   */
  serviceUnavailable(message: string = 'Service temporarily unavailable'): RouteResponse {
    return this.formatter.formatGcpError(503, message, 'UNAVAILABLE');
  }

  /**
   * Create a rate limit exceeded error response
   */
  rateLimitExceeded(retryAfter?: number): RouteResponse {
    const headers = retryAfter ? { 'retry-after': retryAfter.toString() } : {};

    const response = this.formatter.formatGcpError(
      429,
      'Rate limit exceeded',
      'RESOURCE_EXHAUSTED',
      [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [
            {
              subject: 'requests',
              description: 'Rate limit exceeded',
            },
          ],
        },
      ]
    );

    return {
      ...response,
      headers: {
        ...response.headers,
        ...headers,
      },
    };
  }

  /**
   * Create a paginated response with next page token
   */
  paginated<T>(items: T[], nextPageToken?: string, totalSize?: number): RouteResponse {
    const response: Record<string, unknown> = { items };

    if (nextPageToken) {
      response.nextPageToken = nextPageToken;
    }

    if (totalSize !== undefined) {
      response.totalSize = totalSize;
    }

    return this.formatter.formatJson(response);
  }
}

/**
 * Factory function to create response formatter and utils
 */
export function createResponseSystem(logger: Logger): {
  formatter: ResponseFormatter;
  utils: ResponseUtils;
} {
  const formatter = new StandardResponseFormatter(logger);
  const utils = new ResponseUtils(formatter);

  return { formatter, utils };
}
