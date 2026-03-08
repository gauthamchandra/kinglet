/**
 * Service Registry Tests
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../../test-utils/mock-logger.ts';
import {
  type RegistryConfig,
  type ServiceDefinition,
  ServiceRegistry,
} from './service-registry.ts';

// Mock logger
const mockLogger = createMockLogger();

// Sample service definitions
const createTestService = (overrides: Partial<ServiceDefinition> = {}): ServiceDefinition => ({
  id: 'test-service-1',
  name: 'pubsub',
  version: 'v1',
  description: 'Test Pub/Sub service',
  endpoint: {
    host: 'localhost',
    port: 8080,
    basePath: '/pubsub/v1',
    ssl: false,
  },
  protocols: [
    { name: 'http', version: '1.1', port: 8080 },
    { name: 'grpc', version: '1.0', port: 8081 },
  ],
  schemas: [
    {
      name: 'Topic',
      type: 'object',
      description: 'A Pub/Sub topic',
      properties: [
        { name: 'name', type: 'string', description: 'Topic name' },
        { name: 'labels', type: 'object', description: 'Topic labels' },
      ],
      required: ['name'],
    },
  ],
  methods: [
    {
      name: 'createTopic',
      httpMethod: 'PUT',
      path: '/v1/{name=projects/*/topics/*}',
      description: 'Create a topic',
      parameters: [
        {
          name: 'name',
          type: 'string',
          location: 'path',
          required: true,
          description: 'Topic name',
        },
      ],
      requestSchema: 'Topic',
      responseSchema: 'Topic',
      scopes: ['https://www.googleapis.com/auth/pubsub'],
    },
  ],
  healthCheckPath: '/health',
  tags: ['messaging', 'gcp'],
  metadata: { region: 'us-central1' },
  ...overrides,
});

const createSecondTestService = (): ServiceDefinition =>
  createTestService({
    id: 'test-service-2',
    name: 'scheduler',
    version: 'v1',
    description: 'Test Cloud Scheduler service',
    endpoint: { host: 'localhost', port: 8082, basePath: '/scheduler/v1', ssl: false },
    protocols: [{ name: 'http', version: '1.1', port: 8082 }],
    tags: ['scheduling', 'gcp'],
  });

// Mock fetch for health checks
const mockFetch = mock(() => Promise.resolve(new Response())) as ReturnType<typeof mock> &
  typeof fetch;
const originalFetch = global.fetch;

global.fetch = mockFetch;

describe('ServiceRegistry', () => {
  let registry: ServiceRegistry;
  let testConfig: Partial<RegistryConfig>;

  beforeEach(() => {
    (mockLogger.debug as ReturnType<typeof mock>).mockReset();
    (mockLogger.info as ReturnType<typeof mock>).mockReset();
    (mockLogger.warn as ReturnType<typeof mock>).mockReset();
    (mockLogger.error as ReturnType<typeof mock>).mockReset();
    mockFetch.mockReset();

    // Use fast intervals for testing
    testConfig = {
      healthCheckInterval: 100,
      healthCheckTimeout: 50,
      maxConsecutiveFailures: 2,
      enableAutoDeregistration: false, // Disable for most tests
      autoDeregistrationDelay: 50,
    };

    registry = new ServiceRegistry(mockLogger, testConfig);
  });

  afterEach(async () => {
    await registry.close();
  });

  afterAll(() => {
    // Restore original fetch after all ServiceRegistry tests are done
    global.fetch = originalFetch;
  });

  describe('Service Registration', () => {
    test('should register a valid service', async () => {
      const service = createTestService();

      await registry.registerService(service);

      const retrievedService = registry.getService(service.id);

      expect(retrievedService).toEqual(service);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Service registered'),
        expect.objectContaining({
          serviceId: service.id,
          endpoint: service.endpoint,
        })
      );
    });

    test('should reject registration of duplicate service ID', async () => {
      const service = createTestService();

      await registry.registerService(service);

      await expect(registry.registerService(service)).rejects.toThrow(
        "Service with ID 'test-service-1' already registered"
      );
    });

    test('should validate service definition on registration', async () => {
      const invalidService = {
        id: '',
        name: 'invalid',
        version: 'v1',
      } as ServiceDefinition;

      await expect(registry.registerService(invalidService)).rejects.toThrow(
        'Service must have id, name, and version'
      );
    });

    test('should require endpoint information', async () => {
      const service = createTestService();
      const { endpoint, ...serviceWithoutEndpoint } = service;

      void endpoint; // Explicitly void the extracted endpoint to indicate intentional non-use

      await expect(
        registry.registerService(serviceWithoutEndpoint as ServiceDefinition)
      ).rejects.toThrow('Service must have an endpoint');
    });

    test('should require at least one protocol', async () => {
      const service = createTestService({ protocols: [] });

      await expect(registry.registerService(service)).rejects.toThrow(
        'Service must support at least one protocol'
      );
    });

    test('should validate protocol types', async () => {
      const service = createTestService({
        protocols: [{ name: 'invalid' as 'http', version: '1.0', port: 8080 }],
      });

      await expect(registry.registerService(service)).rejects.toThrow(
        'Unsupported protocol: invalid'
      );
    });

    test('should emit registration event', async () => {
      const service = createTestService();
      const eventSpy = mock();

      registry.on('service:registered', eventSpy);

      await registry.registerService(service);

      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceId: service.id,
          serviceName: service.name,
          version: service.version,
        })
      );
    });
  });

  describe('Service Deregistration', () => {
    test('should deregister an existing service', async () => {
      const service = createTestService();

      await registry.registerService(service);

      const result = await registry.deregisterService(service.id);

      expect(result).toBe(true);
      expect(registry.getService(service.id)).toBeNull();
    });

    test('should return false for non-existent service', async () => {
      const result = await registry.deregisterService('non-existent');

      expect(result).toBe(false);
    });

    test('should emit deregistration event', async () => {
      const service = createTestService();
      const eventSpy = mock();

      await registry.registerService(service);
      registry.on('service:deregistered', eventSpy);

      await registry.deregisterService(service.id);

      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceId: service.id,
          serviceName: service.name,
          version: service.version,
        })
      );
    });

    test('should clean up name index on deregistration', async () => {
      const service = createTestService();

      await registry.registerService(service);
      await registry.deregisterService(service.id);

      const servicesByName = registry.getServicesByName(service.name);

      expect(servicesByName).toHaveLength(0);
    });
  });

  describe('Service Discovery', () => {
    beforeEach(async () => {
      // Mock successful health checks
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '{"status": "healthy"}',
      } as Response);

      // Register test services
      await registry.registerService(createTestService());
      await registry.registerService(createSecondTestService());

      // Wait for initial health checks
      await new Promise(resolve => setTimeout(resolve, 150));
    });

    test('should discover all services with empty query', () => {
      const services = registry.discoverServices();

      expect(services).toHaveLength(2);
    });

    test('should filter services by name', () => {
      const services = registry.discoverServices({ name: 'pubsub' });

      expect(services).toHaveLength(1);
      expect(services[0]?.name).toBe('pubsub');
    });

    test('should filter services by version', () => {
      const services = registry.discoverServices({ version: 'v1' });

      expect(services).toHaveLength(2);
    });

    test('should filter services by tag', () => {
      const services = registry.discoverServices({ tag: 'messaging' });

      expect(services).toHaveLength(1);
      expect(services[0]).toBeDefined();
      expect(services[0]?.tags).toContain('messaging');
    });

    test('should filter services by protocol', () => {
      const services = registry.discoverServices({ protocol: 'grpc' });

      expect(services).toHaveLength(1);
      expect(services[0]?.protocols.some(p => p.name === 'grpc')).toBe(true);
    });

    test('should filter healthy services only', () => {
      const services = registry.discoverServices({ healthyOnly: true });

      expect(services).toHaveLength(2); // Both should be healthy after mocked success
    });

    test('should get services by name', () => {
      const services = registry.getServicesByName('pubsub');

      expect(services).toHaveLength(1);
      expect(services[0]?.name).toBe('pubsub');
    });

    test('should return empty array for unknown service name', () => {
      const services = registry.getServicesByName('unknown');

      expect(services).toHaveLength(0);
    });

    test('should get service version information', () => {
      const versionInfo = registry.getServiceVersions('pubsub');

      expect(versionInfo).toEqual({
        serviceName: 'pubsub',
        versions: expect.arrayContaining([
          expect.objectContaining({
            version: 'v1',
            serviceId: 'test-service-1',
          }),
        ]),
        defaultVersion: 'v1',
      });
    });
  });

  describe('Health Checking', () => {
    test('should perform initial health check on registration', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '{"status": "healthy"}',
      } as Response);

      const service = createTestService();

      await registry.registerService(service);

      // Wait for health check to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      const health = registry.getServiceHealth(service.id);

      expect(health?.status).toBe('healthy');
      expect(health?.lastHealthy).toBeInstanceOf(Date);
      expect(health?.consecutiveFailures).toBe(0);
    });

    test('should handle unhealthy service response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      const service = createTestService();

      await registry.registerService(service);

      // Wait for health check to complete
      await new Promise(resolve => setTimeout(resolve, 150));

      const health = registry.getServiceHealth(service.id);

      expect(health?.status).toBe('unhealthy');
      expect(health?.consecutiveFailures).toBeGreaterThanOrEqual(1);
    });

    test('should handle degraded service response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
      } as Response);

      const service = createTestService();

      await registry.registerService(service);

      // Wait for health check to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      const health = registry.getServiceHealth(service.id);

      expect(health?.status).toBe('degraded');
    });

    test('should handle health check timeout', async () => {
      mockFetch.mockRejectedValue(new Error('TimeoutError'));

      const service = createTestService();

      await registry.registerService(service);

      // Wait for health check to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      const health = registry.getServiceHealth(service.id);

      expect(health?.status).toBe('unhealthy');
    });

    test('should emit health changed event', async () => {
      const service = createTestService();
      const eventSpy = mock();

      // First make it healthy
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '{}',
      } as Response);

      await registry.registerService(service);
      registry.on('health:changed', eventSpy);

      // Wait for initial health check
      await new Promise(resolve => setTimeout(resolve, 120));

      // Now make it unhealthy
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      // Wait for next health check
      await new Promise(resolve => setTimeout(resolve, 120));

      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceId: service.id,
          oldStatus: 'healthy',
          newStatus: 'unhealthy',
        })
      );
    });

    test('should track consecutive failures', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      const service = createTestService();

      await registry.registerService(service);

      // Wait for multiple health check cycles
      await new Promise(resolve => setTimeout(resolve, 250));

      const health = registry.getServiceHealth(service.id);

      expect(health?.consecutiveFailures).toBeGreaterThan(1);
    });

    test('should reset consecutive failures on recovery', async () => {
      const service = createTestService();

      await registry.registerService(service);

      // First make it unhealthy
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      // Wait for health check
      await new Promise(resolve => setTimeout(resolve, 150));

      let health = registry.getServiceHealth(service.id);

      expect(health?.consecutiveFailures).toBeGreaterThanOrEqual(1);

      // Now make it healthy again
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '{}',
      } as Response);

      // Wait for next health check
      await new Promise(resolve => setTimeout(resolve, 150));

      health = registry.getServiceHealth(service.id);

      expect(health?.consecutiveFailures).toBe(0);
    });
  });

  describe('Auto Deregistration', () => {
    test('should auto-deregister service after max consecutive failures', async () => {
      // Create registry with auto-deregistration enabled
      const registryWithAuto = new ServiceRegistry(mockLogger, {
        ...testConfig,
        enableAutoDeregistration: true,
        maxConsecutiveFailures: 2,
        autoDeregistrationDelay: 50,
      });

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      const service = createTestService();

      await registryWithAuto.registerService(service);

      // Wait for enough health check cycles to trigger auto-deregistration
      await new Promise(resolve => setTimeout(resolve, 350));

      const retrievedService = registryWithAuto.getService(service.id);

      expect(retrievedService).toBeNull();

      await registryWithAuto.close();
    });

    test('should not auto-deregister when disabled', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      const service = createTestService();

      await registry.registerService(service);

      // Wait for multiple health check cycles
      await new Promise(resolve => setTimeout(resolve, 300));

      const retrievedService = registry.getService(service.id);

      expect(retrievedService).not.toBeNull();
    });
  });

  describe('Event System', () => {
    test('should support multiple event listeners', async () => {
      const listener1 = mock();
      const listener2 = mock();

      registry.on('service:registered', listener1);
      registry.on('service:registered', listener2);

      // Trigger event by registering service
      await registry.registerService(createTestService());

      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    test('should remove event listeners', async () => {
      const listener = mock();

      registry.on('service:registered', listener);
      registry.off('service:registered', listener);

      await registry.registerService(createTestService());

      expect(listener).not.toHaveBeenCalled();
    });

    test('should handle async event listeners', async () => {
      const asyncListener = mock().mockResolvedValue(undefined);

      registry.on('service:registered', asyncListener);

      await registry.registerService(createTestService());

      expect(asyncListener).toHaveBeenCalled();
    });

    test('should log event listener errors', async () => {
      const faultyListener = mock().mockImplementation(() => {
        throw new Error('Listener error');
      });

      registry.on('service:registered', faultyListener);

      await registry.registerService(createTestService());

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Registry event listener error',
        expect.objectContaining({
          event: 'service:registered',
          error: 'Listener error',
        })
      );
    });
  });

  describe('Registry Statistics', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '{}',
      } as Response);

      await registry.registerService(createTestService());
      await registry.registerService(createSecondTestService());

      // Wait for health checks
      await new Promise(resolve => setTimeout(resolve, 150));
    });

    test('should provide registry statistics', () => {
      const stats = registry.getStats();

      expect(stats).toEqual({
        totalServices: 2,
        healthyServices: 2,
        unhealthyServices: 0,
        degradedServices: 0,
        unknownServices: 0,
        uniqueServiceNames: 2,
        lastHealthCheck: expect.any(Date),
      });
    });

    test('should get all service health statuses', () => {
      const allHealth = registry.getAllServiceHealth();

      expect(allHealth).toHaveLength(2);
      expect(allHealth.every(h => h.status === 'healthy')).toBe(true);
    });
  });

  describe('Configuration', () => {
    test('should use default configuration when not provided', () => {
      const defaultRegistry = new ServiceRegistry(mockLogger);

      expect(defaultRegistry).toBeInstanceOf(ServiceRegistry);
    });

    test('should merge provided configuration with defaults', () => {
      const customConfig = { healthCheckInterval: 60000 };
      const customRegistry = new ServiceRegistry(mockLogger, customConfig);

      expect(customRegistry).toBeInstanceOf(ServiceRegistry);
    });

    test('should disable health checking when interval is 0', () => {
      const noHealthCheckRegistry = new ServiceRegistry(mockLogger, {
        healthCheckInterval: 0,
      });

      expect(noHealthCheckRegistry).toBeInstanceOf(ServiceRegistry);
    });
  });

  describe('Resource Cleanup', () => {
    test('should close registry and clear intervals', async () => {
      const registryToClose = new ServiceRegistry(mockLogger, testConfig);

      await registryToClose.close();

      expect(mockLogger.info).toHaveBeenCalledWith('Service Registry closed');
    });
  });
});
