/**
 * Discovery API Endpoints
 *
 * Implements the Google Cloud Platform Discovery API endpoints including
 * /$discovery/rest, API listing, version negotiation, and schema validation.
 */

import { z } from 'zod';
import type { Logger } from '@/shared/utils/logger.ts';
import type {
  DiscoveryDocumentGenerator,
  ServiceInfo,
  ServiceMethod,
  ServiceResource,
  ServiceSchema,
} from './discovery-document-generator.ts';
import type { ServiceRegistry } from './service-registry.ts';

// Discovery API request/response schemas
export const DiscoveryQuerySchema = z.object({
  version: z.string().optional(),
  fields: z.string().optional(),
  prettyPrint: z.union([z.literal('true'), z.literal('false'), z.boolean()]).optional(),
  alt: z.enum(['json', 'media', 'proto']).optional().default('json'),
  callback: z.string().optional(),
  key: z.string().optional(),
  oauth_token: z.string().optional(),
  quotaUser: z.string().optional(),
  userIp: z.string().optional(),
});

export const ServiceListQuerySchema = z.object({
  preferred: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .default(true),
  name: z.string().optional(),
  version: z.string().optional(),
});

export type DiscoveryQuery = z.infer<typeof DiscoveryQuerySchema>;
export type ServiceListQuery = z.infer<typeof ServiceListQuerySchema>;

// Error response schemas
export interface ErrorResponse {
  error: {
    code: number;
    message: string;
    status: string;
    details?: Array<{
      '@type': string;
      reason?: string;
      domain?: string;
      metadata?: Record<string, string>;
    }>;
  };
}

export interface DiscoveryEndpointConfig {
  readonly baseUrl: string;
  readonly enableCaching: boolean;
  readonly cacheTimeout: number;
  readonly enableVersionNegotiation: boolean;
  readonly supportedVersions: string[];
  readonly maxFieldSelectionDepth: number;
}

export const DEFAULT_DISCOVERY_CONFIG: DiscoveryEndpointConfig = {
  baseUrl: 'http://localhost:8765',
  enableCaching: true,
  cacheTimeout: 300000, // 5 minutes
  enableVersionNegotiation: true,
  supportedVersions: ['v1'],
  maxFieldSelectionDepth: 10,
};

/**
 * Discovery API Endpoints Handler
 */
export class DiscoveryEndpoints {
  private logger: Logger;
  private config: DiscoveryEndpointConfig;
  private serviceRegistry: ServiceRegistry;
  private documentGenerator: DiscoveryDocumentGenerator;
  private responseCache: Map<string, CacheEntry> = new Map();

  constructor(
    logger: Logger,
    serviceRegistry: ServiceRegistry,
    documentGenerator: DiscoveryDocumentGenerator,
    config: Partial<DiscoveryEndpointConfig> = {}
  ) {
    this.logger = logger;
    this.config = { ...DEFAULT_DISCOVERY_CONFIG, ...config };
    this.serviceRegistry = serviceRegistry;
    this.documentGenerator = documentGenerator;

    if (this.config.enableCaching) {
      this.startCacheCleanup();
    }

    this.logger.info('Discovery API Endpoints initialized', {
      caching: this.config.enableCaching,
      versionNegotiation: this.config.enableVersionNegotiation,
    });
  }

  /**
   * Handle /$discovery/rest endpoint
   */
  async handleDiscoveryRest(
    serviceName: string,
    query: DiscoveryQuery,
    headers: Record<string, string> = {}
  ): Promise<Response> {
    try {
      const validatedQuery = DiscoveryQuerySchema.parse(query);

      this.logger.debug('Discovery REST request', {
        serviceName,
        query: validatedQuery,
      });

      const availableVersions = this.getAvailableVersions(serviceName)[serviceName] || [];

      if (availableVersions.length === 0) {
        return this.createErrorResponse(404, `Service '${serviceName}' not found`, 'NOT_FOUND');
      }

      const version = this.negotiateVersion(serviceName, validatedQuery.version, headers);

      if (!version) {
        return this.createErrorResponse(400, 'Invalid version', 'INVALID_VERSION', {
          availableVersions: this.getAvailableVersions(serviceName),
        });
      }

      if (this.config.enableCaching) {
        const cacheKey = this.createCacheKey('discovery', serviceName, version, validatedQuery);
        const cached = this.getFromCache(cacheKey);

        if (cached) {
          this.logger.debug('Serving discovery document from cache', {
            serviceName,
            version,
          });

          return this.formatResponse(cached.data, {
            alt: validatedQuery.alt,
            ...(validatedQuery.callback && { callback: validatedQuery.callback }),
          });
        }
      }

      try {
        const discoveryDocument = this.documentGenerator.generateDiscoveryDocument(
          serviceName,
          version
        );

        const filteredDocument = this.applyFieldSelection(
          discoveryDocument as unknown as Record<string, unknown>,
          validatedQuery.fields
        );

        if (this.config.enableCaching) {
          const cacheKey = this.createCacheKey('discovery', serviceName, version, validatedQuery);

          this.setInCache(cacheKey, filteredDocument);
        }

        return this.formatResponse(filteredDocument, {
          alt: validatedQuery.alt,
          ...(validatedQuery.callback && { callback: validatedQuery.callback }),
        });
      } catch (error) {
        const err = error as Error;

        this.logger.warn('Service not found for discovery', {
          serviceName,
          version,
          error: err.message,
        });

        return this.createErrorResponse(
          404,
          `Service '${serviceName}' version '${version}' not found`,
          'NOT_FOUND'
        );
      }
    } catch (error) {
      const err = error as Error;

      if (error instanceof z.ZodError) {
        return this.createErrorResponse(400, 'Invalid query parameters', 'INVALID_PARAMETER', {
          validationErrors: error.issues,
        });
      }

      this.logger.error('Discovery REST endpoint error', {
        serviceName,
        error: err.message,
      });

      return this.createErrorResponse(500, 'Internal server error', 'INTERNAL_ERROR');
    }
  }

  /**
   * Handle API directory listing endpoint
   */
  async handleApiDirectory(
    query: ServiceListQuery,
    _headers: Record<string, string> = {}
  ): Promise<Response> {
    try {
      const validatedQuery = ServiceListQuerySchema.parse(query);

      this.logger.debug('API directory request', {
        query: validatedQuery,
      });

      if (this.config.enableCaching) {
        const cacheKey = this.createCacheKey('directory', '', '', validatedQuery);
        const cached = this.getFromCache(cacheKey);

        if (cached) {
          this.logger.debug('Serving API directory from cache');

          return this.formatResponse(cached.data, { alt: 'json' });
        }
      }

      const directoryDocument = this.documentGenerator.generateDirectoryDocument();

      let items = directoryDocument.items;

      if (validatedQuery.name) {
        items = items.filter(item => item.name === validatedQuery.name);
      }

      if (validatedQuery.version) {
        items = items.filter(item => item.version === validatedQuery.version);
      }

      if (validatedQuery.preferred) {
        items = items.filter(item => item.preferred);
      }

      const filteredDocument = {
        ...directoryDocument,
        items,
      };

      if (this.config.enableCaching) {
        const cacheKey = this.createCacheKey('directory', '', '', validatedQuery);

        this.setInCache(cacheKey, filteredDocument);
      }

      return this.formatResponse(filteredDocument, { alt: 'json' });
    } catch (error) {
      const err = error as Error;

      if (error instanceof z.ZodError) {
        return this.createErrorResponse(400, 'Invalid query parameters', 'INVALID_PARAMETER', {
          validationErrors: error.issues,
        });
      }

      this.logger.error('API directory endpoint error', {
        error: err.message,
      });

      return this.createErrorResponse(500, 'Internal server error', 'INTERNAL_ERROR');
    }
  }

  /**
   * Handle service-specific discovery endpoint
   */
  async handleServiceDiscovery(
    serviceName: string,
    version: string,
    endpoint: string,
    _query: Record<string, unknown> = {},
    _headers: Record<string, string> = {}
  ): Promise<Response> {
    try {
      this.logger.debug('Service discovery request', {
        serviceName,
        version,
        endpoint,
      });

      const services = this.serviceRegistry.getServicesByName(serviceName);
      const service = services.find(s => s.version === version);

      if (!service) {
        return this.createErrorResponse(
          404,
          `Service '${serviceName}' version '${version}' not found`,
          'NOT_FOUND'
        );
      }

      switch (endpoint) {
        case 'methods': {
          const serviceInfo: ServiceInfo = {
            name: service.name,
            version: service.version,
            title: service.description || service.name,
            description: service.description || `${service.name} service`,
            baseUrl: `${service.endpoint.ssl ? 'https' : 'http'}://${service.endpoint.host}:${service.endpoint.port}`,
            servicePath: service.endpoint.basePath,
            methods: [],
            schemas: [],
            resources: [],
          };

          return this.formatResponse(this.getServiceMethods(serviceInfo), { alt: 'json' });
        }

        case 'schemas': {
          const serviceInfo: ServiceInfo = {
            name: service.name,
            version: service.version,
            title: service.description || service.name,
            description: service.description || `${service.name} service`,
            baseUrl: `${service.endpoint.ssl ? 'https' : 'http'}://${service.endpoint.host}:${service.endpoint.port}`,
            servicePath: service.endpoint.basePath,
            methods: [],
            schemas: [],
            resources: [],
          };

          return this.formatResponse(this.getServiceSchemas(serviceInfo), { alt: 'json' });
        }

        case 'resources': {
          const serviceInfo: ServiceInfo = {
            name: service.name,
            version: service.version,
            title: service.description || service.name,
            description: service.description || `${service.name} service`,
            baseUrl: `${service.endpoint.ssl ? 'https' : 'http'}://${service.endpoint.host}:${service.endpoint.port}`,
            servicePath: service.endpoint.basePath,
            methods: [],
            schemas: [],
            resources: [],
          };

          return this.formatResponse(this.getServiceResources(serviceInfo), { alt: 'json' });
        }

        case 'health': {
          const health = this.serviceRegistry.getServiceHealth(service.id);

          return this.formatResponse(health, { alt: 'json' });
        }

        default:
          return this.createErrorResponse(
            404,
            `Discovery endpoint '${endpoint}' not found`,
            'NOT_FOUND'
          );
      }
    } catch (error) {
      const err = error as Error;

      this.logger.error('Service discovery endpoint error', {
        serviceName,
        version,
        endpoint,
        error: err.message,
      });

      return this.createErrorResponse(500, 'Internal server error', 'INTERNAL_ERROR');
    }
  }

  /**
   * Validate discovery request parameters
   */
  validateDiscoveryRequest(
    serviceName: string,
    query: Record<string, unknown>
  ): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];

    if (!serviceName || typeof serviceName !== 'string') {
      errors.push('Service name is required and must be a string');
    }

    if (query.version && typeof query.version !== 'string') {
      errors.push('Version must be a string');
    }

    if (query.fields && typeof query.fields !== 'string') {
      errors.push('Fields parameter must be a string');
    }

    if (query.alt && !['json', 'media', 'proto'].includes(query.alt as string)) {
      errors.push('Alt parameter must be one of: json, media, proto');
    }

    const booleanParams = ['prettyPrint'];

    for (const param of booleanParams) {
      const value = query[param];

      if (
        value !== undefined &&
        typeof value !== 'boolean' &&
        value !== 'true' &&
        value !== 'false'
      ) {
        errors.push(`${param} parameter must be a boolean or 'true'/'false' string`);
      }
    }

    const result: { valid: boolean; errors?: string[] } = {
      valid: errors.length === 0,
    };

    if (errors.length > 0) {
      result.errors = errors;
    }

    return result;
  }

  /**
   * Get available API versions
   */
  getAvailableVersions(serviceName?: string): Record<string, string[]> {
    if (serviceName) {
      const versionInfo = this.serviceRegistry.getServiceVersions(serviceName);

      return versionInfo ? { [serviceName]: versionInfo.versions.map(v => v.version) } : {};
    }

    const services = this.serviceRegistry.discoverServices();
    const versionsByService: Record<string, string[]> = {};

    for (const service of services) {
      if (!versionsByService[service.name]) {
        versionsByService[service.name] = [];
      }

      const serviceVersions = versionsByService[service.name];

      if (serviceVersions && !serviceVersions.includes(service.version)) {
        serviceVersions.push(service.version);
      }
    }

    return versionsByService;
  }

  /**
   * Clear discovery cache
   */
  clearCache(): void {
    this.responseCache.clear();
    this.logger.debug('Discovery cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): CacheStats {
    const now = Date.now();
    let validEntries = 0;
    let expiredEntries = 0;

    for (const entry of this.responseCache.values()) {
      if (now - entry.timestamp < this.config.cacheTimeout) {
        validEntries++;
      } else {
        expiredEntries++;
      }
    }

    return {
      totalEntries: this.responseCache.size,
      validEntries,
      expiredEntries,
      hitRate: 0, // Would need to track hits/misses for accurate calculation
    };
  }

  /**
   * Negotiate API version
   */
  private negotiateVersion(
    serviceName: string,
    requestedVersion?: string,
    headers: Record<string, string> = {}
  ): string | null {
    if (!this.config.enableVersionNegotiation) {
      return requestedVersion || 'v1';
    }

    const availableVersions = this.getAvailableVersions(serviceName)[serviceName] || [];

    if (availableVersions.length === 0) {
      return null;
    }

    if (requestedVersion) {
      return availableVersions.includes(requestedVersion) ? requestedVersion : null;
    }

    const acceptVersion = headers['accept-version'] || headers['Accept-Version'];

    if (acceptVersion && availableVersions.includes(acceptVersion)) {
      return acceptVersion;
    }

    const versionInfo = this.serviceRegistry.getServiceVersions(serviceName);

    return versionInfo?.defaultVersion ?? availableVersions[0] ?? null;
  }

  /**
   * Apply field selection to response
   */
  private applyFieldSelection(
    data: Record<string, unknown>,
    fields?: string,
    depth: number = 0
  ): Record<string, unknown> {
    if (!fields || depth > this.config.maxFieldSelectionDepth) {
      return data;
    }

    // Simple field selection implementation
    // In production, this would use a more sophisticated field selection parser
    const selectedFields = fields.split(',').map(f => f.trim());
    const result: Record<string, unknown> = {};

    for (const field of selectedFields) {
      if (field.includes('/')) {
        // Nested field selection (e.g., "schemas/Topic")
        const parts = field.split('/', 2);
        const parent = parts[0];
        const child = parts[1];

        if (parent && child) {
          const parentValue = data[parent];

          if (parentValue && typeof parentValue === 'object') {
            const parentObj = parentValue as Record<string, unknown>;

            if (!result[parent]) {
              result[parent] = {};
            }

            const resultParent = result[parent] as Record<string, unknown>;
            const childValue = parentObj[child];

            if (childValue !== undefined) {
              resultParent[child] = childValue;
            }
          }
        }
      } else if (Object.hasOwn(data, field)) {
        result[field] = data[field];
      }
    }

    return Object.keys(result).length > 0 ? result : data;
  }

  /**
   * Create cache key for response caching
   */
  private createCacheKey(
    type: string,
    serviceName: string,
    version: string,
    query: Record<string, unknown>
  ): string {
    const queryString = Object.entries(query)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');

    return `${type}:${serviceName}:${version}:${queryString}`;
  }

  /**
   * Get from cache if not expired
   */
  private getFromCache(key: string): CacheEntry | null {
    const entry = this.responseCache.get(key);

    if (!entry) {
      return null;
    }

    const now = Date.now();

    if (now - entry.timestamp > this.config.cacheTimeout) {
      this.responseCache.delete(key);

      return null;
    }

    return entry;
  }

  /**
   * Set in cache
   */
  private setInCache(key: string, data: unknown): void {
    this.responseCache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Start cache cleanup timer
   */
  private startCacheCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      const expiredKeys: string[] = [];

      for (const [key, entry] of this.responseCache.entries()) {
        if (now - entry.timestamp > this.config.cacheTimeout) {
          expiredKeys.push(key);
        }
      }

      for (const key of expiredKeys) {
        this.responseCache.delete(key);
      }

      if (expiredKeys.length > 0) {
        this.logger.debug(`Cleaned up ${expiredKeys.length} expired cache entries`);
      }
    }, this.config.cacheTimeout / 2);
  }

  /**
   * Get service methods for discovery
   */
  private getServiceMethods(service: ServiceInfo): Record<string, unknown> {
    return {
      serviceName: service.name,
      version: service.version,
      methods: service.methods.map((method: ServiceMethod) => ({
        name: method.name,
        httpMethod: method.httpMethod,
        path: method.path,
        description: method.description,
        parameters: method.parameters.length,
        hasRequest: !!method.requestSchema,
        hasResponse: !!method.responseSchema,
      })),
    };
  }

  /**
   * Get service schemas for discovery
   */
  private getServiceSchemas(service: ServiceInfo): Record<string, unknown> {
    return {
      serviceName: service.name,
      version: service.version,
      schemas: service.schemas.map((schema: ServiceSchema) => ({
        name: schema.name,
        type: schema.type,
        description: schema.description,
        propertiesCount: schema.properties.length,
        requiredFields: schema.required.length,
      })),
    };
  }

  /**
   * Get service resources for discovery
   */
  private getServiceResources(service: ServiceInfo): Record<string, unknown> {
    return {
      serviceName: service.name,
      version: service.version,
      resources:
        service.resources?.map((resource: ServiceResource) => ({
          name: resource.name,
          methodsCount: resource.methods.length,
          hasSubResources: resource.resources.length > 0,
        })) || [],
    };
  }

  /**
   * Create error response
   */
  private createErrorResponse(
    code: number,
    message: string,
    status: string,
    metadata?: Record<string, unknown>
  ): Response {
    const errorResponse: ErrorResponse = {
      error: {
        code,
        message,
        status,
        ...(metadata && {
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: status,
              domain: 'discovery.googleapis.com',
              metadata: Object.fromEntries(
                Object.entries(metadata).map(([k, v]) => [k, String(v)])
              ),
            },
          ],
        }),
      },
    };

    return new Response(JSON.stringify(errorResponse, null, 2), {
      status: code,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  /**
   * Format response based on query parameters
   */
  private formatResponse(data: unknown, query: { alt?: string; callback?: string }): Response {
    const alt = query.alt || 'json';
    let contentType = 'application/json';
    let responseData: string;

    switch (alt) {
      case 'json':
        contentType = 'application/json';
        responseData = JSON.stringify(data, null, 2);
        break;

      case 'proto':
        contentType = 'application/x-protobuf';
        // In a real implementation, would serialize to protobuf
        responseData = JSON.stringify(data);
        break;

      case 'media':
        contentType = 'application/octet-stream';
        responseData = JSON.stringify(data);
        break;

      default:
        contentType = 'application/json';
        responseData = JSON.stringify(data, null, 2);
    }

    if (query.callback && alt === 'json') {
      contentType = 'application/javascript';
      responseData = `${query.callback}(${responseData});`;
    }

    return new Response(responseData, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Cache-Control': this.config.enableCaching
          ? `public, max-age=${Math.floor(this.config.cacheTimeout / 1000)}`
          : 'no-cache',
      },
    });
  }
}

// Supporting interfaces
interface CacheEntry {
  data: unknown;
  timestamp: number;
}

interface CacheStats {
  totalEntries: number;
  validEntries: number;
  expiredEntries: number;
  hitRate: number;
}
