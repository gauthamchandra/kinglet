/**
 * Service Registry
 *
 * Manages dynamic service registration, version management, health checking,
 * and service discovery for the LocalStack GCP emulator.
 */

import type { Logger } from '@/shared/utils/logger.ts';

// Service registration and health interfaces
export interface ServiceDefinition {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly endpoint: ServiceEndpoint;
  readonly protocols: ServiceProtocol[];
  readonly schemas: ServiceSchema[];
  readonly methods: ServiceMethod[];
  readonly resources?: ServiceResource[];
  readonly healthCheckPath?: string;
  readonly tags?: string[];
  readonly metadata?: Record<string, unknown>;
}

export interface ServiceEndpoint {
  readonly host: string;
  readonly port: number;
  readonly basePath: string;
  readonly ssl: boolean;
}

export interface ServiceProtocol {
  readonly name: 'http' | 'grpc';
  readonly version: string;
  readonly port: number;
}

export interface ServiceSchema {
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly properties: ServiceProperty[];
  readonly required: string[];
}

export interface ServiceProperty {
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly format?: string;
  readonly repeated?: boolean;
  readonly properties?: ServiceProperty[];
  readonly items?: ServiceProperty;
  readonly ref?: string;
}

export interface ServiceMethod {
  readonly name: string;
  readonly httpMethod: string;
  readonly path: string;
  readonly description: string;
  readonly parameters: ServiceParameter[];
  readonly requestSchema?: string;
  readonly responseSchema?: string;
  readonly scopes?: string[];
}

export interface ServiceParameter {
  readonly name: string;
  readonly type: string;
  readonly location: string;
  readonly required: boolean;
  readonly description: string;
  readonly format?: string;
  readonly pattern?: string;
}

export interface ServiceResource {
  readonly name: string;
  readonly methods: ServiceMethod[];
  readonly resources: ServiceResource[];
}

export interface ServiceHealth {
  readonly serviceId: string;
  readonly status: HealthStatus;
  readonly lastCheck: Date;
  readonly lastHealthy: Date | null;
  readonly consecutiveFailures: number;
  readonly responseTime?: number;
  readonly details?: HealthDetails;
}

export interface HealthDetails {
  readonly version?: string;
  readonly uptime?: number;
  readonly dependencies?: DependencyHealth[];
  readonly custom?: Record<string, unknown>;
}

export interface DependencyHealth {
  readonly name: string;
  readonly status: HealthStatus;
  readonly responseTime?: number;
  readonly error?: string;
}

export type HealthStatus = 'healthy' | 'unhealthy' | 'degraded' | 'unknown';

export interface ServiceQuery {
  readonly name?: string;
  readonly version?: string;
  readonly tag?: string;
  readonly protocol?: string;
  readonly healthyOnly?: boolean;
}

export interface ServiceVersionInfo {
  readonly serviceName: string;
  readonly versions: VersionEntry[];
  readonly defaultVersion: string;
}

export interface VersionEntry {
  readonly version: string;
  readonly serviceId: string;
  readonly registeredAt: Date;
  readonly deprecated?: boolean;
  readonly sunset?: Date;
}

// Registry configuration
export interface RegistryConfig {
  readonly healthCheckInterval: number; // milliseconds
  readonly healthCheckTimeout: number; // milliseconds
  readonly maxConsecutiveFailures: number;
  readonly enableAutoDeregistration: boolean;
  readonly autoDeregistrationDelay: number; // milliseconds
}

export const DEFAULT_REGISTRY_CONFIG: RegistryConfig = {
  healthCheckInterval: 30000, // 30 seconds
  healthCheckTimeout: 5000, // 5 seconds
  maxConsecutiveFailures: 3,
  enableAutoDeregistration: true,
  autoDeregistrationDelay: 300000, // 5 minutes
};

/**
 * Dynamic Service Registry with health checking and discovery
 */
export class ServiceRegistry {
  private logger: Logger;
  private config: RegistryConfig;
  private services: Map<string, ServiceDefinition> = new Map();
  private servicesByName: Map<string, Set<string>> = new Map();
  private serviceHealth: Map<string, ServiceHealth> = new Map();
  private healthCheckInterval: number | null = null;
  private eventListeners: Map<RegistryEvent, Set<RegistryEventListener>> = new Map();

  constructor(logger: Logger, config: Partial<RegistryConfig> = {}) {
    this.logger = logger;
    this.config = { ...DEFAULT_REGISTRY_CONFIG, ...config };

    // Initialize event listener maps
    this.initializeEventListeners();

    // Start health checking
    this.startHealthChecking();

    this.logger.info('Service Registry initialized', {
      healthCheckInterval: this.config.healthCheckInterval,
      autoDeregistration: this.config.enableAutoDeregistration,
    });
  }

  /**
   * Register a service with the registry
   */
  async registerService(service: ServiceDefinition): Promise<void> {
    // Validate service definition
    this.validateServiceDefinition(service);

    // Check if service already exists
    if (this.services.has(service.id)) {
      throw new Error(`Service with ID '${service.id}' already registered`);
    }

    // Register the service
    this.services.set(service.id, service);

    // Update name-based index
    this.updateServiceNameIndex(service);

    // Initialize health status
    this.serviceHealth.set(service.id, {
      serviceId: service.id,
      status: 'unknown',
      lastCheck: new Date(),
      lastHealthy: null,
      consecutiveFailures: 0,
    });

    // Perform initial health check
    await this.performHealthCheck(service.id);

    this.logger.info(`Service registered: ${service.name} v${service.version}`, {
      serviceId: service.id,
      endpoint: service.endpoint,
      protocols: service.protocols.map(p => p.name),
    });

    // Emit registration event
    this.emit('service:registered', {
      serviceId: service.id,
      serviceName: service.name,
      version: service.version,
      timestamp: new Date(),
    });
  }

  /**
   * Deregister a service from the registry
   */
  async deregisterService(serviceId: string): Promise<boolean> {
    const service = this.services.get(serviceId);

    if (!service) {
      return false;
    }

    // Remove from main registry
    this.services.delete(serviceId);

    // Update name-based index
    const nameSet = this.servicesByName.get(service.name);

    if (nameSet) {
      nameSet.delete(serviceId);
      if (nameSet.size === 0) {
        this.servicesByName.delete(service.name);
      }
    }

    // Remove health status
    this.serviceHealth.delete(serviceId);

    this.logger.info(`Service deregistered: ${service.name} v${service.version}`, {
      serviceId,
    });

    // Emit deregistration event
    this.emit('service:deregistered', {
      serviceId,
      serviceName: service.name,
      version: service.version,
      timestamp: new Date(),
    });

    return true;
  }

  /**
   * Discover services matching query criteria
   */
  discoverServices(query: ServiceQuery = {}): ServiceDefinition[] {
    let results = Array.from(this.services.values());

    // Filter by name
    if (query.name) {
      results = results.filter(service => service.name === query.name);
    }

    // Filter by version
    if (query.version) {
      results = results.filter(service => service.version === query.version);
    }

    // Filter by tag
    if (query.tag) {
      const tag = query.tag;

      results = results.filter(service => service.tags?.includes(tag));
    }

    // Filter by protocol
    if (query.protocol) {
      results = results.filter(service => service.protocols.some(p => p.name === query.protocol));
    }

    // Filter by health status
    if (query.healthyOnly) {
      results = results.filter(service => {
        const health = this.serviceHealth.get(service.id);

        return health?.status === 'healthy';
      });
    }

    return results;
  }

  /**
   * Get a specific service by ID
   */
  getService(serviceId: string): ServiceDefinition | null {
    return this.services.get(serviceId) || null;
  }

  /**
   * Get services by name
   */
  getServicesByName(name: string): ServiceDefinition[] {
    const serviceIds = this.servicesByName.get(name);

    if (!serviceIds) {
      return [];
    }

    return Array.from(serviceIds)
      .map(id => this.services.get(id))
      .filter(Boolean) as ServiceDefinition[];
  }

  /**
   * Get version information for a service
   */
  getServiceVersions(serviceName: string): ServiceVersionInfo | null {
    const services = this.getServicesByName(serviceName);

    if (services.length === 0) {
      return null;
    }

    const versions: VersionEntry[] = services.map(service => ({
      version: service.version,
      serviceId: service.id,
      registeredAt: new Date(), // In real implementation, track registration time
      deprecated: false, // Could be added to ServiceDefinition
    }));

    // Sort versions (simple string sort, could be improved with semver)
    versions.sort((a, b) => b.version.localeCompare(a.version));

    return {
      serviceName,
      versions,
      defaultVersion: versions[0]?.version || '',
    };
  }

  /**
   * Get health status for a service
   */
  getServiceHealth(serviceId: string): ServiceHealth | null {
    return this.serviceHealth.get(serviceId) || null;
  }

  /**
   * Get health status for all services
   */
  getAllServiceHealth(): ServiceHealth[] {
    return Array.from(this.serviceHealth.values());
  }

  /**
   * Get registry statistics
   */
  getStats(): RegistryStats {
    const healthCounts = Array.from(this.serviceHealth.values()).reduce(
      (acc, health) => {
        acc[health.status] = (acc[health.status] || 0) + 1;

        return acc;
      },
      {} as Record<HealthStatus, number>
    );

    return {
      totalServices: this.services.size,
      healthyServices: healthCounts.healthy || 0,
      unhealthyServices: healthCounts.unhealthy || 0,
      degradedServices: healthCounts.degraded || 0,
      unknownServices: healthCounts.unknown || 0,
      uniqueServiceNames: this.servicesByName.size,
      lastHealthCheck: new Date(),
    };
  }

  /**
   * Subscribe to registry events
   */
  on(event: RegistryEvent, listener: RegistryEventListener): void {
    const listeners = this.eventListeners.get(event);

    if (listeners) {
      listeners.add(listener);
    }
  }

  /**
   * Unsubscribe from registry events
   */
  off(event: RegistryEvent, listener: RegistryEventListener): void {
    const listeners = this.eventListeners.get(event);

    if (listeners) {
      listeners.delete(listener);
    }
  }

  /**
   * Close the registry and cleanup resources
   */
  async close(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    this.logger.info('Service Registry closed');
  }

  /**
   * Initialize event listener maps
   */
  private initializeEventListeners(): void {
    const events: RegistryEvent[] = [
      'service:registered',
      'service:deregistered',
      'health:changed',
      'health:check:failed',
    ];

    for (const event of events) {
      this.eventListeners.set(event, new Set());
    }
  }

  /**
   * Validate service definition
   */
  private validateServiceDefinition(service: ServiceDefinition): void {
    if (!service.id || !service.name || !service.version) {
      throw new Error('Service must have id, name, and version');
    }

    if (!service.endpoint) {
      throw new Error('Service must have an endpoint');
    }

    if (!service.protocols || service.protocols.length === 0) {
      throw new Error('Service must support at least one protocol');
    }

    // Validate endpoint
    if (!service.endpoint.host || !service.endpoint.port) {
      throw new Error('Service endpoint must have host and port');
    }

    // Validate protocols
    for (const protocol of service.protocols) {
      if (!['http', 'grpc'].includes(protocol.name)) {
        throw new Error(`Unsupported protocol: ${protocol.name}`);
      }
    }
  }

  /**
   * Update name-based service index
   */
  private updateServiceNameIndex(service: ServiceDefinition): void {
    if (!this.servicesByName.has(service.name)) {
      this.servicesByName.set(service.name, new Set());
    }

    const nameSet = this.servicesByName.get(service.name);

    if (nameSet) {
      nameSet.add(service.id);
    }
  }

  /**
   * Start periodic health checking
   */
  private startHealthChecking(): void {
    if (this.config.healthCheckInterval <= 0) {
      return;
    }

    this.healthCheckInterval = setInterval(async () => {
      await this.performAllHealthChecks();
    }, this.config.healthCheckInterval) as unknown as number;
  }

  /**
   * Perform health checks for all services
   */
  private async performAllHealthChecks(): Promise<void> {
    const serviceIds = Array.from(this.services.keys());

    // Perform health checks in parallel
    await Promise.allSettled(serviceIds.map(serviceId => this.performHealthCheck(serviceId)));
  }

  /**
   * Perform health check for a specific service
   */
  private async performHealthCheck(serviceId: string): Promise<void> {
    const service = this.services.get(serviceId);
    const currentHealth = this.serviceHealth.get(serviceId);

    if (!service || !currentHealth) {
      return;
    }

    const startTime = Date.now();
    let newStatus: HealthStatus = 'unknown';
    let details: HealthDetails | undefined;

    try {
      // Perform actual health check
      const healthResult = await this.doHealthCheck(service);

      newStatus = healthResult.status;
      details = healthResult.details;

      // Update consecutive failures counter
      if (newStatus === 'healthy') {
        const healthUpdate: ServiceHealth = {
          ...currentHealth,
          status: newStatus,
          lastCheck: new Date(),
          lastHealthy: new Date(),
          consecutiveFailures: 0,
          responseTime: Date.now() - startTime,
          ...(details && { details }),
        };

        this.serviceHealth.set(serviceId, healthUpdate);
      } else {
        const healthUpdate: ServiceHealth = {
          ...currentHealth,
          status: newStatus,
          lastCheck: new Date(),
          consecutiveFailures: currentHealth.consecutiveFailures + 1,
          responseTime: Date.now() - startTime,
          ...(details && { details }),
        };

        this.serviceHealth.set(serviceId, healthUpdate);
      }
    } catch (error) {
      const err = error as Error;

      this.serviceHealth.set(serviceId, {
        ...currentHealth,
        status: 'unhealthy',
        lastCheck: new Date(),
        consecutiveFailures: currentHealth.consecutiveFailures + 1,
        responseTime: Date.now() - startTime,
        details: {
          custom: { error: err.message },
        },
      });

      this.logger.warn(`Health check failed for service ${service.name}`, {
        serviceId,
        error: err.message,
      });

      this.emit('health:check:failed', {
        serviceId,
        serviceName: service.name,
        error: err.message,
        timestamp: new Date(),
      });
    }

    // Check if status changed
    if (currentHealth.status !== newStatus) {
      this.emit('health:changed', {
        serviceId,
        serviceName: service.name,
        oldStatus: currentHealth.status,
        newStatus,
        timestamp: new Date(),
      });
    }

    // Auto-deregister unhealthy services if configured
    if (this.config.enableAutoDeregistration) {
      const updatedHealth = this.serviceHealth.get(serviceId);

      if (!updatedHealth) {
        return;
      }

      if (updatedHealth.consecutiveFailures >= this.config.maxConsecutiveFailures) {
        setTimeout(() => {
          this.autoDeregisterService(serviceId);
        }, this.config.autoDeregistrationDelay);
      }
    }
  }

  /**
   * Perform actual health check HTTP request
   */
  private async doHealthCheck(service: ServiceDefinition): Promise<{
    status: HealthStatus;
    details?: HealthDetails;
  }> {
    const healthPath = service.healthCheckPath || '/health';
    const protocol = service.endpoint.ssl ? 'https' : 'http';
    const url = `${protocol}://${service.endpoint.host}:${service.endpoint.port}${healthPath}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(this.config.healthCheckTimeout),
        headers: {
          'User-Agent': 'LocalStack-GCP-ServiceRegistry/1.0',
        },
      });

      if (response.ok) {
        // Try to parse response for additional details
        try {
          const body = await response.text();
          const details = body ? JSON.parse(body) : {};

          return {
            status: 'healthy',
            details: details as HealthDetails,
          };
        } catch {
          // Ignore JSON parsing errors, service is still healthy
          return { status: 'healthy' };
        }
      } else if (response.status >= 500) {
        return { status: 'unhealthy' };
      } else {
        return { status: 'degraded' };
      }
    } catch (error) {
      const err = error as Error;

      // Check if it's a timeout
      if (err.name === 'TimeoutError') {
        return { status: 'degraded' };
      }

      return { status: 'unhealthy' };
    }
  }

  /**
   * Auto-deregister a service after consecutive failures
   */
  private async autoDeregisterService(serviceId: string): Promise<void> {
    const health = this.serviceHealth.get(serviceId);

    if (!health || health.consecutiveFailures < this.config.maxConsecutiveFailures) {
      return;
    }

    this.logger.warn(
      `Auto-deregistering service after ${health.consecutiveFailures} consecutive failures`,
      { serviceId }
    );

    await this.deregisterService(serviceId);
  }

  /**
   * Emit registry event
   */
  private emit(event: RegistryEvent, data: RegistryEventData): void {
    const listeners = this.eventListeners.get(event);

    if (!listeners) {
      throw new Error('Event listeners set should exist after initialization');
    }

    for (const listener of listeners) {
      try {
        // Handle both sync and async listeners
        const result = listener(data);

        if (result instanceof Promise) {
          result.catch(error => {
            this.logger.error('Registry event listener error', {
              event,
              error: (error as Error).message,
            });
          });
        }
      } catch (error) {
        this.logger.error('Registry event listener error', {
          event,
          error: (error as Error).message,
        });
      }
    }
  }
}

// Registry events and types
export type RegistryEvent =
  | 'service:registered'
  | 'service:deregistered'
  | 'health:changed'
  | 'health:check:failed';

export interface RegistryEventData {
  readonly serviceId: string;
  readonly serviceName: string;
  readonly version?: string;
  readonly oldStatus?: HealthStatus;
  readonly newStatus?: HealthStatus;
  readonly error?: string;
  readonly timestamp: Date;
}

export type RegistryEventListener = (data: RegistryEventData) => void | Promise<void>;

export interface RegistryStats {
  readonly totalServices: number;
  readonly healthyServices: number;
  readonly unhealthyServices: number;
  readonly degradedServices: number;
  readonly unknownServices: number;
  readonly uniqueServiceNames: number;
  readonly lastHealthCheck: Date;
}
