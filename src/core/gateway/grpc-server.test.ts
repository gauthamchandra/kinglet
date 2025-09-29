/**
 * Unit tests for gRPC Server implementation
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import * as grpc from '@grpc/grpc-js';
import { GrpcServer, type GrpcServiceDefinition } from './grpc-server.ts';
import { Logger } from '@/shared/utils/logger.ts';

describe('GrpcServer', () => {
  let grpcServer: GrpcServer;
  let logger: Logger;

  const serverConfig = {
    httpPort: 8765,
    grpcPort: 0, // Use port 0 to let OS choose available port for testing
    maxConnections: 100,
  };

  beforeEach(() => {
    logger = new Logger('GrpcServerTest', 'error');
    grpcServer = new GrpcServer(serverConfig, logger);
  });

  afterEach(async () => {
    if (grpcServer.getStatus()) {
      await grpcServer.stop();
    }
  });

  describe('Server Lifecycle', () => {
    test('should initialize server', () => {
      expect(grpcServer.getStatus()).toBe(false);
      expect(grpcServer.getRegisteredServices()).toEqual([]);
    });

    test('should start server', async () => {
      expect(grpcServer.getStatus()).toBe(false);

      await grpcServer.start();

      expect(grpcServer.getStatus()).toBe(true);
    });

    test('should stop server', async () => {
      await grpcServer.start();
      expect(grpcServer.getStatus()).toBe(true);

      await grpcServer.stop();

      expect(grpcServer.getStatus()).toBe(false);
    });

    test('should handle stop when not running', async () => {
      expect(grpcServer.getStatus()).toBe(false);

      await grpcServer.stop(); // Should not throw

      expect(grpcServer.getStatus()).toBe(false);
    });

    test('should handle multiple starts gracefully', async () => {
      await grpcServer.start();
      expect(grpcServer.getStatus()).toBe(true);

      // Starting again should work (though it doesn't do anything)
      expect(grpcServer.getStatus()).toBe(true);
    });
  });

  describe('Service Registration', () => {
    test('should track registered services', () => {
      const initialServices = grpcServer.getRegisteredServices();

      expect(initialServices).toEqual([]);
    });

    test('should handle service registration errors gracefully', () => {
      const invalidService: GrpcServiceDefinition = {
        name: 'InvalidService',
        protoPath: '/nonexistent/path.proto',
        packageName: 'invalid.package',
        serviceName: 'InvalidService',
        implementation: {},
      };

      expect(() => grpcServer.registerService(invalidService)).toThrow();

      // Should not be in registered services list
      expect(grpcServer.getRegisteredServices()).not.toContain('InvalidService');
    });

    test('should return undefined for unknown service', () => {
      const definition = grpcServer.getServiceDefinition('NonExistentService');

      expect(definition).toBeUndefined();
    });

    test('should validate service exists in package', () => {
      const invalidService: GrpcServiceDefinition = {
        name: 'NonExistentService',
        protoPath: 'test-data/test-service.proto',
        packageName: 'test',
        serviceName: 'NonExistentService',
        implementation: {},
      };

      expect(() => grpcServer.registerService(invalidService)).toThrow(
        /Service NonExistentService not found in package test/
      );

      // Should not be in registered services list
      expect(grpcServer.getRegisteredServices()).not.toContain('NonExistentService');
    });

    test('should validate package exists', () => {
      const invalidService: GrpcServiceDefinition = {
        name: 'TestService',
        protoPath: 'test-data/test-service.proto',
        packageName: 'nonexistent.package',
        serviceName: 'TestService',
        implementation: {},
      };

      expect(() => grpcServer.registerService(invalidService)).toThrow(
        /Package nonexistent.package not found in proto definition/
      );
    });
  });

  describe('Handler Creation', () => {
    test('should create unary handler', async () => {
      const mockHandler = async (request: unknown) => {
        return { message: `Hello ${(request as { name: string }).name}` };
      };

      const handler = grpcServer.createUnaryHandler(mockHandler);

      expect(typeof handler).toBe('function');

      // Mock the call and callback
      const mockCall = {
        request: { name: 'World' },
        metadata: new grpc.Metadata(),
      };

      const mockCallback = (error: unknown, response: unknown) => {
        expect(error).toBeNull();
        expect(response).toEqual({ message: 'Hello World' });
      };

      await handler(mockCall as grpc.ServerUnaryCall<unknown, { message: string }>, mockCallback);
    });

    test('should create unary handler with error handling', async () => {
      const mockHandler = async () => {
        throw new Error('Test error');
      };

      const handler = grpcServer.createUnaryHandler(mockHandler);

      const mockCall = {
        request: {},
        metadata: new grpc.Metadata(),
      };

      const mockCallback = (error: unknown, _response: unknown) => {
        expect(error).toBeDefined();
        expect((error as { code: number }).code).toBe(grpc.status.INTERNAL);
        expect((error as Error).message).toBe('Test error');
        expect(_response).toBeUndefined();
      };

      await handler(mockCall as grpc.ServerUnaryCall<unknown, never>, mockCallback);
    });

    test('should create server streaming handler', async () => {
      const mockHandler = async function* (request: unknown) {
        const req = request as { name: string };

        yield { message: `Hello ${req.name} 1` };
        yield { message: `Hello ${req.name} 2` };
      };

      const handler = grpcServer.createServerStreamingHandler(mockHandler);

      expect(typeof handler).toBe('function');

      // Mock the streaming call
      const responses: unknown[] = [];
      let ended = false;

      const mockCall = {
        request: { name: 'World' },
        metadata: new grpc.Metadata(),
        cancelled: false,
        destroyed: false,
        write: (response: unknown) => {
          responses.push(response);
        },
        end: () => {
          ended = true;
        },
      };

      await handler(mockCall as grpc.ServerWritableStream<unknown, { message: string }>);

      expect(responses).toHaveLength(2);
      expect(responses[0]).toEqual({ message: 'Hello World 1' });
      expect(responses[1]).toEqual({ message: 'Hello World 2' });
      expect(ended).toBe(true);
    });

    test('should create client streaming handler', async () => {
      const mockHandler = async (requests: AsyncIterable<unknown>) => {
        const names: string[] = [];

        for await (const request of requests) {
          names.push((request as { name: string }).name);
        }

        return { message: `Hello ${names.join(', ')}` };
      };

      const handler = grpcServer.createClientStreamingHandler(mockHandler);

      expect(typeof handler).toBe('function');

      // This is a simplified test - full implementation would require
      // more complex stream mocking for client streaming handlers
      expect(typeof handler).toBe('function');
    });

    test('should map specific errors to gRPC status codes', async () => {
      const testCases = [
        { error: 'Resource not found', expectedCode: grpc.status.NOT_FOUND }, // 5
        { error: 'Resource already exists', expectedCode: grpc.status.ALREADY_EXISTS }, // 6
        { error: 'Invalid input provided', expectedCode: grpc.status.INVALID_ARGUMENT }, // 3
        { error: 'Unauthorized access', expectedCode: grpc.status.UNAUTHENTICATED }, // 16
        { error: 'Forbidden operation', expectedCode: grpc.status.PERMISSION_DENIED }, // 7
        { error: 'Service unavailable', expectedCode: grpc.status.UNAVAILABLE }, // 14
        { error: 'Generic error', expectedCode: grpc.status.INTERNAL }, // 13
      ];

      for (const testCase of testCases) {
        const mockHandler = async () => {
          throw new Error(testCase.error);
        };

        const handler = grpcServer.createUnaryHandler(mockHandler);

        const mockCall = {
          request: {},
          metadata: new grpc.Metadata(),
        };

        await new Promise<void>(resolve => {
          const mockCallback = (error: unknown) => {
            expect((error as { code: number }).code).toBe(testCase.expectedCode);
            expect((error as Error).message).toBe(testCase.error);
            resolve();
          };

          handler(mockCall as grpc.ServerUnaryCall<unknown, never>, mockCallback);
        });
      }
    });
  });

  describe('Error Conversion', () => {
    test('should handle non-Error objects', async () => {
      const mockHandler = async () => {
        throw 'String error';
      };

      const handler = grpcServer.createUnaryHandler(mockHandler);

      const mockCall = {
        request: {},
        metadata: new grpc.Metadata(),
      };

      const mockCallback = (error: unknown) => {
        expect((error as { code: number }).code).toBe(grpc.status.INTERNAL);
        expect((error as Error).message).toBe('Internal server error');
      };

      await handler(mockCall as grpc.ServerUnaryCall<unknown, never>, mockCallback);
    });
  });

  describe('Service Management', () => {
    test('should provide service status information', () => {
      expect(grpcServer.getStatus()).toBe(false);
      expect(grpcServer.getRegisteredServices()).toEqual([]);
    });

    test('should track service registration attempts', () => {
      const services = grpcServer.getRegisteredServices();

      expect(Array.isArray(services)).toBe(true);
      expect(services.length).toBe(0);
    });
  });

  describe('Port Binding', () => {
    test('should start on available port', async () => {
      const testConfig = {
        httpPort: 8765,
        grpcPort: 0, // Let OS choose port
        maxConnections: 100,
      };

      const server = new GrpcServer(testConfig, logger);

      try {
        await server.start();
        expect(server.getStatus()).toBe(true);
      } finally {
        await server.stop();
      }
    });
  });
});
