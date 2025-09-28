/**
 * Discovery API module exports
 */

// Discovery Document Generator (exclude conflicting types)
export * from './discovery-document-generator.ts';

// Service Registry (exclude conflicting types)
export {
  ServiceRegistry,
  type ServiceHealth,
  type HealthStatus,
  type HealthDetails,
} from './service-registry.ts';

// Discovery API Endpoints
export * from './discovery-endpoints.ts';
