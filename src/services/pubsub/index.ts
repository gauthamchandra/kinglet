/**
 * Pub/Sub Service Implementation
 *
 * Complete Pub/Sub service with topic management, subscription handling,
 * message brokering, and discovery registration capabilities.
 */

import type { Logger } from '@/shared/utils/logger.js';
import type { IStorageManager } from '@/core/storage/interfaces.js';
import type { DiscoveryDocumentGenerator } from '@/core/discovery/discovery-document-generator.js';
import { TopicManager } from './topic-manager.js';
import { SubscriptionManager } from './subscription-manager.js';
import { MessageBroker } from './message-broker.js';
import {
  PubSubServiceRegistration,
  type PubSubRegistrationConfig,
} from './service-registration.js';

export interface PubSubServiceConfig extends Partial<PubSubRegistrationConfig> {
  /** Whether to enable automatic service registration */
  readonly autoRegister?: boolean;
}

/**
 * Complete Pub/Sub service implementation
 */
export class PubSubService {
  private readonly logger: Logger;
  private readonly storage: IStorageManager;
  private readonly config: PubSubServiceConfig;

  private readonly topicManager: TopicManager;
  private readonly subscriptionManager: SubscriptionManager;
  private readonly messageBroker: MessageBroker;
  private readonly serviceRegistration: PubSubServiceRegistration;

  private initialized = false;

  constructor(logger: Logger, storage: IStorageManager, config: PubSubServiceConfig = {}) {
    this.logger = logger;
    this.storage = storage;
    this.config = config;

    // Initialize service components
    this.topicManager = new TopicManager(storage, logger);
    this.subscriptionManager = new SubscriptionManager(storage, logger);
    this.messageBroker = new MessageBroker(storage, logger);
    this.serviceRegistration = new PubSubServiceRegistration(logger, config);
  }

  /**
   * Initialize the Pub/Sub service
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      this.logger.warn('Pub/Sub service already initialized');

      return;
    }

    try {
      this.logger.info('Initializing Pub/Sub service...');

      // Initialize all service components
      await this.topicManager.initialize();
      await this.subscriptionManager.initialize();
      await this.messageBroker.initialize();

      this.initialized = true;

      this.logger.info('Pub/Sub service initialized successfully');
    } catch (error) {
      const err = error as Error;

      this.logger.error('Failed to initialize Pub/Sub service:', {
        error: err.message,
        stack: err.stack,
      });
      throw error;
    }
  }

  /**
   * Register service with Discovery API
   */
  async registerWithDiscovery(discoveryGenerator: DiscoveryDocumentGenerator): Promise<void> {
    if (!this.initialized) {
      throw new Error('Pub/Sub service must be initialized before registration');
    }

    await this.serviceRegistration.registerService(discoveryGenerator);
  }

  /**
   * Get topic manager
   */
  getTopicManager(): TopicManager {
    return this.topicManager;
  }

  /**
   * Get subscription manager
   */
  getSubscriptionManager(): SubscriptionManager {
    return this.subscriptionManager;
  }

  /**
   * Get message broker
   */
  getMessageBroker(): MessageBroker {
    return this.messageBroker;
  }

  /**
   * Get service registration manager
   */
  getServiceRegistration(): PubSubServiceRegistration {
    return this.serviceRegistration;
  }

  /**
   * Check if service is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get service status
   */
  getStatus(): {
    initialized: boolean;
    registered: boolean;
    components: {
      topicManager: boolean;
      subscriptionManager: boolean;
      messageBroker: boolean;
    };
  } {
    return {
      initialized: this.initialized,
      registered: this.serviceRegistration.isRegistered(),
      components: {
        topicManager: true, // TopicManager doesn't expose initialization status
        subscriptionManager: true, // SubscriptionManager doesn't expose initialization status
        messageBroker: true, // MessageBroker doesn't expose initialization status
      },
    };
  }

  /**
   * Perform health check on service
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    components: Record<string, boolean>;
    errors: string[];
  }> {
    const errors: string[] = [];
    const components: Record<string, boolean> = {};

    try {
      // Check if service is initialized
      components.initialized = this.initialized;
      if (!this.initialized) {
        errors.push('Service not initialized');
      }

      // Check registration status
      components.registered = this.serviceRegistration.isRegistered();

      // Check storage connection (basic test)
      try {
        await this.storage.healthCheck();
        components.storage = true;
      } catch (error) {
        const err = error as Error;

        components.storage = false;
        errors.push(`Storage health check failed: ${err.message}`);
      }

      // Could add more component-specific health checks here
      components.topicManager = true;
      components.subscriptionManager = true;
      components.messageBroker = true;

      return {
        healthy: errors.length === 0,
        components,
        errors,
      };
    } catch (error) {
      const err = error as Error;

      errors.push(`Health check failed: ${err.message}`);

      return {
        healthy: false,
        components,
        errors,
      };
    }
  }
}

// Re-export key components and types
export { TopicManager, SubscriptionManager, MessageBroker };
export { PubSubServiceRegistration, type PubSubRegistrationConfig };
export { createPubSubServiceInfo } from './discovery.js';
export type * from './models.js';
export type * from './topic-manager.js';
export type * from './subscription-manager.js';
export type * from './message-broker.js';
