/**
 * gRPC Server implementation
 * Provides the foundation gRPC server with service registration and reflection support
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { Config } from '@/config/schema.ts';
import type { Logger } from '@/shared/utils/logger.ts';

export interface GrpcServiceDefinition {
  name: string;
  protoPath: string;
  packageName: string;
  serviceName: string;
  implementation: grpc.UntypedServiceImplementation;
}

export interface HealthCheckService {
  check(call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>): void;
  watch(call: grpc.ServerWritableStream<unknown, unknown>): void;
}

export class GrpcServer {
  private server: grpc.Server;
  private config: Config['server'];
  private logger: Logger;
  private services: Map<string, GrpcServiceDefinition> = new Map();
  private isRunning: boolean = false;

  constructor(config: Config['server'], logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.server = new grpc.Server();

    // Set up health check service by default
    this.setupHealthCheckService();

    // Set up reflection service for debugging
    this.setupReflectionService();
  }

  /**
   * Register a gRPC service with the server
   */
  registerService(serviceDefinition: GrpcServiceDefinition): void {
    try {
      this.logger.debug(`Registering gRPC service: ${serviceDefinition.name}`);

      // Load the protocol buffer definition
      const packageDefinition = protoLoader.loadSync(serviceDefinition.protoPath, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      });

      const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as unknown;

      // Navigate to the service definition
      const servicePackage = this.getNestedObject(protoDescriptor, serviceDefinition.packageName);

      if (!servicePackage) {
        throw new Error(`Package ${serviceDefinition.packageName} not found in proto definition`);
      }

      const ServiceConstructor =
        servicePackage && typeof servicePackage === 'object' && servicePackage !== null
          ? (servicePackage as Record<string, unknown>)[serviceDefinition.serviceName]
          : undefined;

      if (!ServiceConstructor) {
        throw new Error(
          `Service ${serviceDefinition.serviceName} not found in package ${serviceDefinition.packageName}`
        );
      }

      // Validate that the ServiceConstructor has a service property
      if (
        typeof ServiceConstructor !== 'object' ||
        ServiceConstructor === null ||
        !('service' in ServiceConstructor)
      ) {
        throw new Error(
          `ServiceConstructor for ${serviceDefinition.serviceName} does not have a 'service' property. ` +
            `This usually indicates an invalid proto definition or incorrect service name.`
        );
      }

      const serviceDescriptor = (ServiceConstructor as { service: unknown }).service;

      if (!serviceDescriptor || typeof serviceDescriptor !== 'object') {
        throw new Error(
          `ServiceConstructor.service for ${serviceDefinition.serviceName} is not a valid service descriptor. ` +
            `Expected an object containing service method definitions.`
        );
      }

      // Add the service to the server
      this.server.addService(
        serviceDescriptor as grpc.ServiceDefinition<grpc.UntypedServiceImplementation>,
        serviceDefinition.implementation
      );

      // Store the service definition
      this.services.set(serviceDefinition.name, serviceDefinition);

      this.logger.info(`Registered gRPC service: ${serviceDefinition.name}`);
    } catch (error) {
      this.logger.error(`Failed to register gRPC service ${serviceDefinition.name}:`, error);
      throw error;
    }
  }

  /**
   * Start the gRPC server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const bindAddress = `0.0.0.0:${this.config.grpcPort}`;

      this.server.bindAsync(bindAddress, grpc.ServerCredentials.createInsecure(), (error, port) => {
        if (error) {
          this.logger.error('Failed to bind gRPC server:', error);
          reject(error);

          return;
        }

        this.server.start();
        this.isRunning = true;
        this.logger.info(`gRPC server started on port ${port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the gRPC server
   */
  async stop(): Promise<void> {
    return new Promise(resolve => {
      if (!this.isRunning) {
        resolve();

        return;
      }

      this.server.tryShutdown(error => {
        if (error) {
          this.logger.warn('Error during gRPC server shutdown:', error);
          // Force shutdown if graceful shutdown fails
          this.server.forceShutdown();
        }

        this.isRunning = false;
        this.logger.info('gRPC server stopped');
        resolve();
      });
    });
  }

  /**
   * Check if the server is running
   */
  getStatus(): boolean {
    return this.isRunning;
  }

  /**
   * Get list of registered services
   */
  getRegisteredServices(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * Get service definition by name
   */
  getServiceDefinition(name: string): GrpcServiceDefinition | undefined {
    return this.services.get(name);
  }

  /**
   * Set up the health check service
   */
  private setupHealthCheckService(): void {
    const _healthService: HealthCheckService = {
      check: (_call, callback) => {
        // Simple health check - always return SERVING
        const response = {
          status: 'SERVING', // or 'NOT_SERVING', 'UNKNOWN', 'SERVICE_UNKNOWN'
        };

        this.logger.debug('Health check requested');
        callback(null, response);
      },

      watch: call => {
        // Health check streaming - for now just send SERVING status
        const response = {
          status: 'SERVING',
        };

        call.write(response);

        // Set up periodic health status updates
        const interval = setInterval(() => {
          if (!call.destroyed && !call.cancelled) {
            call.write(response);
          } else {
            clearInterval(interval);
          }
        }, 30000); // Send update every 30 seconds

        call.on('cancelled', () => {
          clearInterval(interval);
          this.logger.debug('Health check watch cancelled');
        });

        call.on('error', error => {
          clearInterval(interval);
          this.logger.warn('Health check watch error:', error);
        });
      },
    };

    // Health check service would be registered here if we had the proto file
    // For now, we'll add it as a placeholder in our service registry
    this.logger.debug(
      `Health check service configured with ${Object.keys(_healthService).length} methods`
    );
  }

  /**
   * Set up the server reflection service for debugging
   */
  private setupReflectionService(): void {
    // Server reflection would be set up here to enable tools like grpcurl
    // This allows clients to discover available services and methods
    this.logger.debug('gRPC reflection service configured (placeholder)');
  }

  /**
   * Helper to navigate nested objects by dot notation
   */
  private getNestedObject(obj: unknown, path: string): unknown {
    return path.split('.').reduce((current, key) => {
      return current && typeof current === 'object' && current !== null && key in current
        ? (current as Record<string, unknown>)[key]
        : undefined;
    }, obj);
  }

  /**
   * Create unary call handler with error handling
   */
  createUnaryHandler<TRequest, TResponse>(
    handler: (request: TRequest, metadata: grpc.Metadata) => Promise<TResponse>
  ): grpc.handleUnaryCall<TRequest, TResponse> {
    return async (call, callback) => {
      try {
        const result = await handler(call.request, call.metadata);

        callback(null, result);
      } catch (error) {
        this.logger.error('gRPC unary call error:', error);

        // Convert error to gRPC error
        const grpcError = this.convertToGrpcError(error);

        callback(grpcError);
      }
    };
  }

  /**
   * Create server streaming call handler with error handling
   */
  createServerStreamingHandler<TRequest, TResponse>(
    handler: (request: TRequest, metadata: grpc.Metadata) => AsyncIterable<TResponse>
  ): grpc.handleServerStreamingCall<TRequest, TResponse> {
    return async call => {
      try {
        const responseStream = handler(call.request, call.metadata);

        for await (const response of responseStream) {
          if (call.cancelled || call.destroyed) {
            break;
          }
          call.write(response);
        }

        call.end();
      } catch (error) {
        this.logger.error('gRPC server streaming call error:', error);

        const grpcError = this.convertToGrpcError(error);

        call.destroy(grpcError);
      }
    };
  }

  /**
   * Create client streaming call handler with error handling
   */
  createClientStreamingHandler<TRequest, TResponse>(
    handler: (requests: AsyncIterable<TRequest>, metadata: grpc.Metadata) => Promise<TResponse>
  ): grpc.handleClientStreamingCall<TRequest, TResponse> {
    return async (call, callback) => {
      try {
        const requests = this.createAsyncIterable(call);
        const result = await handler(requests, call.metadata);

        callback(null, result);
      } catch (error) {
        this.logger.error('gRPC client streaming call error:', error);

        const grpcError = this.convertToGrpcError(error);

        callback(grpcError);
      }
    };
  }

  /**
   * Create bidirectional streaming call handler with error handling
   */
  createBidiStreamingHandler<TRequest, TResponse>(
    handler: (
      requests: AsyncIterable<TRequest>,
      metadata: grpc.Metadata
    ) => AsyncIterable<TResponse>
  ): grpc.handleBidiStreamingCall<TRequest, TResponse> {
    return async call => {
      try {
        const requests = this.createAsyncIterable(call);
        const responses = handler(requests, call.metadata);

        for await (const response of responses) {
          if (call.cancelled || call.destroyed) {
            break;
          }
          call.write(response);
        }

        call.end();
      } catch (error) {
        this.logger.error('gRPC bidi streaming call error:', error);

        const grpcError = this.convertToGrpcError(error);

        call.destroy(grpcError);
      }
    };
  }

  /**
   * Convert regular error to gRPC error
   */
  private convertToGrpcError(error: unknown): grpc.ServiceError {
    if (error instanceof Error) {
      // Map common errors to gRPC status codes
      let code = grpc.status.INTERNAL;
      const message = error.message;

      // Use case-insensitive matching for better error detection
      const errorMessage = error.message.toLowerCase();

      if (errorMessage.includes('not found')) {
        code = grpc.status.NOT_FOUND;
      } else if (errorMessage.includes('already exists')) {
        code = grpc.status.ALREADY_EXISTS;
      } else if (errorMessage.includes('invalid') || errorMessage.includes('validation')) {
        code = grpc.status.INVALID_ARGUMENT;
      } else if (errorMessage.includes('unauthorized')) {
        code = grpc.status.UNAUTHENTICATED;
      } else if (errorMessage.includes('forbidden')) {
        code = grpc.status.PERMISSION_DENIED;
      } else if (errorMessage.includes('unavailable')) {
        code = grpc.status.UNAVAILABLE;
      }

      const grpcError = Object.create(Error.prototype) as grpc.ServiceError;

      grpcError.code = code;
      grpcError.message = message;
      grpcError.name = 'ServiceError';

      return grpcError;
    }

    const grpcError = Object.create(Error.prototype) as grpc.ServiceError;

    grpcError.code = grpc.status.INTERNAL;
    grpcError.message = 'Internal server error';
    grpcError.name = 'ServiceError';

    return grpcError;
  }

  /**
   * Create async iterable from gRPC stream
   */
  private createAsyncIterable<T>(stream: grpc.ServerReadableStream<T, unknown>): AsyncIterable<T> {
    return {
      async *[Symbol.asyncIterator]() {
        const chunks: T[] = [];
        let resolve: ((value: IteratorResult<T>) => void) | null = null;
        let finished = false;

        stream.on('data', (chunk: T) => {
          if (resolve) {
            const currentResolve = resolve;

            resolve = null;
            currentResolve({ value: chunk, done: false });
          } else {
            chunks.push(chunk);
          }
        });

        stream.on('end', () => {
          finished = true;
          if (resolve) {
            const currentResolve = resolve;

            resolve = null;
            currentResolve({ value: undefined, done: true });
          }
        });

        stream.on('error', error => {
          finished = true;
          if (resolve) {
            resolve = null;
            throw error;
          }
        });

        while (!finished) {
          if (chunks.length > 0) {
            const chunk = chunks.shift();

            if (chunk !== undefined) {
              yield chunk;
            }
          } else {
            const result = await new Promise<IteratorResult<T>>(res => {
              resolve = res;
            });

            if (result.done) {
              break;
            }

            yield result.value;
          }
        }
      },
    };
  }
}
