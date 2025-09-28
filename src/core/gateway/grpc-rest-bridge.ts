/**
 * gRPC-REST Transcoding Bridge
 * Provides bidirectional conversion between gRPC and REST protocols
 * Allows a single service implementation to serve both gRPC and HTTP REST clients
 */

import * as grpc from '@grpc/grpc-js';
import type { HttpRequest, HttpResponse } from './http-server.ts';
import type { Logger } from '@/shared/utils/logger.ts';

export interface GrpcMethodInfo {
  service: string;
  method: string;
  isStreaming: boolean;
  isClientStreaming: boolean;
  isServerStreaming: boolean;
}

export interface RestEndpointInfo {
  httpMethod: string;
  path: string;
  pathPattern: RegExp;
  parameterNames: string[];
}

export interface TranscodingRule {
  grpcMethod: GrpcMethodInfo;
  restEndpoint: RestEndpointInfo;
  requestTransformer: (httpRequest: HttpRequest) => unknown;
  responseTransformer: (grpcResponse: unknown) => HttpResponse;
}

export interface ServiceMetadata {
  name: string;
  version: string;
  transcodingRules: Map<string, TranscodingRule>;
}

export class GrpcRestBridge {
  private logger: Logger;
  private services: Map<string, ServiceMetadata> = new Map();
  private routeToService: Map<string, TranscodingRule> = new Map();

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Register a service with transcoding rules
   */
  registerService(metadata: ServiceMetadata): void {
    this.services.set(metadata.name, metadata);

    // Index routes for fast lookup - use method name as key since paths have parameters
    for (const [methodName, rule] of metadata.transcodingRules) {
      const routeKey = `${rule.restEndpoint.httpMethod}:${methodName}`;

      this.routeToService.set(routeKey, rule);

      this.logger.debug(
        `Registered transcoding rule: ${rule.restEndpoint.httpMethod} ${rule.restEndpoint.path} -> ${rule.grpcMethod.service}.${rule.grpcMethod.method}`
      );
    }

    this.logger.info(`Registered gRPC-REST bridge for service: ${metadata.name}`);
  }

  /**
   * Convert HTTP request to gRPC call
   */
  async restToGrpc(httpRequest: HttpRequest): Promise<unknown> {
    const rule = this.findTranscodingRule(httpRequest);

    if (!rule) {
      throw new Error(
        `No transcoding rule found for ${httpRequest.method} ${new URL(httpRequest.url).pathname}`
      );
    }

    try {
      // Transform HTTP request to gRPC request format
      const grpcRequest = rule.requestTransformer(httpRequest);

      this.logger.debug(
        `Transcoding REST -> gRPC: ${httpRequest.method} ${new URL(httpRequest.url).pathname} -> ${rule.grpcMethod.service}.${rule.grpcMethod.method}`
      );

      return {
        rule,
        request: grpcRequest,
      };
    } catch (error) {
      this.logger.error('Error transcoding REST to gRPC:', error);
      throw new Error(
        `Request transcoding failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Convert gRPC response to HTTP response
   */
  async grpcToRest(grpcResponse: unknown, rule: TranscodingRule): Promise<HttpResponse> {
    try {
      const httpResponse = rule.responseTransformer(grpcResponse);

      this.logger.debug(
        `Transcoding gRPC -> REST: ${rule.grpcMethod.service}.${rule.grpcMethod.method} -> HTTP ${httpResponse.status}`
      );

      return httpResponse;
    } catch (error) {
      this.logger.error('Error transcoding gRPC to REST:', error);
      throw new Error(
        `Response transcoding failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Handle gRPC error and convert to HTTP error response
   */
  grpcErrorToRest(error: grpc.ServiceError): HttpResponse {
    const httpStatus = this.grpcStatusToHttpStatus(error.code);

    const errorResponse = {
      error: {
        code: httpStatus,
        message: error.message || 'Internal server error',
        status: this.grpcStatusToGoogleStatus(error.code),
      },
    };

    return {
      status: httpStatus,
      headers: {
        'content-type': 'application/json',
      },
      body: errorResponse,
    };
  }

  /**
   * Create transcoding rules for a service
   */
  createTranscodingRules(
    serviceName: string,
    rules: Array<{
      grpcMethod: string;
      httpMethod: string;
      httpPath: string;
      requestTransform?: (req: HttpRequest) => unknown;
      responseTransform?: (res: unknown) => HttpResponse;
    }>
  ): Map<string, TranscodingRule> {
    const transcodingRules = new Map<string, TranscodingRule>();

    for (const ruleConfig of rules) {
      const pathParams = this.extractPathParameters(ruleConfig.httpPath);

      const rule: TranscodingRule = {
        grpcMethod: {
          service: serviceName,
          method: ruleConfig.grpcMethod,
          isStreaming: false, // TODO: Detect from proto definition
          isClientStreaming: false,
          isServerStreaming: false,
        },
        restEndpoint: {
          httpMethod: ruleConfig.httpMethod.toUpperCase(),
          path: ruleConfig.httpPath,
          pathPattern: this.createPathPattern(ruleConfig.httpPath),
          parameterNames: pathParams,
        },
        requestTransformer:
          ruleConfig.requestTransform || this.createDefaultRequestTransformer(pathParams),
        responseTransformer:
          ruleConfig.responseTransform || this.createDefaultResponseTransformer(),
      };

      transcodingRules.set(ruleConfig.grpcMethod, rule);
    }

    return transcodingRules;
  }

  /**
   * Get registered services
   */
  getServices(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * Get service metadata
   */
  getServiceMetadata(serviceName: string): ServiceMetadata | undefined {
    return this.services.get(serviceName);
  }

  /**
   * Check if a route is handled by the bridge
   */
  canHandle(httpRequest: HttpRequest): boolean {
    return this.findTranscodingRule(httpRequest) !== null;
  }

  /**
   * Find transcoding rule for HTTP request
   */
  private findTranscodingRule(httpRequest: HttpRequest): TranscodingRule | null {
    const url = new URL(httpRequest.url);
    const method = httpRequest.method.toUpperCase();
    const path = url.pathname;

    // Pattern matching through all registered rules
    for (const rule of this.routeToService.values()) {
      if (rule.restEndpoint.httpMethod === method && rule.restEndpoint.pathPattern.test(path)) {
        return rule;
      }
    }

    return null;
  }

  /**
   * Extract path parameters from URL pattern
   */
  private extractPathParameters(pathPattern: string): string[] {
    const params: string[] = [];
    const matches = pathPattern.matchAll(/\{([^}]+)\}/g);

    for (const match of matches) {
      if (match[1] !== undefined) {
        params.push(match[1]);
      }
    }

    return params;
  }

  /**
   * Create regex pattern for path matching
   */
  private createPathPattern(pathTemplate: string): RegExp {
    // Convert path template like "/v1/projects/{project}/topics/{topic}"
    // to regex pattern like "^/v1/projects/([^/]+)/topics/([^/]+)$"

    // Split path into segments and process each one
    const segments = pathTemplate.split('/');
    const processedSegments = segments.map(segment => {
      if (segment.match(/^\{[^}]+\}$/)) {
        // This is a parameter segment, replace with capture group
        return '([^/]+)';
      } else {
        // This is a literal segment, escape special characters
        return segment.replace(/[.+?^$|[\]\\*]/g, '\\$&');
      }
    });

    const pattern = processedSegments.join('/');

    return new RegExp(`^${pattern}$`);
  }

  /**
   * Create default request transformer
   */
  private createDefaultRequestTransformer(pathParams: string[]) {
    return (httpRequest: HttpRequest): unknown => {
      const url = new URL(httpRequest.url);
      const path = url.pathname;

      // Extract path parameters
      const rule = this.findTranscodingRule(httpRequest);

      if (!rule) {
        throw new Error('Cannot transform request without transcoding rule');
      }

      const match = path.match(rule.restEndpoint.pathPattern);
      const pathValues: Record<string, string> = {};

      if (match) {
        pathParams.forEach((paramName, index) => {
          const value = match[index + 1];

          if (value !== undefined) {
            pathValues[paramName] = value;
          }
        });
      }

      // Build gRPC request
      const grpcRequest: Record<string, unknown> = {
        ...pathValues,
      };

      // Add query parameters
      for (const [key, value] of url.searchParams.entries()) {
        grpcRequest[key] = value;
      }

      // Add request body if present
      if (
        httpRequest.body &&
        (httpRequest.method === 'POST' ||
          httpRequest.method === 'PUT' ||
          httpRequest.method === 'PATCH')
      ) {
        if (typeof httpRequest.body === 'object') {
          Object.assign(grpcRequest, httpRequest.body);
        } else {
          // If body is a string, try to parse as JSON
          try {
            const bodyObj = JSON.parse(httpRequest.body as string);

            Object.assign(grpcRequest, bodyObj);
          } catch {
            grpcRequest.body = httpRequest.body;
          }
        }
      }

      return grpcRequest;
    };
  }

  /**
   * Create default response transformer
   */
  private createDefaultResponseTransformer() {
    return (grpcResponse: unknown): HttpResponse => {
      let status = 200;
      let body = grpcResponse;

      // Handle different response types
      if (grpcResponse === null || grpcResponse === undefined) {
        status = 204; // No Content
        body = undefined;
      } else if (
        typeof grpcResponse === 'object' &&
        grpcResponse !== null &&
        'items' in grpcResponse
      ) {
        // List response
        status = 200;
        body = grpcResponse;
      } else if (typeof grpcResponse === 'object') {
        status = 200;
        body = grpcResponse;
      }

      return {
        status,
        headers: {
          'content-type': 'application/json',
        },
        body,
      };
    };
  }

  /**
   * Convert gRPC status code to HTTP status code
   */
  private grpcStatusToHttpStatus(grpcStatus: number): number {
    const statusMap: Record<number, number> = {
      [grpc.status.OK]: 200,
      [grpc.status.CANCELLED]: 499,
      [grpc.status.UNKNOWN]: 500,
      [grpc.status.INVALID_ARGUMENT]: 400,
      [grpc.status.DEADLINE_EXCEEDED]: 504,
      [grpc.status.NOT_FOUND]: 404,
      [grpc.status.ALREADY_EXISTS]: 409,
      [grpc.status.PERMISSION_DENIED]: 403,
      [grpc.status.RESOURCE_EXHAUSTED]: 429,
      [grpc.status.FAILED_PRECONDITION]: 400,
      [grpc.status.ABORTED]: 409,
      [grpc.status.OUT_OF_RANGE]: 400,
      [grpc.status.UNIMPLEMENTED]: 501,
      [grpc.status.INTERNAL]: 500,
      [grpc.status.UNAVAILABLE]: 503,
      [grpc.status.DATA_LOSS]: 500,
      [grpc.status.UNAUTHENTICATED]: 401,
    };

    return statusMap[grpcStatus] || 500;
  }

  /**
   * Convert gRPC status code to Google API status string
   */
  private grpcStatusToGoogleStatus(grpcStatus: number): string {
    const statusMap: Record<number, string> = {
      [grpc.status.OK]: 'OK',
      [grpc.status.CANCELLED]: 'CANCELLED',
      [grpc.status.UNKNOWN]: 'UNKNOWN',
      [grpc.status.INVALID_ARGUMENT]: 'INVALID_ARGUMENT',
      [grpc.status.DEADLINE_EXCEEDED]: 'DEADLINE_EXCEEDED',
      [grpc.status.NOT_FOUND]: 'NOT_FOUND',
      [grpc.status.ALREADY_EXISTS]: 'ALREADY_EXISTS',
      [grpc.status.PERMISSION_DENIED]: 'PERMISSION_DENIED',
      [grpc.status.RESOURCE_EXHAUSTED]: 'RESOURCE_EXHAUSTED',
      [grpc.status.FAILED_PRECONDITION]: 'FAILED_PRECONDITION',
      [grpc.status.ABORTED]: 'ABORTED',
      [grpc.status.OUT_OF_RANGE]: 'OUT_OF_RANGE',
      [grpc.status.UNIMPLEMENTED]: 'UNIMPLEMENTED',
      [grpc.status.INTERNAL]: 'INTERNAL',
      [grpc.status.UNAVAILABLE]: 'UNAVAILABLE',
      [grpc.status.DATA_LOSS]: 'DATA_LOSS',
      [grpc.status.UNAUTHENTICATED]: 'UNAUTHENTICATED',
    };

    return statusMap[grpcStatus] || 'UNKNOWN';
  }
}

/**
 * Factory function to create common transcoding rules for GCP-like APIs
 */
export function createGcpTranscodingRules(
  serviceName: string,
  resourceName: string,
  resourcePath: string
): Array<{
  grpcMethod: string;
  httpMethod: string;
  httpPath: string;
  requestTransform?: (req: HttpRequest) => unknown;
  responseTransform?: (res: unknown) => HttpResponse;
}> {
  return [
    // Create resource
    {
      grpcMethod: `Create${resourceName}`,
      httpMethod: 'POST',
      httpPath: resourcePath,
    },

    // Get resource
    {
      grpcMethod: `Get${resourceName}`,
      httpMethod: 'GET',
      httpPath: `${resourcePath}/{name}`,
    },

    // List resources
    {
      grpcMethod: `List${resourceName}s`,
      httpMethod: 'GET',
      httpPath: resourcePath,
      responseTransform: (res: unknown): HttpResponse => {
        const isValidResponse = (
          value: unknown
        ): value is { items?: unknown; nextPageToken?: unknown } => {
          return value !== null && typeof value === 'object';
        };

        const response = isValidResponse(res) ? res : {};

        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: {
            [`${resourceName.toLowerCase()}s`]: 'items' in response ? response.items : [],
            nextPageToken: 'nextPageToken' in response ? response.nextPageToken : undefined,
          },
        };
      },
    },

    // Update resource
    {
      grpcMethod: `Update${resourceName}`,
      httpMethod: 'PATCH',
      httpPath: `${resourcePath}/{name}`,
    },

    // Delete resource
    {
      grpcMethod: `Delete${resourceName}`,
      httpMethod: 'DELETE',
      httpPath: `${resourcePath}/{name}`,
      responseTransform: (): HttpResponse => ({
        status: 204,
        headers: {},
      }),
    },
  ];
}

/**
 * Create Pub/Sub specific transcoding rules
 */
export function createPubSubTranscodingRules(): Array<{
  grpcMethod: string;
  httpMethod: string;
  httpPath: string;
  requestTransform?: (req: HttpRequest) => unknown;
  responseTransform?: (res: unknown) => HttpResponse;
}> {
  const baseRules = [
    ...createGcpTranscodingRules('Publisher', 'Topic', '/v1/projects/{project}/topics'),
    ...createGcpTranscodingRules(
      'Subscriber',
      'Subscription',
      '/v1/projects/{project}/subscriptions'
    ),
  ];

  // Add Pub/Sub specific methods
  const pubsubSpecificRules = [
    // Publish messages
    {
      grpcMethod: 'Publish',
      httpMethod: 'POST',
      httpPath: '/v1/projects/{project}/topics/{topic}:publish',
      requestTransform: (req: HttpRequest) => {
        const isValidBody = (value: unknown): value is { messages?: unknown } => {
          return value !== null && typeof value === 'object';
        };

        const body = isValidBody(req.body) ? req.body : {};
        const messages = 'messages' in body ? body.messages : [];

        return {
          topic: req.params?.topic || '',
          messages,
        };
      },
    },

    // Pull messages
    {
      grpcMethod: 'Pull',
      httpMethod: 'POST',
      httpPath: '/v1/projects/{project}/subscriptions/{subscription}:pull',
      requestTransform: (req: HttpRequest) => {
        const isValidBody = (
          value: unknown
        ): value is { maxMessages?: unknown; returnImmediately?: unknown } => {
          return value !== null && typeof value === 'object';
        };

        const body = isValidBody(req.body) ? req.body : {};
        const maxMessages = 'maxMessages' in body ? body.maxMessages : 1;
        const returnImmediately = 'returnImmediately' in body ? body.returnImmediately : false;

        return {
          subscription: req.params?.subscription || '',
          maxMessages,
          returnImmediately,
        };
      },
    },

    // Acknowledge messages
    {
      grpcMethod: 'Acknowledge',
      httpMethod: 'POST',
      httpPath: '/v1/projects/{project}/subscriptions/{subscription}:acknowledge',
      requestTransform: (req: HttpRequest) => {
        const isValidBody = (value: unknown): value is { ackIds?: unknown } => {
          return value !== null && typeof value === 'object';
        };

        const body = isValidBody(req.body) ? req.body : {};
        const ackIds = 'ackIds' in body ? body.ackIds : [];

        return {
          subscription: req.params?.subscription || '',
          ackIds,
        };
      },
      responseTransform: (): HttpResponse => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {},
      }),
    },
  ];

  return [...baseRules, ...pubsubSpecificRules];
}
