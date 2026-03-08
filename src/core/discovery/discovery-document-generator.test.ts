/**
 * Unit tests for Discovery Document Generator
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { Logger } from '@/shared/utils/logger.ts';
import { DiscoveryDocumentGenerator, type ServiceInfo } from './discovery-document-generator.ts';

describe('DiscoveryDocumentGenerator', () => {
  let generator: DiscoveryDocumentGenerator;
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger('DiscoveryGeneratorTest', 'error');
    generator = new DiscoveryDocumentGenerator(logger);
  });

  describe('Service Registration', () => {
    test('should register a service', () => {
      const serviceInfo: ServiceInfo = {
        name: 'pubsub',
        version: 'v1',
        title: 'Cloud Pub/Sub API',
        description:
          'Provides reliable, many-to-many, asynchronous messaging between applications.',
        baseUrl: 'https://pubsub.googleapis.com/',
        servicePath: 'v1/',
        methods: [],
        schemas: [],
        resources: [],
      };

      generator.registerService(serviceInfo);

      const serviceList = generator.getServiceList();

      expect(serviceList).toHaveLength(1);
      expect(serviceList[0]).toEqual({
        name: 'pubsub',
        version: 'v1',
        title: 'Cloud Pub/Sub API',
        description:
          'Provides reliable, many-to-many, asynchronous messaging between applications.',
      });
    });

    test('should handle multiple service versions', () => {
      const serviceV1: ServiceInfo = {
        name: 'pubsub',
        version: 'v1',
        title: 'Cloud Pub/Sub API',
        description:
          'Provides reliable, many-to-many, asynchronous messaging between applications.',
        baseUrl: 'https://pubsub.googleapis.com/',
        servicePath: 'v1/',
        methods: [],
        schemas: [],
        resources: [],
      };

      const serviceV2: ServiceInfo = {
        name: 'pubsub',
        version: 'v2',
        title: 'Cloud Pub/Sub API',
        description:
          'Provides reliable, many-to-many, asynchronous messaging between applications.',
        baseUrl: 'https://pubsub.googleapis.com/',
        servicePath: 'v2/',
        methods: [],
        schemas: [],
        resources: [],
      };

      generator.registerService(serviceV1);
      generator.registerService(serviceV2);

      const serviceList = generator.getServiceList();

      expect(serviceList).toHaveLength(2);
      expect(serviceList.find(s => s.version === 'v1')).toBeDefined();
      expect(serviceList.find(s => s.version === 'v2')).toBeDefined();
    });
  });

  describe('Discovery Document Generation', () => {
    let testService: ServiceInfo;

    beforeEach(() => {
      testService = {
        name: 'pubsub',
        version: 'v1',
        title: 'Cloud Pub/Sub API',
        description:
          'Provides reliable, many-to-many, asynchronous messaging between applications.',
        baseUrl: 'https://pubsub.googleapis.com/',
        servicePath: 'v1/',
        methods: [
          {
            name: 'projects.topics.create',
            httpMethod: 'PUT',
            path: 'v1/{+name}',
            description: 'Creates the given topic with the given name.',
            parameters: [
              {
                name: 'name',
                type: 'string',
                location: 'path',
                required: true,
                description: 'Required. The name of the topic.',
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
            description: 'A topic resource.',
            properties: [
              {
                name: 'name',
                type: 'string',
                description: 'Required. The name of the topic.',
              },
              {
                name: 'labels',
                type: 'object',
                description: 'User labels.',
              },
            ],
            required: ['name'],
          },
        ],
        resources: [],
      };

      generator.registerService(testService);
    });

    test('should generate basic discovery document structure', () => {
      const document = generator.generateDiscoveryDocument('pubsub', 'v1');

      expect(document.kind).toBe('discovery#restDescription');
      expect(document.discoveryVersion).toBe('v1');
      expect(document.id).toBe('pubsub:v1');
      expect(document.name).toBe('pubsub');
      expect(document.version).toBe('v1');
      expect(document.title).toBe('Cloud Pub/Sub API');
      expect(document.description).toBe(
        'Provides reliable, many-to-many, asynchronous messaging between applications.'
      );
      expect(document.protocol).toBe('rest');
      expect(document.baseUrl).toBe('https://pubsub.googleapis.com/');
      expect(document.basePath).toBe('/pubsub/v1/');
      expect(document.servicePath).toBe('v1/');
    });

    test('should generate global parameters', () => {
      const document = generator.generateDiscoveryDocument('pubsub', 'v1');

      expect(document.parameters).toBeDefined();
      expect(document.parameters.access_token).toBeDefined();
      expect(document.parameters.alt).toBeDefined();
      expect(document.parameters.key).toBeDefined();
      expect(document.parameters.prettyPrint).toBeDefined();

      expect(document.parameters.alt?.default).toBe('json');
      expect(document.parameters.alt?.enum).toEqual(['json', 'media', 'proto']);
      expect(document.parameters.prettyPrint?.default).toBe(true);
    });

    test('should generate schemas', () => {
      const document = generator.generateDiscoveryDocument('pubsub', 'v1');

      expect(document.schemas).toBeDefined();
      expect(document.schemas.Topic).toBeDefined();

      const topicSchema = document.schemas.Topic;

      expect(topicSchema).toBeDefined();

      expect(topicSchema?.id).toBe('Topic');
      expect(topicSchema?.type).toBe('object');
      expect(topicSchema?.description).toBe('A topic resource.');
      expect(topicSchema?.required).toEqual(['name']);
      expect(topicSchema?.properties).toBeDefined();
      expect(topicSchema?.properties?.name).toBeDefined();
      expect(topicSchema?.properties?.labels).toBeDefined();
    });

    test('should generate methods', () => {
      const document = generator.generateDiscoveryDocument('pubsub', 'v1');

      expect(document.methods).toBeDefined();
      expect(document.methods?.['projects.topics.create']).toBeDefined();

      if (!document.methods) throw new Error('methods should be defined');
      const method = document.methods['projects.topics.create'];

      if (!method) throw new Error('method should be defined');

      expect(method.id).toBe('projects.topics.create');
      expect(method.httpMethod).toBe('PUT');
      expect(method.path).toBe('v1/{+name}');
      expect(method.description).toBe('Creates the given topic with the given name.');
      expect(method.request?.$ref).toBe('Topic');
      expect(method.response?.$ref).toBe('Topic');
      expect(method.scopes).toEqual(['https://www.googleapis.com/auth/pubsub']);
    });

    test('should generate method parameters', () => {
      const document = generator.generateDiscoveryDocument('pubsub', 'v1');

      if (!document.methods) throw new Error('methods should be defined');
      const method = document.methods['projects.topics.create'];

      if (!method) throw new Error('method should be defined');

      expect(method.parameters).toBeDefined();
      expect(method.parameters?.name).toBeDefined();
      expect(method.parameterOrder).toEqual(['name']);

      if (!method.parameters) throw new Error('parameters should be defined');
      const nameParam = method.parameters.name;

      if (!nameParam) throw new Error('name parameter should be defined');

      expect(nameParam.type).toBe('string');
      expect(nameParam.location).toBe('path');
      expect(nameParam.required).toBe(true);
      expect(nameParam.description).toBe('Required. The name of the topic.');
    });

    test('should generate authentication config when scopes are present', () => {
      const document = generator.generateDiscoveryDocument('pubsub', 'v1');

      expect(document.auth).toBeDefined();

      if (!document.auth) throw new Error('auth should be defined');
      expect(document.auth.oauth2.scopes).toBeDefined();
      expect(document.auth.oauth2.scopes['https://www.googleapis.com/auth/pubsub']).toBeDefined();
      expect(
        document.auth.oauth2.scopes['https://www.googleapis.com/auth/pubsub']?.description
      ).toBe('View and manage Pub/Sub topics and subscriptions');
    });

    test('should handle service without scopes', () => {
      const serviceWithoutScopes: ServiceInfo = {
        ...testService,
        methods: [
          {
            name: 'test.method',
            httpMethod: 'GET',
            path: 'v1/test',
            description: 'Test method',
            parameters: [],
          },
        ],
      };

      generator.registerService(serviceWithoutScopes);
      const document = generator.generateDiscoveryDocument('pubsub', 'v1');

      expect(document.auth).toBeUndefined();
    });

    test('should throw error for unknown service', () => {
      expect(() => {
        generator.generateDiscoveryDocument('unknown', 'v1');
      }).toThrow('Service unknown version v1 not found');
    });

    test('should handle services with resources', () => {
      const serviceWithResources: ServiceInfo = {
        ...testService,
        methods: [],
        resources: [
          {
            name: 'projects',
            methods: [
              {
                name: 'topics.create',
                httpMethod: 'PUT',
                path: 'v1/{+name}',
                description: 'Creates a topic.',
                parameters: [],
              },
            ],
            resources: [
              {
                name: 'topics',
                methods: [
                  {
                    name: 'list',
                    httpMethod: 'GET',
                    path: 'v1/{+project}/topics',
                    description: 'Lists topics.',
                    parameters: [],
                  },
                ],
                resources: [],
              },
            ],
          },
        ],
      };

      generator.registerService(serviceWithResources);
      const document = generator.generateDiscoveryDocument('pubsub', 'v1');

      expect(document.resources).toBeDefined();

      if (!document.resources) throw new Error('resources should be defined');
      expect(document.resources.projects).toBeDefined();
      expect(document.resources.projects?.methods).toBeDefined();
      expect(document.resources.projects?.resources).toBeDefined();
      if (!document.resources.projects?.resources)
        throw new Error('project resources should be defined');
      expect(document.resources.projects.resources.topics).toBeDefined();
    });
  });

  describe('Directory Document Generation', () => {
    beforeEach(() => {
      const service1: ServiceInfo = {
        name: 'pubsub',
        version: 'v1',
        title: 'Cloud Pub/Sub API',
        description: 'Pub/Sub messaging service.',
        baseUrl: 'https://pubsub.googleapis.com/',
        servicePath: 'v1/',
        methods: [],
        schemas: [],
        resources: [],
      };

      const service2: ServiceInfo = {
        name: 'tasks',
        version: 'v1',
        title: 'Cloud Tasks API',
        description: 'Task queue management service.',
        baseUrl: 'https://cloudtasks.googleapis.com/',
        servicePath: 'v1/',
        methods: [],
        schemas: [],
        resources: [],
      };

      generator.registerService(service1);
      generator.registerService(service2);
    });

    test('should generate directory document', () => {
      const directory = generator.generateDirectoryDocument();

      expect(directory.kind).toBe('discovery#directoryList');
      expect(directory.discoveryVersion).toBe('v1');
      expect(directory.items).toHaveLength(2);
    });

    test('should include correct service information', () => {
      const directory = generator.generateDirectoryDocument();

      const pubsubItem = directory.items.find(item => item.name === 'pubsub');

      expect(pubsubItem).toBeDefined();

      if (!pubsubItem) throw new Error('pubsubItem should be defined');
      expect(pubsubItem.kind).toBe('discovery#directoryItem');
      expect(pubsubItem.id).toBe('pubsub:v1');
      expect(pubsubItem.title).toBe('Cloud Pub/Sub API');
      expect(pubsubItem.description).toBe('Pub/Sub messaging service.');
      expect(pubsubItem.discoveryRestUrl).toBe(
        'https://pubsub.googleapis.com/$discovery/rest?version=v1'
      );
      expect(pubsubItem.preferred).toBe(true);
    });
  });

  describe('Static Factory Methods', () => {
    test('should create service info from config', () => {
      const config = {
        name: 'test',
        version: 'v1',
        title: 'Test API',
        description: 'Test description',
        baseUrl: 'https://test.googleapis.com/',
        methods: [
          {
            name: 'test.create',
            httpMethod: 'POST',
            path: 'v1/test',
            description: 'Create test',
            parameters: [
              {
                name: 'project',
                type: 'string',
                location: 'path',
                required: true,
                description: 'Project ID',
              },
            ],
            requestSchema: 'TestRequest',
            responseSchema: 'TestResponse',
            scopes: ['https://www.googleapis.com/auth/test'],
          },
        ],
        schemas: [
          {
            name: 'TestRequest',
            type: 'object',
            description: 'Test request schema',
            properties: [
              {
                name: 'name',
                type: 'string',
                description: 'Test name',
                repeated: false,
              },
            ],
            required: ['name'],
          },
        ],
      };

      const serviceInfo = DiscoveryDocumentGenerator.createServiceInfo(config);

      expect(serviceInfo.name).toBe('test');
      expect(serviceInfo.version).toBe('v1');
      expect(serviceInfo.title).toBe('Test API');
      expect(serviceInfo.servicePath).toBe('test/v1/');
      expect(serviceInfo.methods).toHaveLength(1);
      expect(serviceInfo.schemas).toHaveLength(1);
      expect(serviceInfo.resources).toHaveLength(0);

      const method = serviceInfo.methods[0];

      expect(method).toBeDefined();

      expect(method?.name).toBe('test.create');
      expect(method?.httpMethod).toBe('POST');
      expect(method?.parameters).toHaveLength(1);
      expect(method?.parameters[0]?.required).toBe(true);

      const schema = serviceInfo.schemas[0];

      expect(schema).toBeDefined();

      expect(schema?.name).toBe('TestRequest');
      expect(schema?.properties).toHaveLength(1);
      expect(schema?.required).toEqual(['name']);
    });

    test('should handle optional config fields', () => {
      const minimalConfig = {
        name: 'minimal',
        version: 'v1',
        title: 'Minimal API',
        description: 'Minimal description',
        baseUrl: 'https://minimal.googleapis.com/',
        methods: [],
      };

      const serviceInfo = DiscoveryDocumentGenerator.createServiceInfo(minimalConfig);

      expect(serviceInfo.methods).toHaveLength(0);
      expect(serviceInfo.schemas).toHaveLength(0);
      expect(serviceInfo.resources).toHaveLength(0);
    });
  });

  describe('Utility Functions', () => {
    test('should generate revision string', () => {
      // Register a service for this test
      const testService: ServiceInfo = {
        name: 'pubsub',
        version: 'v1',
        title: 'Test API',
        description: 'Test service',
        baseUrl: 'https://test.googleapis.com/',
        servicePath: 'v1/',
        methods: [],
        schemas: [],
        resources: [],
      };

      generator.registerService(testService);
      const document = generator.generateDiscoveryDocument('pubsub', 'v1');

      // Should be in format YYYYMMDD
      expect(document.revision).toMatch(/^\d{8}$/);
    });

    test('should handle complex schema properties', () => {
      const serviceWithComplexSchema: ServiceInfo = {
        name: 'test',
        version: 'v1',
        title: 'Test API',
        description: 'Test service',
        baseUrl: 'https://test.googleapis.com/',
        servicePath: 'v1/',
        methods: [],
        schemas: [
          {
            name: 'ComplexSchema',
            type: 'object',
            description: 'Complex schema with nested properties',
            properties: [
              {
                name: 'simpleField',
                type: 'string',
                description: 'Simple string field',
              },
              {
                name: 'arrayField',
                type: 'array',
                description: 'Array field',
                items: {
                  name: 'item',
                  type: 'string',
                  description: 'Array item',
                },
              },
              {
                name: 'nestedObject',
                type: 'object',
                description: 'Nested object',
                properties: [
                  {
                    name: 'nestedField',
                    type: 'string',
                    description: 'Field in nested object',
                  },
                ],
              },
              {
                name: 'refField',
                type: 'object',
                description: 'Reference field',
                ref: 'AnotherSchema',
              },
            ],
            required: ['simpleField'],
          },
        ],
        resources: [],
      };

      generator.registerService(serviceWithComplexSchema);
      const document = generator.generateDiscoveryDocument('test', 'v1');

      const schema = document.schemas.ComplexSchema;

      expect(schema).toBeDefined();

      if (!schema?.properties) throw new Error('properties should be defined');
      expect(schema.properties.simpleField?.type).toBe('string');
      expect(schema.properties.arrayField?.items).toBeDefined();
      expect(schema.properties.nestedObject?.properties).toBeDefined();
      expect(schema.properties.refField?.$ref).toBe('AnotherSchema');
    });
  });
});
