/**
 * Discovery API module exports
 */

// Discovery Document Generator (exclude conflicting types)
export * from './discovery-document-generator.ts';
// Discovery API Endpoints
export * from './discovery-endpoints.ts';
// Service Registry (exclude conflicting types)
export {
  type HealthDetails,
  type HealthStatus,
  type ServiceHealth,
  ServiceRegistry,
} from './service-registry.ts';
