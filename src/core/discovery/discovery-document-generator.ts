/**
 * Discovery Document Generator
 * Generates Google API Discovery documents for service introspection and client generation
 */

import type { Logger } from '@/shared/utils/logger.ts';

// Discovery document interfaces based on Google API Discovery format
export interface DiscoveryDocument {
  kind: string;
  discoveryVersion: string;
  id: string;
  name: string;
  version: string;
  revision: string;
  title: string;
  description: string;
  icons: {
    x16: string;
    x32: string;
  };
  documentationLink: string;
  protocol: string;
  baseUrl: string;
  basePath: string;
  rootUrl: string;
  servicePath: string;
  batchPath: string;
  parameters: Record<string, Parameter>;
  auth?: AuthConfig;
  features?: string[];
  schemas: Record<string, Schema>;
  methods?: Record<string, Method>;
  resources?: Record<string, Resource>;
}

export interface Parameter {
  id: string;
  type: string;
  default?: unknown;
  required?: boolean;
  format?: string | undefined;
  pattern?: string | undefined;
  minimum?: string | undefined;
  maximum?: string | undefined;
  enum?: string[] | undefined;
  enumDescriptions?: string[] | undefined;
  repeated?: boolean | undefined;
  location: string;
  description: string;
}

export interface AuthConfig {
  oauth2: {
    scopes: Record<
      string,
      {
        description: string;
      }
    >;
  };
}

export interface Schema {
  id: string;
  type: string;
  description?: string;
  properties?: Record<string, Property>;
  additionalProperties?: Property | boolean;
  required?: string[];
  enum?: string[];
  enumDescriptions?: string[];
  format?: string;
  pattern?: string;
  minimum?: string;
  maximum?: string;
}

export interface Property {
  type: string;
  description?: string | undefined;
  format?: string | undefined;
  pattern?: string | undefined;
  minimum?: string | undefined;
  maximum?: string | undefined;
  enum?: string[] | undefined;
  enumDescriptions?: string[] | undefined;
  required?: boolean | undefined;
  repeated?: boolean | undefined;
  location?: string | undefined;
  properties?: Record<string, Property> | undefined;
  additionalProperties?: Property | boolean | undefined;
  items?: Property | undefined;
  $ref?: string | undefined;
}

export interface Method {
  id: string;
  path: string;
  httpMethod: string;
  description: string;
  parameters?: Record<string, Parameter>;
  parameterOrder?: string[];
  request?: {
    $ref: string;
    parameterName?: string;
  };
  response?: {
    $ref: string;
  };
  scopes?: string[] | undefined;
  supportsMediaDownload?: boolean;
  supportsMediaUpload?: boolean;
  supportsSubscription?: boolean;
  mediaUpload?: {
    accept: string[];
    maxSize: string;
    protocols: {
      simple: {
        multipart: boolean;
        path: string;
      };
      resumable?: {
        multipart: boolean;
        path: string;
      };
    };
  };
}

export interface Resource {
  methods?: Record<string, Method>;
  resources?: Record<string, Resource>;
}

export interface ServiceInfo {
  name: string;
  version: string;
  title: string;
  description: string;
  baseUrl: string;
  servicePath: string;
  methods: ServiceMethod[];
  schemas: ServiceSchema[];
  resources: ServiceResource[];
}

export interface ServiceMethod {
  name: string;
  httpMethod: string;
  path: string;
  description: string;
  parameters: ServiceParameter[];
  requestSchema?: string | undefined;
  responseSchema?: string | undefined;
  scopes?: string[] | undefined;
}

export interface ServiceParameter {
  name: string;
  type: string;
  location: string;
  required: boolean;
  description: string;
  format?: string;
  pattern?: string;
}

export interface ServiceSchema {
  name: string;
  type: string;
  description: string;
  properties: ServiceProperty[];
  required: string[];
}

export interface ServiceProperty {
  name: string;
  type: string;
  description?: string | undefined;
  format?: string | undefined;
  repeated?: boolean | undefined;
  properties?: ServiceProperty[] | undefined;
  items?: ServiceProperty | undefined;
  ref?: string | undefined;
}

export interface ServiceResource {
  name: string;
  methods: ServiceMethod[];
  resources: ServiceResource[];
}

export class DiscoveryDocumentGenerator {
  private logger: Logger;
  private services: Map<string, ServiceInfo> = new Map();

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Register a service for discovery
   */
  registerService(serviceInfo: ServiceInfo): void {
    const key = `${serviceInfo.name}:${serviceInfo.version}`;

    this.services.set(key, serviceInfo);

    this.logger.info(
      `Registered service for discovery: ${serviceInfo.name} ${serviceInfo.version}`
    );
  }

  /**
   * Generate discovery document for a service
   */
  generateDiscoveryDocument(serviceName: string, version: string): DiscoveryDocument {
    const key = `${serviceName}:${version}`;
    const serviceInfo = this.services.get(key);

    if (!serviceInfo) {
      throw new Error(`Service ${serviceName} version ${version} not found`);
    }

    const document: DiscoveryDocument = {
      kind: 'discovery#restDescription',
      discoveryVersion: 'v1',
      id: `${serviceName}:${version}`,
      name: serviceName,
      version,
      revision: this.generateRevision(),
      title: serviceInfo.title,
      description: serviceInfo.description,
      icons: {
        x16: 'https://www.google.com/images/icons/product/search-16.gif',
        x32: 'https://www.google.com/images/icons/product/search-32.gif',
      },
      documentationLink: `https://cloud.google.com/${serviceName}/docs/`,
      protocol: 'rest',
      baseUrl: serviceInfo.baseUrl,
      basePath: `/${serviceName}/${version}/`,
      rootUrl: serviceInfo.baseUrl.replace(/\/[^/]*$/, '/'),
      servicePath: serviceInfo.servicePath,
      batchPath: 'batch',
      parameters: this.generateGlobalParameters(),
      schemas: this.generateSchemas(serviceInfo.schemas),
    };

    if (serviceInfo.methods.length > 0) {
      document.methods = this.generateMethods(serviceInfo.methods);
    }

    if (serviceInfo.resources.length > 0) {
      document.resources = this.generateResources(serviceInfo.resources);
    }

    const hasScopes = this.hasAuthScopes(serviceInfo);

    if (hasScopes) {
      document.auth = this.generateAuthConfig(serviceInfo);
    }

    this.logger.debug(`Generated discovery document for ${serviceName} ${version}`);

    return document;
  }

  /**
   * Get list of available services
   */
  getServiceList(): Array<{ name: string; version: string; title: string; description: string }> {
    return Array.from(this.services.values()).map(service => ({
      name: service.name,
      version: service.version,
      title: service.title,
      description: service.description,
    }));
  }

  /**
   * Generate directory listing of available APIs
   */
  generateDirectoryDocument(): {
    kind: string;
    discoveryVersion: string;
    items: Array<{
      kind: string;
      id: string;
      name: string;
      version: string;
      title: string;
      description: string;
      discoveryRestUrl: string;
      icons: {
        x16: string;
        x32: string;
      };
      documentationLink: string;
      preferred: boolean;
    }>;
  } {
    return {
      kind: 'discovery#directoryList',
      discoveryVersion: 'v1',
      items: Array.from(this.services.values()).map(service => ({
        kind: 'discovery#directoryItem',
        id: `${service.name}:${service.version}`,
        name: service.name,
        version: service.version,
        title: service.title,
        description: service.description,
        discoveryRestUrl: `${service.baseUrl}$discovery/rest?version=${service.version}`,
        icons: {
          x16: 'https://www.google.com/images/icons/product/search-16.gif',
          x32: 'https://www.google.com/images/icons/product/search-32.gif',
        },
        documentationLink: `https://cloud.google.com/${service.name}/docs/`,
        preferred: true,
      })),
    };
  }

  /**
   * Create service info from method definitions
   */
  static createServiceInfo(config: {
    name: string;
    version: string;
    title: string;
    description: string;
    baseUrl: string;
    methods: Array<{
      name: string;
      httpMethod: string;
      path: string;
      description: string;
      parameters?: Array<{
        name: string;
        type: string;
        location: string;
        required?: boolean;
        description?: string;
      }>;
      requestSchema?: string;
      responseSchema?: string;
      scopes?: string[];
    }>;
    schemas?: Array<{
      name: string;
      type: string;
      description?: string;
      properties?: Array<{
        name: string;
        type: string;
        description?: string;
        format?: string;
        repeated?: boolean;
      }>;
      required?: string[];
    }>;
  }): ServiceInfo {
    return {
      name: config.name,
      version: config.version,
      title: config.title,
      description: config.description,
      baseUrl: config.baseUrl,
      servicePath: `${config.name}/${config.version}/`,
      methods: config.methods.map(method => ({
        name: method.name,
        httpMethod: method.httpMethod,
        path: method.path,
        description: method.description,
        parameters: (method.parameters || []).map(param => ({
          name: param.name,
          type: param.type,
          location: param.location,
          required: param.required || false,
          description: param.description || '',
        })),
        requestSchema: method.requestSchema,
        responseSchema: method.responseSchema,
        scopes: method.scopes,
      })),
      schemas: (config.schemas || []).map(schema => ({
        name: schema.name,
        type: schema.type,
        description: schema.description || '',
        properties: (schema.properties || []).map(prop => ({
          name: prop.name,
          type: prop.type,
          description: prop.description,
          format: prop.format,
          repeated: prop.repeated,
        })),
        required: schema.required || [],
      })),
      resources: [],
    };
  }

  /**
   * Generate global parameters for all API calls
   */
  private generateGlobalParameters(): Record<string, Parameter> {
    return {
      access_token: {
        id: 'access_token',
        type: 'string',
        description: 'OAuth access token.',
        location: 'query',
      },
      alt: {
        id: 'alt',
        type: 'string',
        description: 'Data format for response.',
        default: 'json',
        enum: ['json', 'media', 'proto'],
        enumDescriptions: [
          'Responses with Content-Type of application/json',
          'Media download with context-dependent Content-Type',
          'Responses with Content-Type of application/x-protobuf',
        ],
        location: 'query',
      },
      callback: {
        id: 'callback',
        type: 'string',
        description: 'JSONP callback.',
        location: 'query',
      },
      fields: {
        id: 'fields',
        type: 'string',
        description: 'Selector specifying which fields to include in a partial response.',
        location: 'query',
      },
      key: {
        id: 'key',
        type: 'string',
        description: 'API key. Your API key identifies your project.',
        location: 'query',
      },
      oauth_token: {
        id: 'oauth_token',
        type: 'string',
        description: 'OAuth 2.0 token for the current user.',
        location: 'query',
      },
      prettyPrint: {
        id: 'prettyPrint',
        type: 'boolean',
        description: 'Returns response with indentations and line breaks.',
        default: true,
        location: 'query',
      },
      quotaUser: {
        id: 'quotaUser',
        type: 'string',
        description: 'Available to use for quota purposes for server-side applications.',
        location: 'query',
      },
      uploadType: {
        id: 'uploadType',
        type: 'string',
        description: 'Legacy upload protocol for media.',
        location: 'query',
      },
      upload_protocol: {
        id: 'upload_protocol',
        type: 'string',
        description: 'Upload protocol for media.',
        location: 'query',
      },
    };
  }

  /**
   * Generate schemas section of discovery document
   */
  private generateSchemas(schemas: ServiceSchema[]): Record<string, Schema> {
    const result: Record<string, Schema> = {};

    for (const schema of schemas) {
      result[schema.name] = {
        id: schema.name,
        type: schema.type,
        description: schema.description,
        properties: this.generateSchemaProperties(schema.properties),
        required: schema.required,
      };
    }

    return result;
  }

  /**
   * Generate schema properties
   */
  private generateSchemaProperties(properties: ServiceProperty[]): Record<string, Property> {
    const result: Record<string, Property> = {};

    for (const prop of properties) {
      const property: Property = {
        type: prop.type,
        description: prop.description,
        format: prop.format,
        repeated: prop.repeated,
        $ref: prop.ref ? prop.ref : undefined,
        properties: prop.properties ? this.generateSchemaProperties(prop.properties) : undefined,
        items: prop.items
          ? {
              type: prop.items.type,
              description: prop.items.description,
              format: prop.items.format,
              $ref: prop.items.ref,
            }
          : undefined,
      };

      result[prop.name] = property;
    }

    return result;
  }

  /**
   * Generate methods section
   */
  private generateMethods(methods: ServiceMethod[]): Record<string, Method> {
    const result: Record<string, Method> = {};

    for (const method of methods) {
      const methodObj: Method = {
        id: method.name,
        path: method.path,
        httpMethod: method.httpMethod.toUpperCase(),
        description: method.description,
        parameters: this.generateMethodParameters(method.parameters),
        parameterOrder: method.parameters.filter(p => p.required).map(p => p.name),
        scopes: method.scopes,
        ...(method.requestSchema
          ? {
              request: {
                $ref: method.requestSchema,
              },
            }
          : {}),
        ...(method.responseSchema
          ? {
              response: {
                $ref: method.responseSchema,
              },
            }
          : {}),
      };

      result[method.name] = methodObj;
    }

    return result;
  }

  /**
   * Generate method parameters
   */
  private generateMethodParameters(parameters: ServiceParameter[]): Record<string, Parameter> {
    const result: Record<string, Parameter> = {};

    for (const param of parameters) {
      result[param.name] = {
        id: param.name,
        type: param.type,
        required: param.required,
        location: param.location,
        description: param.description,
        format: param.format,
        pattern: param.pattern,
      };
    }

    return result;
  }

  /**
   * Generate resources section
   */
  private generateResources(resources: ServiceResource[]): Record<string, Resource> {
    const result: Record<string, Resource> = {};

    for (const resource of resources) {
      const resourceObj: Resource = {
        methods: this.generateMethods(resource.methods),
        ...(resource.resources.length > 0
          ? {
              resources: this.generateResources(resource.resources),
            }
          : {}),
      };

      result[resource.name] = resourceObj;
    }

    return result;
  }

  /**
   * Check if service has authentication scopes
   */
  private hasAuthScopes(serviceInfo: ServiceInfo): boolean {
    const allMethods = [...serviceInfo.methods, ...serviceInfo.resources.flatMap(r => r.methods)];

    return allMethods.some(method => method.scopes && method.scopes.length > 0);
  }

  /**
   * Generate authentication configuration
   */
  private generateAuthConfig(serviceInfo: ServiceInfo): AuthConfig {
    const allMethods = [...serviceInfo.methods, ...serviceInfo.resources.flatMap(r => r.methods)];

    const scopes: Record<string, { description: string }> = {};

    for (const method of allMethods) {
      if (method.scopes) {
        for (const scope of method.scopes) {
          if (!scopes[scope]) {
            scopes[scope] = {
              description: this.getScopeDescription(scope),
            };
          }
        }
      }
    }

    return {
      oauth2: {
        scopes,
      },
    };
  }

  /**
   * Get description for OAuth scope
   */
  private getScopeDescription(scope: string): string {
    const commonScopes: Record<string, string> = {
      'https://www.googleapis.com/auth/cloud-platform':
        'See, edit, configure, and delete your Google Cloud data',
      'https://www.googleapis.com/auth/pubsub': 'View and manage Pub/Sub topics and subscriptions',
      'https://www.googleapis.com/auth/cloud-tasks':
        'Manage your Google Cloud Tasks queues and tasks',
      'https://www.googleapis.com/auth/cloudscheduler': 'Manage your Google Cloud Scheduler jobs',
    };

    return commonScopes[scope] || `Access to ${scope}`;
  }

  /**
   * Generate revision string
   */
  private generateRevision(): string {
    const datePart = new Date().toISOString().split('T')[0];

    if (!datePart) {
      throw new Error('Failed to generate revision from date');
    }

    return datePart.replace(/-/g, '');
  }
}
