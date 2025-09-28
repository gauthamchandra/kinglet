/**
 * API Gateway module exports
 */

// HTTP Server infrastructure
export {
  HttpServer,
  type HttpRequest as HttpServerRequest,
  type HttpResponse,
  type RouteHandler as HttpRouteHandler,
  type Middleware,
  type Route,
} from './http-server.ts';

// Request pipeline middleware
export * from './middleware.ts';

// Response handlers and formatters
export * from './response-handlers.ts';

// gRPC Server infrastructure
export * from './grpc-server.ts';

// Protocol buffer types and utilities
export {
  type HttpRequest as ProtobufHttpRequest,
  type AppEngineHttpRequest,
  type RetryConfig as ProtobufRetryConfig,
} from './proto-types.ts';

// gRPC-REST transcoding bridge
export * from './grpc-rest-bridge.ts';

// Request Router
export { RequestRouter, type RouteHandler as RequestRouteHandler } from './request-router.ts';

// Service Dispatcher
export {
  ServiceDispatcher,
  type RetryConfig as DispatcherRetryConfig,
} from './service-dispatcher.ts';

// Validation Layer
export * from './validation-layer.ts';

// TODO: Complete API Gateway orchestration class
export class APIGateway {
  // Placeholder for API Gateway orchestration implementation
  // This will integrate the HTTP server, middleware, response handlers, and gRPC bridge
}
