/**
 * Unit tests for gRPC-REST Transcoding Bridge
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import * as grpc from '@grpc/grpc-js';
import { Logger } from '@/shared/utils/logger.ts';
import type { TranscodingRequest } from './grpc-rest-bridge.ts';
import {
  createGcpTranscodingRules,
  createPubSubTranscodingRules,
  GrpcRestBridge,
  type ServiceMetadata,
  type TranscodingRule,
} from './grpc-rest-bridge.ts';

describe('GrpcRestBridge', () => {
  let bridge: GrpcRestBridge;
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger('GrpcRestBridgeTest', 'error');
    bridge = new GrpcRestBridge(logger);
  });

  describe('Service Registration', () => {
    test('should register service with transcoding rules', () => {
      const rules = bridge.createTranscodingRules('TestService', [
        {
          grpcMethod: 'GetTopic',
          httpMethod: 'GET',
          httpPath: '/v1/projects/{project}/topics/{topic}',
        },
      ]);

      const metadata: ServiceMetadata = {
        name: 'TestService',
        version: 'v1',
        transcodingRules: rules,
      };

      bridge.registerService(metadata);

      expect(bridge.getServices()).toContain('TestService');
      expect(bridge.getServiceMetadata('TestService')).toEqual(metadata);
    });

    test('should track multiple services', () => {
      const service1: ServiceMetadata = {
        name: 'Service1',
        version: 'v1',
        transcodingRules: new Map(),
      };

      const service2: ServiceMetadata = {
        name: 'Service2',
        version: 'v1',
        transcodingRules: new Map(),
      };

      bridge.registerService(service1);
      bridge.registerService(service2);

      expect(bridge.getServices()).toHaveLength(2);
      expect(bridge.getServices()).toContain('Service1');
      expect(bridge.getServices()).toContain('Service2');
    });
  });

  describe('Transcoding Rule Creation', () => {
    test('should create basic transcoding rules', () => {
      const rules = bridge.createTranscodingRules('TestService', [
        {
          grpcMethod: 'GetTopic',
          httpMethod: 'GET',
          httpPath: '/v1/projects/{project}/topics/{topic}',
        },
        {
          grpcMethod: 'CreateTopic',
          httpMethod: 'POST',
          httpPath: '/v1/projects/{project}/topics',
        },
      ]);

      expect(rules.size).toBe(2);
      expect(rules.has('GetTopic')).toBe(true);
      expect(rules.has('CreateTopic')).toBe(true);

      const getRule = rules.get('GetTopic');

      if (!getRule) throw new Error('GetTopic rule should exist');

      expect(getRule.grpcMethod.method).toBe('GetTopic');
      expect(getRule.restEndpoint.httpMethod).toBe('GET');
      expect(getRule.restEndpoint.path).toBe('/v1/projects/{project}/topics/{topic}');
      expect(getRule.restEndpoint.parameterNames).toEqual(['project', 'topic']);
    });

    test('should extract path parameters correctly', () => {
      const rules = bridge.createTranscodingRules('TestService', [
        {
          grpcMethod: 'ComplexMethod',
          httpMethod: 'GET',
          httpPath: '/v1/projects/{project}/locations/{location}/items/{item}/subitems/{subitem}',
        },
      ]);

      const rule = rules.get('ComplexMethod');

      if (!rule) throw new Error('ComplexMethod rule should exist');

      expect(rule.restEndpoint.parameterNames).toEqual(['project', 'location', 'item', 'subitem']);
    });

    test('should create path patterns for matching', () => {
      const rules = bridge.createTranscodingRules('TestService', [
        {
          grpcMethod: 'GetResource',
          httpMethod: 'GET',
          httpPath: '/v1/projects/{project}/resources/{resource}',
        },
      ]);

      const rule = rules.get('GetResource');

      if (!rule) throw new Error('GetResource rule should exist');

      expect(
        rule.restEndpoint.pathPattern.test('/v1/projects/my-project/resources/my-resource')
      ).toBe(true);
      expect(rule.restEndpoint.pathPattern.test('/v1/projects/my-project/resources')).toBe(false);
      expect(
        rule.restEndpoint.pathPattern.test('/v2/projects/my-project/resources/my-resource')
      ).toBe(false);
    });
  });

  describe('Request Handling', () => {
    beforeEach(() => {
      const rules = bridge.createTranscodingRules('TestService', [
        {
          grpcMethod: 'GetTopic',
          httpMethod: 'GET',
          httpPath: '/v1/projects/{project}/topics/{topic}',
        },
        {
          grpcMethod: 'CreateTopic',
          httpMethod: 'POST',
          httpPath: '/v1/projects/{project}/topics',
        },
      ]);

      const metadata: ServiceMetadata = {
        name: 'TestService',
        version: 'v1',
        transcodingRules: rules,
      };

      bridge.registerService(metadata);
    });

    test('should detect handleable requests', () => {
      const getRequest: TranscodingRequest = {
        method: 'GET',
        url: 'http://localhost:8765/v1/projects/test-project/topics/my-topic',
        headers: {},
      };

      const postRequest: TranscodingRequest = {
        method: 'POST',
        url: 'http://localhost:8765/v1/projects/test-project/topics',
        headers: {},
      };

      const unhandledRequest: TranscodingRequest = {
        method: 'DELETE',
        url: 'http://localhost:8765/v1/projects/test-project/topics/my-topic',
        headers: {},
      };

      expect(bridge.canHandle(getRequest)).toBe(true);
      expect(bridge.canHandle(postRequest)).toBe(true);
      expect(bridge.canHandle(unhandledRequest)).toBe(false);
    });

    test('should transform REST to gRPC request', async () => {
      const httpRequest: TranscodingRequest = {
        method: 'GET',
        url: 'http://localhost:8765/v1/projects/test-project/topics/my-topic?pageSize=10',
        headers: {},
      };

      const result = (await bridge.restToGrpc(httpRequest)) as {
        rule: unknown;
        request: { project: string; topic: string; pageSize: string };
      };

      expect(result.rule).toBeDefined();
      expect(result.request.project).toBe('test-project');
      expect(result.request.topic).toBe('my-topic');
      expect(result.request.pageSize).toBe('10');
    });

    test('should transform POST request with body', async () => {
      const httpRequest: TranscodingRequest = {
        method: 'POST',
        url: 'http://localhost:8765/v1/projects/test-project/topics',
        headers: { 'content-type': 'application/json' },
        body: {
          name: 'projects/test-project/topics/new-topic',
          labels: { env: 'test' },
        },
      };

      const result = (await bridge.restToGrpc(httpRequest)) as {
        request: { project: string; name: string; labels: Record<string, string> };
      };

      expect(result.request.project).toBe('test-project');
      expect(result.request.name).toBe('projects/test-project/topics/new-topic');
      expect(result.request.labels).toEqual({ env: 'test' });
    });

    test('should handle JSON string body', async () => {
      const httpRequest: TranscodingRequest = {
        method: 'POST',
        url: 'http://localhost:8765/v1/projects/test-project/topics',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'projects/test-project/topics/json-topic',
          labels: { format: 'json' },
        }),
      };

      const result = (await bridge.restToGrpc(httpRequest)) as {
        request: { name: string; labels: Record<string, string> };
      };

      expect(result.request.name).toBe('projects/test-project/topics/json-topic');
      expect(result.request.labels).toEqual({ format: 'json' });
    });

    test('should throw error for unhandled requests', async () => {
      const httpRequest: TranscodingRequest = {
        method: 'DELETE',
        url: 'http://localhost:8765/v1/projects/test-project/topics/my-topic',
        headers: {},
      };

      await expect(bridge.restToGrpc(httpRequest)).rejects.toThrow('No transcoding rule found');
    });
  });

  describe('Response Handling', () => {
    let testRule: TranscodingRule;

    beforeEach(() => {
      const rules = bridge.createTranscodingRules('TestService', [
        {
          grpcMethod: 'GetTopic',
          httpMethod: 'GET',
          httpPath: '/v1/projects/{project}/topics/{topic}',
        },
      ]);

      const retrievedRule = rules.get('GetTopic');

      if (!retrievedRule) throw new Error('GetTopic rule should exist');
      testRule = retrievedRule;
    });

    test('should transform gRPC response to HTTP', async () => {
      const grpcResponse = {
        name: 'projects/test-project/topics/my-topic',
        labels: { env: 'test' },
      };

      const httpResponse = await bridge.grpcToRest(grpcResponse, testRule);

      expect(httpResponse.status).toBe(200);
      expect(httpResponse.headers?.['content-type']).toBe('application/json');
      expect(httpResponse.body).toEqual(grpcResponse);
    });

    test('should handle empty response', async () => {
      const httpResponse = await bridge.grpcToRest(null, testRule);

      expect(httpResponse.status).toBe(204);
      expect(httpResponse.body).toBeUndefined();
    });

    test('should handle list responses', async () => {
      const grpcResponse = {
        items: [{ name: 'topic1' }, { name: 'topic2' }],
        nextPageToken: 'token123',
      };

      const httpResponse = await bridge.grpcToRest(grpcResponse, testRule);

      expect(httpResponse.status).toBe(200);
      expect(httpResponse.body).toEqual(grpcResponse);
    });
  });

  describe('Error Handling', () => {
    test('should convert gRPC errors to HTTP errors', () => {
      const grpcError = Object.assign(new Error('Topic not found'), {
        code: grpc.status.NOT_FOUND,
        name: 'ServiceError',
      }) as grpc.ServiceError;

      const httpResponse = bridge.grpcErrorToRest(grpcError);

      expect(httpResponse.status).toBe(404);
      expect(httpResponse.headers?.['content-type']).toBe('application/json');
      expect(httpResponse.body).toEqual({
        error: {
          code: 404,
          message: 'Topic not found',
          status: 'NOT_FOUND',
        },
      });
    });

    test('should handle various gRPC status codes', () => {
      const testCases = [
        {
          grpcStatus: grpc.status.INVALID_ARGUMENT,
          httpStatus: 400,
          googleStatus: 'INVALID_ARGUMENT',
        },
        { grpcStatus: grpc.status.ALREADY_EXISTS, httpStatus: 409, googleStatus: 'ALREADY_EXISTS' },
        {
          grpcStatus: grpc.status.PERMISSION_DENIED,
          httpStatus: 403,
          googleStatus: 'PERMISSION_DENIED',
        },
        {
          grpcStatus: grpc.status.RESOURCE_EXHAUSTED,
          httpStatus: 429,
          googleStatus: 'RESOURCE_EXHAUSTED',
        },
        { grpcStatus: grpc.status.INTERNAL, httpStatus: 500, googleStatus: 'INTERNAL' },
        { grpcStatus: grpc.status.UNAVAILABLE, httpStatus: 503, googleStatus: 'UNAVAILABLE' },
      ];

      for (const testCase of testCases) {
        const grpcError = Object.assign(new Error('Test error'), {
          code: testCase.grpcStatus,
          name: 'ServiceError',
        }) as grpc.ServiceError;

        const httpResponse = bridge.grpcErrorToRest(grpcError);

        expect(httpResponse.status).toBe(testCase.httpStatus);
        expect((httpResponse.body as { error: { status: string } }).error.status).toBe(
          testCase.googleStatus
        );
      }
    });

    test('should handle unknown gRPC status codes', () => {
      const grpcError = Object.assign(new Error('Unknown error'), {
        code: 999 as unknown as grpc.status, // Unknown status code
        name: 'ServiceError',
      }) as grpc.ServiceError;

      const httpResponse = bridge.grpcErrorToRest(grpcError);

      expect(httpResponse.status).toBe(500);
      expect((httpResponse.body as { error: { status: string } }).error.status).toBe('UNKNOWN');
    });
  });

  describe('Factory Functions', () => {
    test('should create GCP transcoding rules', () => {
      const rules = createGcpTranscodingRules('Topic', '/v1/projects/{project}/topics');

      expect(rules).toHaveLength(5); // Create, Get, List, Update, Delete

      const createRule = rules.find(r => r.grpcMethod === 'CreateTopic');

      expect(createRule).toBeDefined();
      expect(createRule?.httpMethod).toBe('POST');
      expect(createRule?.httpPath).toBe('/v1/projects/{project}/topics');

      const getRule = rules.find(r => r.grpcMethod === 'GetTopic');

      expect(getRule).toBeDefined();
      expect(getRule?.httpMethod).toBe('GET');
      expect(getRule?.httpPath).toBe('/v1/projects/{project}/topics/{name}');

      const listRule = rules.find(r => r.grpcMethod === 'ListTopics');

      expect(listRule).toBeDefined();
      expect(listRule?.httpMethod).toBe('GET');
      expect(listRule?.httpPath).toBe('/v1/projects/{project}/topics');

      const deleteRule = rules.find(r => r.grpcMethod === 'DeleteTopic');

      expect(deleteRule).toBeDefined();
      expect(deleteRule?.httpMethod).toBe('DELETE');
      expect(deleteRule?.httpPath).toBe('/v1/projects/{project}/topics/{name}');
    });

    test('should create Pub/Sub transcoding rules', () => {
      const rules = createPubSubTranscodingRules();

      expect(rules.length).toBeGreaterThan(10); // Base rules + Pub/Sub specific

      const publishRule = rules.find(r => r.grpcMethod === 'Publish');

      expect(publishRule).toBeDefined();
      expect(publishRule?.httpMethod).toBe('POST');
      expect(publishRule?.httpPath).toBe('/v1/projects/{project}/topics/{topic}:publish');

      const pullRule = rules.find(r => r.grpcMethod === 'Pull');

      expect(pullRule).toBeDefined();
      expect(pullRule?.httpMethod).toBe('POST');
      expect(pullRule?.httpPath).toBe('/v1/projects/{project}/subscriptions/{subscription}:pull');

      const ackRule = rules.find(r => r.grpcMethod === 'Acknowledge');

      expect(ackRule).toBeDefined();
      expect(ackRule?.httpMethod).toBe('POST');
      expect(ackRule?.httpPath).toBe(
        '/v1/projects/{project}/subscriptions/{subscription}:acknowledge'
      );
    });

    test('should create custom response transformers', () => {
      const rules = createGcpTranscodingRules('Topic', '/v1/projects/{project}/topics');
      const listRule = rules.find(r => r.grpcMethod === 'ListTopics');

      expect(listRule?.responseTransform).toBeDefined();

      if (listRule?.responseTransform) {
        const mockGrpcResponse = {
          items: [{ name: 'topic1' }, { name: 'topic2' }],
          nextPageToken: 'token123',
        };

        const httpResponse = listRule.responseTransform(mockGrpcResponse);

        expect(httpResponse.status).toBe(200);
        expect(httpResponse.headers?.['content-type']).toBe('application/json');
      }
    });
  });

  describe('Custom Transformers', () => {
    test('should use custom request transformer', async () => {
      const rules = bridge.createTranscodingRules('TestService', [
        {
          grpcMethod: 'CustomMethod',
          httpMethod: 'POST',
          httpPath: '/v1/custom/{id}',
          requestTransform: (req: TranscodingRequest) => ({
            customId: req.params?.id,
            timestamp: Date.now(),
            body: req.body,
          }),
        },
      ]);

      const metadata: ServiceMetadata = {
        name: 'TestService',
        version: 'v1',
        transcodingRules: rules,
      };

      bridge.registerService(metadata);

      const httpRequest: TranscodingRequest = {
        method: 'POST',
        url: 'http://localhost:8765/v1/custom/test-id',
        headers: {},
        body: { data: 'test' },
        params: { id: 'test-id' },
      };

      const result = (await bridge.restToGrpc(httpRequest)) as {
        request: { customId: string; timestamp: number; body: unknown };
      };

      expect(result.request.customId).toBe('test-id');
      expect(result.request.timestamp).toBeTypeOf('number');
      expect(result.request.body).toEqual({ data: 'test' });
    });

    test('should use custom response transformer', async () => {
      const rules = bridge.createTranscodingRules('TestService', [
        {
          grpcMethod: 'CustomResponse',
          httpMethod: 'GET',
          httpPath: '/v1/custom',
          responseTransform: (grpcResponse: unknown) => ({
            status: 201,
            headers: { 'x-custom': 'header' },
            body: { wrapped: grpcResponse },
          }),
        },
      ]);

      const rule = rules.get('CustomResponse');

      if (!rule) throw new Error('CustomResponse rule should exist');
      const grpcResponse = { message: 'success' };

      const httpResponse = await bridge.grpcToRest(grpcResponse, rule);

      expect(httpResponse.status).toBe(201);
      expect(httpResponse.headers?.['x-custom']).toBe('header');
      expect(httpResponse.body).toEqual({ wrapped: { message: 'success' } });
    });
  });
});
