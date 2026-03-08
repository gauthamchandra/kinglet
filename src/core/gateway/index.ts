/**
 * API Gateway module exports
 */

// gRPC-REST transcoding bridge
export * from './grpc-rest-bridge.ts';

// gRPC Server infrastructure
export * from './grpc-server.ts';

// Protocol buffer types and utilities
export type {
  AppEngineHttpRequest,
  HttpRequest as ProtobufHttpRequest,
  RetryConfig as ProtobufRetryConfig,
} from './proto-types.ts';
// Request Router
export { RequestRouter, type RouteHandler as RequestRouteHandler } from './request-router.ts';
// Response handlers and formatters
export * from './response-handlers.ts';

// Service Dispatcher
export {
  type RetryConfig as DispatcherRetryConfig,
  ServiceDispatcher,
} from './service-dispatcher.ts';

// Validation Layer
export * from './validation-layer.ts';
