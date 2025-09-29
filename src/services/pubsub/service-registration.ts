/**
 * Pub/Sub Service Registration
 *
 * Handles registration of the Pub/Sub service with the Discovery API,
 * making it available for client discovery and introspection.
 */

import type { Logger } from '@/shared/utils/logger.js';
import type { DiscoveryDocumentGenerator } from '@/core/discovery/discovery-document-generator.js';
import { createPubSubServiceInfo } from './discovery.js';

/**
 * Configuration for Pub/Sub service registration
 */
export interface PubSubRegistrationConfig {
  /** Base URL for the service */
  readonly baseUrl: string;
  /** Whether to enable the service */
  readonly enabled: boolean;
  /** Service endpoint configuration */
  readonly endpoint: {
    readonly host: string;
    readonly port: number;
    readonly ssl: boolean;
  };
}

/**
 * Default configuration for Pub/Sub service registration
 */
export const DEFAULT_PUBSUB_REGISTRATION_CONFIG: PubSubRegistrationConfig = {
  baseUrl: 'http://localhost:8765',
  enabled: true,
  endpoint: {
    host: 'localhost',
    port: 8765,
    ssl: false,
  },
};

/**
 * Pub/Sub Service Registration Manager
 */
export class PubSubServiceRegistration {
  private readonly logger: Logger;
  private readonly config: PubSubRegistrationConfig;
  private registered = false;

  constructor(logger: Logger, config: Partial<PubSubRegistrationConfig> = {}) {
    this.logger = logger;
    this.config = { ...DEFAULT_PUBSUB_REGISTRATION_CONFIG, ...config };
  }

  /**
   * Register Pub/Sub service with the Discovery API
   */
  async registerService(discoveryGenerator: DiscoveryDocumentGenerator): Promise<void> {
    try {
      if (!this.config.enabled) {
        this.logger.info('Pub/Sub service registration disabled');

        return;
      }

      if (this.registered) {
        this.logger.warn('Pub/Sub service already registered');

        return;
      }

      this.logger.info('Registering Pub/Sub service with Discovery API...');

      // Create service info with current configuration
      const serviceInfo = createPubSubServiceInfo(this.config.baseUrl);

      // Register with discovery system
      discoveryGenerator.registerService(serviceInfo);

      this.registered = true;

      this.logger.info('Pub/Sub service registered successfully', {
        name: serviceInfo.name,
        version: serviceInfo.version,
        baseUrl: serviceInfo.baseUrl,
        methodsCount: serviceInfo.methods.length,
        schemasCount: serviceInfo.schemas.length,
        resourcesCount: serviceInfo.resources.length,
      });
    } catch (error) {
      const err = error as Error;

      this.logger.error('Failed to register Pub/Sub service:', {
        error: err.message,
        stack: err.stack,
      });
      throw error;
    }
  }

  /**
   * Check if service is registered
   */
  isRegistered(): boolean {
    return this.registered;
  }

  /**
   * Get service registration status
   */
  getStatus(): {
    registered: boolean;
    enabled: boolean;
    baseUrl: string;
    endpoint: {
      readonly host: string;
      readonly port: number;
      readonly ssl: boolean;
    };
  } {
    return {
      registered: this.registered,
      enabled: this.config.enabled,
      baseUrl: this.config.baseUrl,
      endpoint: this.config.endpoint,
    };
  }

  /**
   * Validate service registration requirements
   */
  async validateRegistration(): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Validate configuration
      if (!this.config.baseUrl) {
        errors.push('Base URL is required for service registration');
      }

      if (!this.config.endpoint.host) {
        errors.push('Endpoint host is required');
      }

      if (
        !this.config.endpoint.port ||
        this.config.endpoint.port < 1 ||
        this.config.endpoint.port > 65535
      ) {
        errors.push('Valid endpoint port (1-65535) is required');
      }

      // Validate URL format
      try {
        new URL(this.config.baseUrl);
      } catch {
        errors.push('Base URL must be a valid URL');
      }

      // Check service components
      const serviceInfo = createPubSubServiceInfo(this.config.baseUrl);

      if (serviceInfo.methods.length === 0) {
        warnings.push('Service has no methods defined');
      }

      if (serviceInfo.schemas.length === 0) {
        warnings.push('Service has no schemas defined');
      }

      if (serviceInfo.resources.length === 0) {
        warnings.push('Service has no resources defined');
      }

      // Validate discovery document generation
      try {
        // This would test the discovery document generation without actually registering
        const generator = new (
          await import('@/core/discovery/discovery-document-generator.js')
        ).DiscoveryDocumentGenerator(this.logger);

        generator.registerService(serviceInfo);
        const discoveryDoc = generator.generateDiscoveryDocument('pubsub', 'v1');

        if (!discoveryDoc.schemas || Object.keys(discoveryDoc.schemas).length === 0) {
          warnings.push('Generated discovery document has no schemas');
        }

        if (!discoveryDoc.resources || Object.keys(discoveryDoc.resources).length === 0) {
          warnings.push('Generated discovery document has no resources');
        }
      } catch (error) {
        const err = error as Error;

        errors.push(`Discovery document generation failed: ${err.message}`);
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
      };
    } catch (error) {
      const err = error as Error;

      errors.push(`Validation failed: ${err.message}`);

      return {
        valid: false,
        errors,
        warnings,
      };
    }
  }

  /**
   * Get service metrics for monitoring
   */
  getMetrics(): {
    registrationStatus: string;
    serviceHealth: string;
    lastRegistrationTime?: string;
    discoveryEndpoint: string;
  } {
    return {
      registrationStatus: this.registered ? 'registered' : 'not_registered',
      serviceHealth: this.config.enabled ? 'enabled' : 'disabled',
      discoveryEndpoint: `${this.config.baseUrl}/$discovery/rest?version=v1`,
    };
  }
}
