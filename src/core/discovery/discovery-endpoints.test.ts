/**
 * Discovery Endpoints Tests
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Logger } from '@/shared/utils/logger.ts';
import { DiscoveryDocumentGenerator, type ServiceInfo } from './discovery-document-generator.ts';
import {
  DiscoveryEndpoints,
  type DiscoveryQuery,
  DiscoveryQuerySchema,
  type ServiceListQuery,
  ServiceListQuerySchema,
} from './discovery-endpoints.ts';
import { ServiceRegistry } from './service-registry.ts';

// Mock logger
const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

// Mock fetch for health checks
let mockFetchResponse: Partial<Response> = {
  ok: true,
  status: 200,
  text: async () => '{"status": "healthy"}',
};

const originalFetch = global.fetch;

global.fetch = Object.assign(async () => mockFetchResponse as Response, {
  preconnect: () => {},
}) as typeof fetch;

// Test data
const createTestServiceInfo = (): ServiceInfo => ({
  name: 'pubsub',
  version: 'v1',
  title: 'Cloud Pub/Sub API',
  description: 'Provides reliable, many-to-many messaging',
  baseUrl: 'http://localhost:8765',
  servicePath: 'pubsub/v1/',
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
  resources: [],
});

const createTestServiceDefinition = () => ({
  id: 'pubsub-v1',
  name: 'pubsub',
  version: 'v1',
  description: 'Cloud Pub/Sub API',
  endpoint: {
    host: 'localhost',
    port: 8765,
    basePath: '/pubsub/v1',
    ssl: false,
  },
  protocols: [{ name: 'http' as const, version: '1.1', port: 8765 }],
  schemas: [],
  methods: [],
  healthCheckPath: '/health',
});

describe('DiscoveryEndpoints', () => {
  let endpoints: DiscoveryEndpoints;
  let serviceRegistry: ServiceRegistry;
  let documentGenerator: DiscoveryDocumentGenerator;

  beforeEach(async () => {
    // Reset mock fetch to default successful response
    mockFetchResponse = {
      ok: true,
      status: 200,
      text: async () => '{"status": "healthy"}',
    };

    // Create dependencies
    serviceRegistry = new ServiceRegistry(mockLogger, {
      healthCheckInterval: 0, // Disable health checking for tests
    });

    documentGenerator = new DiscoveryDocumentGenerator(mockLogger);

    // Register test service in document generator
    const serviceInfo = createTestServiceInfo();

    documentGenerator.registerService(serviceInfo);

    // Register test service in service registry
    const serviceDefinition = createTestServiceDefinition();

    await serviceRegistry.registerService(serviceDefinition);

    endpoints = new DiscoveryEndpoints(mockLogger, serviceRegistry, documentGenerator, {
      enableCaching: false, // Disable caching for most tests
    });
  });

  afterEach(async () => {
    await serviceRegistry.close();
    // Restore original fetch
    global.fetch = originalFetch;
  });

  describe('Schema Validation', () => {
    test('should validate discovery query parameters', () => {
      const validQuery = {
        version: 'v1',
        fields: 'name,version',
        prettyPrint: true,
        alt: 'json' as const,
      };

      const result = DiscoveryQuerySchema.parse(validQuery);

      expect(result).toEqual({
        version: 'v1',
        fields: 'name,version',
        prettyPrint: true,
        alt: 'json',
      });
    });

    test('should validate service list query parameters', () => {
      const validQuery = {
        preferred: true,
        name: 'pubsub',
        version: 'v1',
      };

      const result = ServiceListQuerySchema.parse(validQuery);

      expect(result).toEqual({
        preferred: true,
        name: 'pubsub',
        version: 'v1',
      });
    });

    test('should reject invalid alt parameter', () => {
      const invalidQuery = {
        alt: 'invalid',
      };

      expect(() => DiscoveryQuerySchema.parse(invalidQuery)).toThrow();
    });

    test('should handle string boolean values', () => {
      const query = {
        prettyPrint: 'true',
      };

      const result = DiscoveryQuerySchema.parse(query);

      expect(result.prettyPrint).toBe('true');
    });
  });

  describe('Discovery REST Endpoint', () => {
    test('should handle valid discovery request', async () => {
      const query: DiscoveryQuery = {
        version: 'v1',
        alt: 'json',
      };

      const response = await endpoints.handleDiscoveryRest('pubsub', query);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');

      const data = await response.json();

      expect(data).toHaveProperty('kind', 'discovery#restDescription');
      expect(data).toHaveProperty('name', 'pubsub');
      expect(data).toHaveProperty('version', 'v1');
    });

    test('should handle service not found', async () => {
      const query: DiscoveryQuery = { version: 'v1', alt: 'json' };

      const response = await endpoints.handleDiscoveryRest('nonexistent', query);

      expect(response.status).toBe(404);

      const data = await response.json();

      expect(data.error.code).toBe(404);
      expect(data.error.status).toBe('NOT_FOUND');
    });

    test('should handle invalid version', async () => {
      const query: DiscoveryQuery = { version: 'v999', alt: 'json' };

      const response = await endpoints.handleDiscoveryRest('pubsub', query);

      expect(response.status).toBe(400);

      const data = await response.json();

      expect(data.error.code).toBe(400);
      expect(data.error.status).toBe('INVALID_VERSION');
    });

    test('should apply field selection', async () => {
      const query: DiscoveryQuery = {
        version: 'v1',
        fields: 'name,version,title',
        alt: 'json',
      };

      const response = await endpoints.handleDiscoveryRest('pubsub', query);

      expect(response.status).toBe(200);

      const data = await response.json();

      // Should only contain selected fields
      expect(data).toHaveProperty('name');
      expect(data).toHaveProperty('version');
      expect(data).toHaveProperty('title');
      expect(Object.keys(data)).toHaveLength(3);
    });

    test('should handle JSONP callback', async () => {
      const query: DiscoveryQuery = {
        version: 'v1',
        callback: 'myCallback',
        alt: 'json',
      };

      const response = await endpoints.handleDiscoveryRest('pubsub', query);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/javascript');

      const responseText = await response.text();

      expect(responseText).toMatch(/^myCallback\(/);
      expect(responseText).toMatch(/\);$/);
    });

    test('should handle protobuf alt format', async () => {
      const query: DiscoveryQuery = {
        version: 'v1',
        alt: 'proto',
      };

      const response = await endpoints.handleDiscoveryRest('pubsub', query);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/x-protobuf');
    });

    test('should validate query parameters', async () => {
      const invalidQuery = {
        alt: 'invalid' as 'json' | 'media' | 'proto',
      };

      const response = await endpoints.handleDiscoveryRest('pubsub', invalidQuery);

      expect(response.status).toBe(400);

      const data = await response.json();

      expect(data.error.status).toBe('INVALID_PARAMETER');
      expect(data.error.details[0].metadata).toHaveProperty('validationErrors');
    });
  });

  describe('API Directory Endpoint', () => {
    beforeEach(async () => {
      // Wait for health check (service already registered in main beforeEach)
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    test('should return API directory', async () => {
      const query: ServiceListQuery = { preferred: true };

      const response = await endpoints.handleApiDirectory(query);

      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data).toHaveProperty('kind', 'discovery#directoryList');
      expect(data).toHaveProperty('items');
      expect(data.items).toBeInstanceOf(Array);
      expect(data.items.length).toBeGreaterThan(0);
    });

    test('should filter by service name', async () => {
      const query: ServiceListQuery = {
        name: 'pubsub',
        preferred: true,
      };

      const response = await endpoints.handleApiDirectory(query);

      expect(response.status).toBe(200);

      const data = await response.json();
      const pubsubItems = data.items.filter(
        (item: { name: string; version: string; preferred: boolean }) => item.name === 'pubsub'
      );

      expect(pubsubItems.length).toBe(data.items.length);
    });

    test('should filter by version', async () => {
      const query: ServiceListQuery = {
        version: 'v1',
        preferred: true,
      };

      const response = await endpoints.handleApiDirectory(query);

      expect(response.status).toBe(200);

      const data = await response.json();
      const v1Items = data.items.filter(
        (item: { name: string; version: string; preferred: boolean }) => item.version === 'v1'
      );

      expect(v1Items.length).toBe(data.items.length);
    });

    test('should filter by preferred status', async () => {
      const query: ServiceListQuery = {
        preferred: true,
      };

      const response = await endpoints.handleApiDirectory(query);

      expect(response.status).toBe(200);

      const data = await response.json();
      const preferredItems = data.items.filter(
        (item: { name: string; version: string; preferred: boolean }) => item.preferred
      );

      expect(preferredItems.length).toBe(data.items.length);
    });

    test('should handle empty results', async () => {
      const query: ServiceListQuery = {
        name: 'nonexistent',
        preferred: true,
      };

      const response = await endpoints.handleApiDirectory(query);

      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data.items).toHaveLength(0);
    });
  });

  describe('Service Discovery Endpoints', () => {
    test('should get service methods', async () => {
      const response = await endpoints.handleServiceDiscovery('pubsub', 'v1', 'methods');

      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data).toHaveProperty('serviceName', 'pubsub');
      expect(data).toHaveProperty('version', 'v1');
      expect(data).toHaveProperty('methods');
    });

    test('should get service schemas', async () => {
      const response = await endpoints.handleServiceDiscovery('pubsub', 'v1', 'schemas');

      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data).toHaveProperty('serviceName', 'pubsub');
      expect(data).toHaveProperty('schemas');
    });

    test('should get service resources', async () => {
      const response = await endpoints.handleServiceDiscovery('pubsub', 'v1', 'resources');

      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data).toHaveProperty('serviceName', 'pubsub');
      expect(data).toHaveProperty('resources');
    });

    test('should get service health', async () => {
      const response = await endpoints.handleServiceDiscovery('pubsub', 'v1', 'health');

      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data).toHaveProperty('serviceId');
      expect(data).toHaveProperty('status');
    });

    test('should handle unknown endpoint', async () => {
      const response = await endpoints.handleServiceDiscovery('pubsub', 'v1', 'unknown');

      expect(response.status).toBe(404);

      const data = await response.json();

      expect(data.error.status).toBe('NOT_FOUND');
    });

    test('should handle service not found', async () => {
      const response = await endpoints.handleServiceDiscovery('nonexistent', 'v1', 'methods');

      expect(response.status).toBe(404);

      const data = await response.json();

      expect(data.error.status).toBe('NOT_FOUND');
    });
  });

  describe('Version Negotiation', () => {
    test('should get available versions for service', () => {
      const versions = endpoints.getAvailableVersions('pubsub');

      expect(versions).toHaveProperty('pubsub');
      expect(versions.pubsub).toContain('v1');
    });

    test('should get all available versions', () => {
      const versions = endpoints.getAvailableVersions();

      expect(typeof versions).toBe('object');
    });
  });

  describe('Request Validation', () => {
    test('should validate valid request', () => {
      const result = endpoints.validateDiscoveryRequest('pubsub', {
        version: 'v1',
        fields: 'name,version',
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    test('should reject invalid service name', () => {
      const result = endpoints.validateDiscoveryRequest('', {});

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Service name is required and must be a string');
    });

    test('should validate version parameter', () => {
      const result = endpoints.validateDiscoveryRequest('pubsub', {
        version: 123,
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Version must be a string');
    });

    test('should validate alt parameter', () => {
      const result = endpoints.validateDiscoveryRequest('pubsub', {
        alt: 'invalid',
      } as { alt: string });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Alt parameter must be one of: json, media, proto');
    });

    test('should validate boolean parameters', () => {
      const result = endpoints.validateDiscoveryRequest('pubsub', {
        prettyPrint: 'invalid',
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "prettyPrint parameter must be a boolean or 'true'/'false' string"
      );
    });
  });

  describe('Caching', () => {
    let cachedEndpoints: DiscoveryEndpoints;

    beforeEach(() => {
      cachedEndpoints = new DiscoveryEndpoints(mockLogger, serviceRegistry, documentGenerator, {
        enableCaching: true,
        cacheTimeout: 1000,
      });
    });

    test('should cache discovery responses', async () => {
      const query: DiscoveryQuery = { version: 'v1', alt: 'json' };

      // First request
      const response1 = await cachedEndpoints.handleDiscoveryRest('pubsub', query);
      const data1 = await response1.json();

      // Second request should use cache
      const response2 = await cachedEndpoints.handleDiscoveryRest('pubsub', query);
      const data2 = await response2.json();

      expect(response2.headers.get('Cache-Control')).toContain('max-age');
      expect(data1).toEqual(data2);
    });

    test('should cache directory responses', async () => {
      const query: ServiceListQuery = { preferred: true };

      // First request
      await cachedEndpoints.handleApiDirectory(query);

      // Second request should use cache
      const response = await cachedEndpoints.handleApiDirectory(query);

      expect(response.headers.get('Cache-Control')).toContain('max-age');
    });

    test('should provide cache statistics', () => {
      const stats = cachedEndpoints.getCacheStats();

      expect(stats).toHaveProperty('totalEntries');
      expect(stats).toHaveProperty('validEntries');
      expect(stats).toHaveProperty('expiredEntries');
      expect(stats).toHaveProperty('hitRate');
    });

    test('should clear cache', async () => {
      const query: DiscoveryQuery = { version: 'v1', alt: 'json' };

      await cachedEndpoints.handleDiscoveryRest('pubsub', query);

      let stats = cachedEndpoints.getCacheStats();

      expect(stats.totalEntries).toBeGreaterThan(0);

      cachedEndpoints.clearCache();

      stats = cachedEndpoints.getCacheStats();

      expect(stats.totalEntries).toBe(0);
    });
  });

  describe('Error Handling', () => {
    test('should handle internal errors gracefully', async () => {
      // Create endpoints with invalid configuration that will cause internal error
      const originalGetAvailableVersions = endpoints.getAvailableVersions.bind(endpoints);

      // Mock the getAvailableVersions to throw after the service check
      endpoints.getAvailableVersions = () => {
        throw new Error('Internal error in version handling');
      };

      try {
        const response = await endpoints.handleDiscoveryRest('pubsub', {
          version: 'v1',
          alt: 'json',
        });

        expect(response.status).toBe(500);

        const data = await response.json();

        expect(data.error.status).toBe('INTERNAL_ERROR');
      } finally {
        // Restore the original method
        endpoints.getAvailableVersions = originalGetAvailableVersions;
      }
    });

    test('should include CORS headers in error responses', async () => {
      const response = await endpoints.handleDiscoveryRest('nonexistent', {
        version: 'v1',
        alt: 'json',
      });

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    });
  });

  describe('Configuration', () => {
    test('should use default configuration', () => {
      const defaultEndpoints = new DiscoveryEndpoints(
        mockLogger,
        serviceRegistry,
        documentGenerator
      );

      expect(defaultEndpoints).toBeInstanceOf(DiscoveryEndpoints);
    });

    test('should merge custom configuration', () => {
      const customConfig = {
        enableCaching: false,
        maxFieldSelectionDepth: 5,
      };

      const customEndpoints = new DiscoveryEndpoints(
        mockLogger,
        serviceRegistry,
        documentGenerator,
        customConfig
      );

      expect(customEndpoints).toBeInstanceOf(DiscoveryEndpoints);
    });
  });

  describe('Response Formatting', () => {
    test('should format JSON response with pretty print', async () => {
      const response = await endpoints.handleDiscoveryRest('pubsub', {
        version: 'v1',
        prettyPrint: true,
        alt: 'json',
      });

      const responseText = await response.text();

      // Check if response is pretty-printed (contains newlines and spaces)
      expect(responseText).toContain('\n');
      expect(responseText).toContain('  ');
    });

    test('should set appropriate headers', async () => {
      const response = await endpoints.handleDiscoveryRest('pubsub', {
        version: 'v1',
        alt: 'json',
      });

      expect(response.headers.get('Content-Type')).toBe('application/json');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    test('should handle different alt formats', async () => {
      const formats = [
        { alt: 'json' as const, contentType: 'application/json' },
        { alt: 'proto' as const, contentType: 'application/x-protobuf' },
        { alt: 'media' as const, contentType: 'application/octet-stream' },
      ];

      for (const { alt, contentType } of formats) {
        const response = await endpoints.handleDiscoveryRest('pubsub', {
          version: 'v1',
          alt,
        });

        expect(response.headers.get('Content-Type')).toBe(contentType);
      }
    });
  });
});
