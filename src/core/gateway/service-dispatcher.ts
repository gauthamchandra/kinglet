/**
 * Service Dispatcher
 *
 * Implements reliable service dispatch with service lookup, load balancing,
 * circuit breaker pattern, and retry logic for the LocalStack GCP emulator.
 */

import type {
  ServiceDefinition,
  ServiceQuery,
  ServiceRegistry,
} from '@/core/discovery/service-registry.ts';
import type { Logger } from '@/shared/utils/logger.ts';

// Dispatch configuration and interfaces
export interface DispatchConfig {
  readonly loadBalancer: LoadBalancerConfig;
  readonly circuitBreaker: CircuitBreakerConfig;
  readonly retry: RetryConfig;
  readonly timeout: TimeoutConfig;
  readonly healthCheck: HealthCheckConfig;
}

export interface LoadBalancerConfig {
  readonly strategy: LoadBalancerStrategy;
  readonly stickySession: boolean;
  readonly sessionTtl: number; // milliseconds
}

export interface CircuitBreakerConfig {
  readonly enabled: boolean;
  readonly failureThreshold: number;
  readonly recoveryTimeout: number; // milliseconds
  readonly monitoringPeriod: number; // milliseconds
  readonly minimumThroughput: number;
}

export interface RetryConfig {
  readonly enabled: boolean;
  readonly maxAttempts: number;
  readonly backoffStrategy: BackoffStrategy;
  readonly initialDelay: number; // milliseconds
  readonly maxDelay: number; // milliseconds
  readonly backoffMultiplier: number;
  readonly retryableErrors: string[];
  readonly retryableStatusCodes: number[];
}

export interface TimeoutConfig {
  readonly connectTimeout: number; // milliseconds
  readonly requestTimeout: number; // milliseconds
  readonly totalTimeout: number; // milliseconds
}

export interface HealthCheckConfig {
  readonly enableHealthFilter: boolean;
  readonly healthyOnly: boolean;
  readonly degradedAsHealthy: boolean;
}

export type LoadBalancerStrategy = 'round_robin' | 'random' | 'weighted' | 'least_connections';
export type BackoffStrategy = 'exponential' | 'linear' | 'fixed';

export const DEFAULT_DISPATCH_CONFIG: DispatchConfig = {
  loadBalancer: {
    strategy: 'round_robin',
    stickySession: false,
    sessionTtl: 3600000, // 1 hour
  },
  circuitBreaker: {
    enabled: true,
    failureThreshold: 5,
    recoveryTimeout: 60000, // 1 minute
    monitoringPeriod: 30000, // 30 seconds
    minimumThroughput: 10,
  },
  retry: {
    enabled: true,
    maxAttempts: 3,
    backoffStrategy: 'exponential',
    initialDelay: 100,
    maxDelay: 5000,
    backoffMultiplier: 2,
    retryableErrors: ['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT'],
    retryableStatusCodes: [502, 503, 504],
  },
  timeout: {
    connectTimeout: 5000,
    requestTimeout: 30000,
    totalTimeout: 60000,
  },
  healthCheck: {
    enableHealthFilter: true,
    healthyOnly: false,
    degradedAsHealthy: true,
  },
};

// Dispatch request and response interfaces
export interface DispatchRequest {
  readonly serviceName: string;
  readonly version?: string;
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string | string[]>;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
  readonly timeout?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface DispatchResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly serviceId: string;
  readonly responseTime: number;
  readonly retryCount: number;
  readonly fromCache?: boolean;
}

export interface DispatchContext {
  readonly requestId: string;
  readonly startTime: number;
  readonly attempt: number;
  readonly service: ServiceDefinition;
  readonly endpoint: ServiceEndpoint;
  readonly sessionId?: string;
}

export interface ServiceEndpoint {
  readonly serviceId: string;
  readonly url: string;
  readonly weight: number;
  readonly connections: number;
}

// Circuit breaker states and events
export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerStats {
  readonly serviceId: string;
  readonly state: CircuitState;
  readonly failures: number;
  readonly successes: number;
  readonly lastFailure?: Date;
  readonly nextAttempt?: Date;
  readonly totalRequests: number;
}

/**
 * Service Dispatcher with reliability patterns
 */
export class ServiceDispatcher {
  private logger: Logger;
  private config: DispatchConfig;
  private serviceRegistry: ServiceRegistry;
  private loadBalancer: LoadBalancer;
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private sessions: Map<string, ServiceSession> = new Map();
  private metrics: DispatchMetrics;

  constructor(
    logger: Logger,
    serviceRegistry: ServiceRegistry,
    config: Partial<DispatchConfig> = {}
  ) {
    this.logger = logger;
    this.config = { ...DEFAULT_DISPATCH_CONFIG, ...config };
    this.serviceRegistry = serviceRegistry;
    this.loadBalancer = new LoadBalancer(this.config.loadBalancer, logger);
    this.metrics = this.createMetrics();

    // Start circuit breaker monitoring
    if (this.config.circuitBreaker.enabled) {
      this.startCircuitBreakerMonitoring();
    }

    // Start session cleanup
    if (this.config.loadBalancer.stickySession) {
      this.startSessionCleanup();
    }

    this.logger.info('Service Dispatcher initialized', {
      loadBalancer: this.config.loadBalancer.strategy,
      circuitBreaker: this.config.circuitBreaker.enabled,
      retry: this.config.retry.enabled,
    });
  }

  /**
   * Dispatch request to appropriate service
   */
  async dispatch(request: DispatchRequest, sessionId?: string): Promise<DispatchResponse> {
    const requestId = this.generateRequestId();
    const startTime = Date.now();

    this.logger.debug('Dispatching request', {
      requestId,
      serviceName: request.serviceName,
      method: request.method,
      path: request.path,
    });

    try {
      // Find available services
      const services = this.findAvailableServices(request);

      if (services.length === 0) {
        this.recordMetric('noServiceAvailable');

        throw new DispatchError('No available services', 'SERVICE_UNAVAILABLE', 503);
      }

      // Create service endpoints
      const endpoints = this.createServiceEndpoints(services);

      // Perform dispatch with retry logic
      const response = await this.dispatchWithRetry(request, endpoints, requestId, sessionId);

      this.recordMetric('success');

      return response;
    } catch (error) {
      const err = error as Error;

      this.logger.error('Dispatch failed', {
        requestId,
        error: err.message,
        serviceName: request.serviceName,
      });

      this.recordMetric('failure');

      if (error instanceof DispatchError) {
        throw error;
      }

      throw new DispatchError('Dispatch failed', 'DISPATCH_ERROR', 500, {
        originalError: err.message,
      });
    } finally {
      this.metrics.totalRequests++;
      this.metrics.averageResponseTime = this.updateAverageResponseTime(Date.now() - startTime);
    }
  }

  /**
   * Get circuit breaker stats for all services
   */
  getCircuitBreakerStats(): CircuitBreakerStats[] {
    return Array.from(this.circuitBreakers.values()).map(cb => cb.getStats());
  }

  /**
   * Get dispatch metrics
   */
  getMetrics(): DispatchMetrics {
    return { ...this.metrics };
  }

  /**
   * Force circuit breaker state change (for testing/admin)
   */
  setCircuitBreakerState(serviceId: string, state: CircuitState): void {
    const circuitBreaker = this.getOrCreateCircuitBreaker(serviceId);

    circuitBreaker.setState(state);

    this.logger.info('Circuit breaker state changed', {
      serviceId,
      state,
    });
  }

  /**
   * Clear sticky sessions
   */
  clearSessions(): void {
    this.sessions.clear();
    this.logger.debug('All sticky sessions cleared');
  }

  /**
   * Find available services for request
   */
  private findAvailableServices(request: DispatchRequest): ServiceDefinition[] {
    const query: ServiceQuery = {
      name: request.serviceName,
      healthyOnly: this.config.healthCheck.healthyOnly,
      ...(request.version !== undefined && { version: request.version }),
    };

    const services = this.serviceRegistry.discoverServices(query);

    // Filter by health status and circuit breaker status
    return services.filter(service => {
      // Check health status if enabled
      if (this.config.healthCheck.enableHealthFilter) {
        const health = this.serviceRegistry.getServiceHealth(service.id);

        if (!health) {
          return false;
        }

        if (health.status === 'healthy') {
          // Continue to circuit breaker check
        } else if (health.status === 'degraded' && this.config.healthCheck.degradedAsHealthy) {
          // Continue to circuit breaker check
        } else {
          return false;
        }
      }

      // Check circuit breaker status if enabled
      if (this.config.circuitBreaker.enabled) {
        const circuitBreaker = this.circuitBreakers.get(service.id);

        if (circuitBreaker && !circuitBreaker.canExecute()) {
          return false; // Service blocked by circuit breaker
        }
      }

      return true;
    });
  }

  /**
   * Create service endpoints from service definitions
   */
  private createServiceEndpoints(services: ServiceDefinition[]): ServiceEndpoint[] {
    return services.map(service => ({
      serviceId: service.id,
      url: this.buildServiceUrl(service),
      weight: 1, // Could be made configurable
      connections: 0, // Would be tracked in real implementation
    }));
  }

  /**
   * Build service URL from service definition
   */
  private buildServiceUrl(service: ServiceDefinition): string {
    const protocol = service.endpoint.ssl ? 'https' : 'http';

    return `${protocol}://${service.endpoint.host}:${service.endpoint.port}${service.endpoint.basePath}`;
  }

  /**
   * Dispatch with retry logic
   */
  private async dispatchWithRetry(
    request: DispatchRequest,
    endpoints: ServiceEndpoint[],
    requestId: string,
    sessionId?: string
  ): Promise<DispatchResponse> {
    let lastError: Error | undefined;
    let attempt = 0;

    while (attempt < this.config.retry.maxAttempts) {
      attempt++;

      // Select endpoint using load balancer
      let endpoint: ServiceEndpoint | undefined;

      try {
        endpoint = this.selectEndpoint(endpoints, sessionId);

        // Check circuit breaker
        if (this.config.circuitBreaker.enabled) {
          const circuitBreaker = this.getOrCreateCircuitBreaker(endpoint.serviceId);

          if (!circuitBreaker.canExecute()) {
            this.logger.debug('Circuit breaker is open, skipping service', {
              serviceId: endpoint.serviceId,
            });

            continue; // Try next service or fail
          }
        }

        // Create dispatch context
        const service = this.getServiceDefinition(endpoint.serviceId);

        if (!service) {
          throw new DispatchError('Service definition not found', 'SERVICE_NOT_FOUND', 404, {
            serviceId: endpoint.serviceId,
          });
        }

        const context: DispatchContext = {
          requestId,
          startTime: Date.now(),
          attempt,
          service,
          endpoint,
          ...(sessionId !== undefined && { sessionId }),
        };

        // Execute request
        const response = await this.executeRequest(request, context);

        // Record success for circuit breaker
        if (this.config.circuitBreaker.enabled) {
          const circuitBreaker = this.getOrCreateCircuitBreaker(endpoint.serviceId);

          circuitBreaker.recordSuccess();
        }

        return response;
      } catch (error) {
        lastError = error as Error;

        // Record failure for circuit breaker
        if (this.config.circuitBreaker.enabled && endpoint) {
          const circuitBreaker = this.getOrCreateCircuitBreaker(endpoint.serviceId);

          circuitBreaker.recordFailure();
        }

        // Check if error is retryable
        if (
          !lastError ||
          !this.isRetryableError(lastError) ||
          attempt >= this.config.retry.maxAttempts
        ) {
          throw (
            lastError || new DispatchError('Unknown error during dispatch', 'UNKNOWN_ERROR', 500)
          );
        }

        // Wait before retry
        const delay = this.calculateRetryDelay(attempt);

        this.logger.debug('Retrying dispatch after delay', {
          requestId,
          attempt,
          delay,
          error: lastError.message,
        });

        await this.delay(delay);
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new DispatchError('Dispatch failed after all retry attempts', 'DISPATCH_FAILED', 502);
  }

  /**
   * Select service endpoint using load balancer
   */
  private selectEndpoint(endpoints: ServiceEndpoint[], sessionId?: string): ServiceEndpoint {
    if (this.config.loadBalancer.stickySession && sessionId) {
      const session = this.sessions.get(sessionId);

      if (session && endpoints.find(e => e.serviceId === session.serviceId)) {
        const stickyEndpoint = endpoints.find(e => e.serviceId === session.serviceId);

        if (stickyEndpoint) {
          return stickyEndpoint;
        }
      }
    }

    const selectedEndpoint = this.loadBalancer.selectEndpoint(endpoints);

    // Update sticky session
    if (this.config.loadBalancer.stickySession && sessionId) {
      this.sessions.set(sessionId, {
        serviceId: selectedEndpoint.serviceId,
        createdAt: new Date(),
        lastUsed: new Date(),
      });
    }

    return selectedEndpoint;
  }

  /**
   * Execute HTTP request to service
   */
  private async executeRequest(
    request: DispatchRequest,
    context: DispatchContext
  ): Promise<DispatchResponse> {
    const startTime = Date.now();
    const url = `${context.endpoint.url}${request.path}`;

    // Build query string
    const queryString = Object.entries(request.query)
      .flatMap(([key, value]) =>
        Array.isArray(value)
          ? value.map(v => `${encodeURIComponent(key)}=${encodeURIComponent(v)}`)
          : [`${encodeURIComponent(key)}=${encodeURIComponent(value)}`]
      )
      .join('&');

    const finalUrl = queryString ? `${url}?${queryString}` : url;

    // Prepare headers
    const headers = new Headers(request.headers);

    headers.set('X-Request-ID', context.requestId);
    headers.set('X-Forwarded-For', 'localstack-gcp-emulator');

    // Prepare request body
    let body: BodyInit | undefined;

    if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
      if (typeof request.body === 'string') {
        body = request.body;
      } else {
        body = JSON.stringify(request.body);
        headers.set('Content-Type', 'application/json');
      }
    }

    // Calculate timeout
    const timeout = request.timeout || this.config.timeout.requestTimeout;

    try {
      // Execute HTTP request
      const response = await fetch(finalUrl, {
        method: request.method,
        headers,
        body: body ?? null,
        signal: AbortSignal.timeout(timeout),
      });

      // Check if response indicates an error
      if (!response.ok) {
        // Parse error response body for better error messages
        let errorBody: unknown;
        const contentType = response.headers.get('Content-Type') || '';

        try {
          if (contentType.includes('application/json')) {
            errorBody = await response.json();
          } else {
            errorBody = await response.text();
          }
        } catch {
          errorBody = 'Unknown error';
        }

        throw new DispatchError(
          `HTTP ${response.status}: ${response.statusText}`,
          'HTTP_ERROR',
          response.status,
          {
            serviceId: context.service.id,
            errorBody,
          }
        );
      }

      // Parse successful response
      const responseHeaders: Record<string, string> = {};

      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let responseBody: unknown;
      const contentType = response.headers.get('Content-Type') || '';

      if (contentType.includes('application/json')) {
        responseBody = await response.json();
      } else {
        responseBody = await response.text();
      }

      const responseTime = Date.now() - startTime;

      return {
        status: response.status,
        headers: responseHeaders,
        body: responseBody,
        serviceId: context.service.id,
        responseTime,
        retryCount: context.attempt - 1,
      };
    } catch (error) {
      const err = error as Error;

      this.logger.warn('Request execution failed', {
        url: finalUrl,
        method: request.method,
        error: err.message,
        responseTime: Date.now() - startTime,
      });

      throw new DispatchError(
        `Request to ${context.service.name} failed: ${err.message}`,
        'REQUEST_FAILED',
        502,
        {
          serviceId: context.service.id,
          originalError: err.message,
        }
      );
    }
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: Error): boolean {
    if (!this.config.retry.enabled) {
      return false;
    }

    // Check for retryable error messages
    const isRetryableMessage = this.config.retry.retryableErrors.some(retryableError =>
      error.message.includes(retryableError)
    );

    if (isRetryableMessage) {
      return true;
    }

    // Check for retryable status codes
    if (error instanceof DispatchError) {
      return this.config.retry.retryableStatusCodes.includes(error.statusCode);
    }

    return false;
  }

  /**
   * Calculate retry delay using backoff strategy
   */
  private calculateRetryDelay(attempt: number): number {
    const { backoffStrategy, initialDelay, maxDelay, backoffMultiplier } = this.config.retry;

    let delay: number;

    switch (backoffStrategy) {
      case 'exponential':
        delay = initialDelay * backoffMultiplier ** (attempt - 1);
        break;
      case 'linear':
        delay = initialDelay * attempt;
        break;
      case 'fixed':
      default:
        delay = initialDelay;
        break;
    }

    return Math.min(delay, maxDelay);
  }

  /**
   * Get or create circuit breaker for service
   */
  private getOrCreateCircuitBreaker(serviceId: string): CircuitBreaker {
    if (!this.circuitBreakers.has(serviceId)) {
      this.circuitBreakers.set(
        serviceId,
        new CircuitBreaker(serviceId, this.config.circuitBreaker, this.logger)
      );
    }

    const circuitBreaker = this.circuitBreakers.get(serviceId);

    if (!circuitBreaker) {
      throw new Error(`Circuit breaker not found for service ${serviceId}`);
    }

    return circuitBreaker;
  }

  /**
   * Get service definition by ID
   */
  private getServiceDefinition(serviceId: string): ServiceDefinition | null {
    return this.serviceRegistry.getService(serviceId);
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Start circuit breaker monitoring
   */
  private startCircuitBreakerMonitoring(): void {
    setInterval(() => {
      for (const circuitBreaker of this.circuitBreakers.values()) {
        circuitBreaker.updateState();
      }
    }, this.config.circuitBreaker.monitoringPeriod);
  }

  /**
   * Start session cleanup
   */
  private startSessionCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      const expiredSessions: string[] = [];

      for (const [sessionId, session] of this.sessions.entries()) {
        const age = now - session.lastUsed.getTime();

        if (age > this.config.loadBalancer.sessionTtl) {
          expiredSessions.push(sessionId);
        }
      }

      for (const sessionId of expiredSessions) {
        this.sessions.delete(sessionId);
      }

      if (expiredSessions.length > 0) {
        this.logger.debug(`Cleaned up ${expiredSessions.length} expired sessions`);
      }
    }, this.config.loadBalancer.sessionTtl / 4);
  }

  /**
   * Record dispatch metric
   */
  private recordMetric(type: string): void {
    switch (type) {
      case 'success':
        this.metrics.successfulDispatches++;
        break;
      case 'failure':
        this.metrics.failedDispatches++;
        break;
      case 'noServiceAvailable':
        this.metrics.noServiceAvailable++;
        break;
    }
  }

  /**
   * Update average response time
   */
  private updateAverageResponseTime(responseTime: number): number {
    const totalRequests = this.metrics.totalRequests + 1;
    const currentAverage = this.metrics.averageResponseTime || 0;

    return (currentAverage * (totalRequests - 1) + responseTime) / totalRequests;
  }

  /**
   * Create initial metrics object
   */
  private createMetrics(): DispatchMetrics {
    return {
      totalRequests: 0,
      successfulDispatches: 0,
      failedDispatches: 0,
      noServiceAvailable: 0,
      averageResponseTime: 0,
      circuitBreakerTrips: 0,
    };
  }

  /**
   * Delay execution for specified milliseconds
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Load Balancer implementation
class LoadBalancer {
  private config: LoadBalancerConfig;
  private roundRobinIndex = 0;

  constructor(config: LoadBalancerConfig, _logger: Logger) {
    this.config = config;
  }

  selectEndpoint(endpoints: ServiceEndpoint[]): ServiceEndpoint {
    if (endpoints.length === 0) {
      throw new Error('No endpoints available');
    }

    if (endpoints.length === 1) {
      const endpoint = endpoints[0];

      if (!endpoint) {
        throw new Error('No endpoint available');
      }

      return endpoint;
    }

    switch (this.config.strategy) {
      case 'round_robin':
        return this.roundRobinSelect(endpoints);
      case 'random':
        return this.randomSelect(endpoints);
      case 'weighted':
        return this.weightedSelect(endpoints);
      case 'least_connections':
        return this.leastConnectionsSelect(endpoints);
      default:
        return this.roundRobinSelect(endpoints);
    }
  }

  private roundRobinSelect(endpoints: ServiceEndpoint[]): ServiceEndpoint {
    const endpoint = endpoints[this.roundRobinIndex % endpoints.length];

    if (!endpoint) {
      throw new Error('No endpoint available for round robin selection');
    }

    this.roundRobinIndex = (this.roundRobinIndex + 1) % endpoints.length;

    return endpoint;
  }

  private randomSelect(endpoints: ServiceEndpoint[]): ServiceEndpoint {
    const index = Math.floor(Math.random() * endpoints.length);
    const endpoint = endpoints[index];

    if (!endpoint) {
      throw new Error('No endpoint available for random selection');
    }

    return endpoint;
  }

  private weightedSelect(endpoints: ServiceEndpoint[]): ServiceEndpoint {
    const totalWeight = endpoints.reduce((sum, endpoint) => sum + endpoint.weight, 0);
    let random = Math.random() * totalWeight;

    for (const endpoint of endpoints) {
      random -= endpoint.weight;

      if (random <= 0) {
        return endpoint;
      }
    }

    const fallbackEndpoint = endpoints[endpoints.length - 1];

    if (!fallbackEndpoint) {
      throw new Error('No endpoint available for weighted selection');
    }

    return fallbackEndpoint;
  }

  private leastConnectionsSelect(endpoints: ServiceEndpoint[]): ServiceEndpoint {
    return endpoints.reduce((least, current) =>
      current.connections < least.connections ? current : least
    );
  }
}

// Circuit Breaker implementation
class CircuitBreaker {
  private serviceId: string;
  private config: CircuitBreakerConfig;
  private logger: Logger;
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private lastFailure?: Date;
  private nextAttempt?: Date;
  private totalRequests = 0;

  constructor(serviceId: string, config: CircuitBreakerConfig, logger: Logger) {
    this.serviceId = serviceId;
    this.config = config;
    this.logger = logger;
  }

  canExecute(): boolean {
    if (this.state === 'closed') {
      return true;
    }

    if (this.state === 'open') {
      if (this.nextAttempt && Date.now() >= this.nextAttempt.getTime()) {
        this.state = 'half_open';
        this.logger.debug('Circuit breaker transitioning to half-open', {
          serviceId: this.serviceId,
        });

        return true;
      }

      return false;
    }

    if (this.state === 'half_open') {
      return true;
    }

    return false;
  }

  recordSuccess(): void {
    this.successes++;
    this.totalRequests++;

    if (this.state === 'half_open') {
      this.state = 'closed';
      this.failures = 0;
      delete this.nextAttempt;

      this.logger.info('Circuit breaker closed after successful request', {
        serviceId: this.serviceId,
      });
    }
  }

  recordFailure(): void {
    this.failures++;
    this.totalRequests++;
    this.lastFailure = new Date();

    if (this.state === 'closed' || this.state === 'half_open') {
      if (
        this.failures >= this.config.failureThreshold &&
        this.totalRequests >= this.config.minimumThroughput
      ) {
        this.state = 'open';
        this.nextAttempt = new Date(Date.now() + this.config.recoveryTimeout);

        this.logger.warn('Circuit breaker opened due to failures', {
          serviceId: this.serviceId,
          failures: this.failures,
          threshold: this.config.failureThreshold,
        });
      }
    }
  }

  setState(state: CircuitState): void {
    this.state = state;

    if (state === 'open') {
      this.nextAttempt = new Date(Date.now() + this.config.recoveryTimeout);
    }
  }

  updateState(): void {
    // This method can be called periodically to update circuit breaker state
    // based on additional logic like time-based recovery
  }

  getStats(): CircuitBreakerStats {
    return {
      serviceId: this.serviceId,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      totalRequests: this.totalRequests,
      ...(this.lastFailure !== undefined && { lastFailure: this.lastFailure }),
      ...(this.nextAttempt !== undefined && { nextAttempt: this.nextAttempt }),
    };
  }
}

// Supporting interfaces and types
interface ServiceSession {
  serviceId: string;
  createdAt: Date;
  lastUsed: Date;
}

interface DispatchMetrics {
  totalRequests: number;
  successfulDispatches: number;
  failedDispatches: number;
  noServiceAvailable: number;
  averageResponseTime: number;
  circuitBreakerTrips: number;
}

// Custom error class
export class DispatchError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
    public readonly metadata?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'DispatchError';
  }
}
