/**
 * Request Router
 *
 * Intelligent request routing with path matching, parameter extraction,
 * method routing, and wildcard support for the LocalStack GCP emulator.
 */

import type { Logger } from '@/shared/utils/logger.ts';

// Route definition interfaces
export interface RouteDefinition {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly handler: RouteHandler;
  readonly middleware?: RouteMiddleware[];
  readonly parameters?: RouteParameter[];
  readonly metadata?: RouteMetadata;
}

export interface RouteParameter {
  readonly name: string;
  readonly type: ParameterType;
  readonly location: ParameterLocation;
  readonly required: boolean;
  readonly pattern?: string;
  readonly description?: string;
  readonly defaultValue?: unknown;
  readonly validator?: ParameterValidator;
}

export interface RouteMetadata {
  readonly serviceName?: string;
  readonly version?: string;
  readonly operation?: string;
  readonly scopes?: string[];
  readonly rateLimit?: RateLimitConfig;
  readonly cache?: CacheConfig;
  readonly timeout?: number;
}

export interface RateLimitConfig {
  readonly maxRequests: number;
  readonly windowMs: number;
  readonly skipSuccessfulRequests?: boolean;
}

export interface CacheConfig {
  readonly enabled: boolean;
  readonly ttl: number;
  readonly varyBy?: string[];
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
export type ParameterType = 'string' | 'number' | 'boolean' | 'array' | 'object';
export type ParameterLocation = 'path' | 'query' | 'header' | 'body';

export type RouteHandler = (
  request: RouteRequest,
  context: RouteContext
) => Promise<RouteResponse> | RouteResponse;

export type RouteMiddleware = (
  request: RouteRequest,
  context: RouteContext,
  next: () => Promise<RouteResponse> | RouteResponse
) => Promise<RouteResponse> | RouteResponse;

export type ParameterValidator = (value: unknown) => boolean | string;

// Request and response interfaces
export interface RouteRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string | string[]>;
  readonly headers: Record<string, string>;
  readonly params: Record<string, string>;
  readonly body?: unknown;
  readonly originalRequest: Request;
}

export interface RouteContext {
  readonly routeId: string;
  readonly startTime: number;
  readonly metadata: Record<string, unknown>;
  readonly logger: Logger;
}

export interface RouteResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

export interface RouteMatch {
  readonly route: RouteDefinition;
  readonly params: Record<string, string>;
  readonly score: number;
}

export interface RouterConfig {
  readonly enablePathNormalization: boolean;
  readonly caseSensitive: boolean;
  readonly strictTrailingSlash: boolean;
  readonly enableWildcards: boolean;
  readonly maxParams: number;
  readonly enableMetrics: boolean;
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  enablePathNormalization: true,
  caseSensitive: false,
  strictTrailingSlash: false,
  enableWildcards: true,
  maxParams: 50,
  enableMetrics: true,
};

/**
 * Intelligent Request Router
 */
export class RequestRouter {
  private logger: Logger;
  private config: RouterConfig;
  private routes: Map<string, RouteDefinition> = new Map();
  private methodRoutes: Map<HttpMethod, RouteDefinition[]> = new Map();
  private pathTrie: PathTrieNode = new PathTrieNode();
  private metrics: RouterMetrics;

  constructor(logger: Logger, config: Partial<RouterConfig> = {}) {
    this.logger = logger;
    this.config = { ...DEFAULT_ROUTER_CONFIG, ...config };
    this.metrics = this.createMetrics();

    this.initializeMethodMaps();

    this.logger.info('Request Router initialized', {
      pathNormalization: this.config.enablePathNormalization,
      wildcards: this.config.enableWildcards,
      caseSensitive: this.config.caseSensitive,
    });
  }

  /**
   * Register a route
   */
  addRoute(route: RouteDefinition): void {
    // Validate route
    this.validateRoute(route);

    // Normalize path if enabled
    const normalizedPath = this.config.enablePathNormalization
      ? this.normalizePath(route.path)
      : route.path;

    const normalizedRoute = {
      ...route,
      path: normalizedPath,
    };

    // Store route
    this.routes.set(route.id, normalizedRoute);

    // Add to method-specific index
    if (!this.methodRoutes.has(route.method)) {
      this.methodRoutes.set(route.method, []);
    }

    const methodRoutes = this.methodRoutes.get(route.method);

    if (methodRoutes) {
      methodRoutes.push(normalizedRoute);
    }

    // Add to path trie for fast lookups
    this.addToTrie(normalizedRoute);

    this.logger.debug(`Route registered: ${route.method} ${normalizedPath}`, {
      routeId: route.id,
      hasMiddleware: (route.middleware?.length || 0) > 0,
      hasParameters: (route.parameters?.length || 0) > 0,
    });

    if (this.config.enableMetrics) {
      this.metrics.totalRoutes++;
    }
  }

  /**
   * Remove a route
   */
  removeRoute(routeId: string): boolean {
    const route = this.routes.get(routeId);

    if (!route) {
      return false;
    }

    // Remove from main registry
    this.routes.delete(routeId);

    // Remove from method index
    const methodRoutes = this.methodRoutes.get(route.method);

    if (methodRoutes) {
      const index = methodRoutes.findIndex(r => r.id === routeId);

      if (index !== -1) {
        methodRoutes.splice(index, 1);
      }
    }

    // Remove from trie (simple implementation - rebuild trie)
    this.rebuildTrie();

    this.logger.debug(`Route removed: ${route.method} ${route.path}`, {
      routeId,
    });

    if (this.config.enableMetrics) {
      this.metrics.totalRoutes--;
    }

    return true;
  }

  /**
   * Route a request to the appropriate handler
   */
  async route(request: Request): Promise<Response> {
    const startTime = Date.now();

    try {
      // Parse request
      const routeRequest = await this.parseRequest(request);

      // Find matching route
      const match = this.findRoute(routeRequest);

      if (!match) {
        this.recordMetric('notFound');

        return this.createErrorResponse(
          404,
          'Not Found',
          `No route found for ${routeRequest.method} ${routeRequest.path}`
        );
      }

      // Create route context
      const context: RouteContext = {
        routeId: match.route.id,
        startTime: Date.now(),
        metadata: {
          matchScore: match.score,
          params: match.params,
        },
        logger: this.logger.child({ routeId: match.route.id }),
      };

      // Update request with extracted parameters
      const requestWithParams = {
        ...routeRequest,
        params: match.params,
      };

      // Execute route with middleware chain
      const response = await this.executeRoute(match.route, requestWithParams, context);

      this.recordMetric('success');

      return this.createHttpResponse(response);
    } catch (error) {
      const err = error as Error;

      this.logger.error('Route execution error', {
        error: err.message,
        stack: err.stack,
        path: request.url,
        method: request.method,
      });

      this.recordMetric('error');

      return this.createErrorResponse(
        500,
        'Internal Server Error',
        'An error occurred processing the request'
      );
    } finally {
      if (this.config.enableMetrics) {
        const responseTime = Date.now() - startTime;

        this.metrics.totalRequests++;
        this.metrics.averageResponseTime = this.updateAverageResponseTime(responseTime);
      }
    }
  }

  /**
   * Get route by ID
   */
  getRoute(routeId: string): RouteDefinition | null {
    return this.routes.get(routeId) || null;
  }

  /**
   * Get all routes
   */
  getAllRoutes(): RouteDefinition[] {
    return Array.from(this.routes.values());
  }

  /**
   * Get routes by method
   */
  getRoutesByMethod(method: HttpMethod): RouteDefinition[] {
    return this.methodRoutes.get(method) || [];
  }

  /**
   * Get router metrics
   */
  getMetrics(): RouterMetrics {
    return { ...this.metrics };
  }

  /**
   * Clear all routes
   */
  clear(): void {
    this.routes.clear();
    this.methodRoutes.clear();

    for (const method of [
      'GET',
      'POST',
      'PUT',
      'DELETE',
      'PATCH',
      'HEAD',
      'OPTIONS',
    ] as HttpMethod[]) {
      this.methodRoutes.set(method, []);
    }

    this.pathTrie = new PathTrieNode();

    if (this.config.enableMetrics) {
      this.metrics.totalRoutes = 0;
    }

    this.logger.debug('All routes cleared');
  }

  /**
   * Initialize method route maps
   */
  private initializeMethodMaps(): void {
    const methods: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

    for (const method of methods) {
      this.methodRoutes.set(method, []);
    }
  }

  /**
   * Validate route definition
   */
  private validateRoute(route: RouteDefinition): void {
    if (!route.id) {
      throw new Error('Route ID is required');
    }

    if (!route.method) {
      throw new Error('Route method is required');
    }

    if (!route.path) {
      throw new Error('Route path is required');
    }

    if (!route.handler || typeof route.handler !== 'function') {
      throw new Error('Route handler is required and must be a function');
    }

    if (this.routes.has(route.id)) {
      throw new Error(`Route with ID '${route.id}' already exists`);
    }

    // Validate parameters
    if (route.parameters) {
      if (route.parameters.length > this.config.maxParams) {
        throw new Error(`Too many parameters. Maximum allowed: ${this.config.maxParams}`);
      }

      for (const param of route.parameters) {
        if (!param.name) {
          throw new Error('Parameter name is required');
        }
      }
    }

    // Validate path syntax
    this.validatePathSyntax(route.path);
  }

  /**
   * Validate path syntax
   */
  private validatePathSyntax(path: string): void {
    // Check for valid path format
    if (!path.startsWith('/')) {
      throw new Error('Path must start with /');
    }

    // Validate parameter syntax
    const paramRegex = /\{([^}]*)\}/g;
    let match;

    while ((match = paramRegex.exec(path)) !== null) {
      const paramSpec = match[1];

      // Check for empty parameter
      if (!paramSpec || paramSpec.trim() === '') {
        throw new Error('Empty parameter name');
      }

      // Handle parameter with pattern (e.g., {name=pattern})
      if (paramSpec.includes('=')) {
        const [paramName, pattern] = paramSpec.split('=', 2);

        if (!paramName || paramName.trim() === '' || !pattern || pattern.trim() === '') {
          throw new Error(`Invalid parameter syntax: {${paramSpec}}`);
        }

        // Validate pattern syntax - but only for complex patterns
        if (pattern.includes('(') || pattern.includes('[')) {
          try {
            new RegExp(pattern);
          } catch {
            throw new Error(`Invalid parameter pattern: ${pattern}`);
          }
        }
      }
    }
  }

  /**
   * Normalize path
   */
  private normalizePath(path: string): string {
    // Remove duplicate slashes
    let normalized = path.replace(/\/+/g, '/');

    // Remove trailing slash unless it's the root
    if (normalized.length > 1 && normalized.endsWith('/') && !this.config.strictTrailingSlash) {
      normalized = normalized.slice(0, -1);
    }

    // Convert to lowercase if not case sensitive
    if (!this.config.caseSensitive) {
      // Only normalize static path segments, preserve parameter names
      normalized = normalized.replace(/\/([^/{}]+)/g, (match, segment) => {
        // Don't lowercase segments that are parameter values (this is for route templates)
        if (segment.includes('{') || segment.includes('}')) {
          return match;
        }

        return `/${segment.toLowerCase()}`;
      });
    }

    return normalized;
  }

  /**
   * Parse incoming request
   */
  private async parseRequest(request: Request): Promise<RouteRequest> {
    const url = new URL(request.url);

    // Parse query parameters
    const query: Record<string, string | string[]> = {};

    for (const [key, value] of url.searchParams.entries()) {
      if (query[key]) {
        // Handle multiple values for the same parameter
        if (Array.isArray(query[key])) {
          (query[key] as string[]).push(value);
        } else {
          query[key] = [query[key] as string, value];
        }
      } else {
        query[key] = value;
      }
    }

    // Parse headers
    const headers: Record<string, string> = {};

    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Parse body for non-GET requests
    let body: unknown;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const contentType = headers['content-type'] || headers['Content-Type'] || '';

      try {
        if (contentType.includes('application/json')) {
          body = await request.json();
        } else if (contentType.includes('application/x-www-form-urlencoded')) {
          body = Object.fromEntries(new URLSearchParams(await request.text()));
        } else if (contentType.includes('multipart/form-data')) {
          body = await request.formData();
        } else {
          body = await request.text();
        }
      } catch {
        // If body parsing fails, leave as undefined
      }
    }

    return {
      method: request.method.toUpperCase(),
      path: this.config.enablePathNormalization ? this.normalizePath(url.pathname) : url.pathname,
      query,
      headers,
      params: {}, // Will be populated by route matching
      body,
      originalRequest: request,
    };
  }

  /**
   * Find matching route for request
   */
  private findRoute(request: RouteRequest): RouteMatch | null {
    const methodRoutes = this.methodRoutes.get(request.method as HttpMethod);

    if (!methodRoutes || methodRoutes.length === 0) {
      return null;
    }

    let bestMatch: RouteMatch | null = null;
    let bestScore = -1;

    for (const route of methodRoutes) {
      const match = this.matchRoute(route, request);

      if (match && match.score > bestScore) {
        bestMatch = match;
        bestScore = match.score;
      }
    }

    return bestMatch;
  }

  /**
   * Match a specific route against request
   */
  private matchRoute(route: RouteDefinition, request: RouteRequest): RouteMatch | null {
    const { params, score } = this.matchPath(route.path, request.path);

    if (score === -1) {
      return null;
    }

    return {
      route,
      params,
      score,
    };
  }

  /**
   * Match path and extract parameters
   */
  private matchPath(
    routePath: string,
    requestPath: string
  ): { params: Record<string, string>; score: number } {
    const params: Record<string, string> = {};

    // Convert route path to regex pattern
    const { pattern, paramNames } = this.pathToRegex(routePath);

    const match = pattern.exec(requestPath);

    if (!match) {
      return { params: {}, score: -1 };
    }

    // Extract parameters
    for (let i = 0; i < paramNames.length; i++) {
      const paramValue = match[i + 1];
      const paramName = paramNames[i];

      if (paramValue !== undefined && paramName !== undefined) {
        params[paramName] = paramValue;
      }
    }

    // Calculate match score (higher score = better match)
    // Exact matches score higher than parameterized matches
    const staticSegments = routePath.split('/').filter(segment => !segment.includes('{')).length;
    const totalSegments = routePath.split('/').length;

    const score = (staticSegments / totalSegments) * 100;

    return { params, score };
  }

  /**
   * Convert path to regex pattern
   */
  private pathToRegex(path: string): { pattern: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];

    // First, escape special regex characters except our parameter markers
    let pattern = path.replace(/[.+?^$|[\]\\]/g, '\\$&');

    // Replace parameters with regex groups
    pattern = pattern.replace(/\{([^}]+)\}/g, (match, paramSpec) => {
      let paramName: string;
      let paramPattern = '[^/]+'; // Default pattern

      if (paramSpec.includes('=')) {
        [paramName, paramPattern] = paramSpec.split('=', 2);
      } else {
        paramName = paramSpec;
      }

      paramNames.push(paramName);

      return `(${paramPattern})`;
    });

    // Handle wildcards if enabled
    if (this.config.enableWildcards) {
      // Sequential wildcard processing to avoid negative lookbehind performance issues
      // Step 1: Replace ** with a unique placeholder
      const DOUBLE_WILDCARD_PLACEHOLDER = '__DOUBLE_WILDCARD__';

      pattern = pattern.replace(/\*\*/g, DOUBLE_WILDCARD_PLACEHOLDER);

      // Step 2: Replace remaining single * patterns
      pattern = pattern.replace(/\*/g, '([^/]+)');

      // Step 3: Restore double wildcards with their regex pattern
      pattern = pattern.replace(new RegExp(DOUBLE_WILDCARD_PLACEHOLDER, 'g'), '(.*)');
    }

    // Add anchors
    pattern = `^${pattern}$`;

    return {
      pattern: new RegExp(pattern, this.config.caseSensitive ? '' : 'i'),
      paramNames,
    };
  }

  /**
   * Execute route with middleware chain
   */
  private async executeRoute(
    route: RouteDefinition,
    request: RouteRequest,
    context: RouteContext
  ): Promise<RouteResponse> {
    // Build middleware chain
    const middlewares = route.middleware || [];
    let index = 0;

    const next = async (): Promise<RouteResponse> => {
      if (index < middlewares.length) {
        const middleware = middlewares[index++];

        if (middleware) {
          return await middleware(request, context, next);
        }

        // If middleware is undefined, continue to next
        return await next();
      } else {
        // Execute the actual route handler
        return await route.handler(request, context);
      }
    };

    return await next();
  }

  /**
   * Add route to path trie for fast lookups
   */
  private addToTrie(route: RouteDefinition): void {
    const segments = route.path.split('/').filter(Boolean);
    let current = this.pathTrie;

    for (const segment of segments) {
      if (!current.children.has(segment)) {
        current.children.set(segment, new PathTrieNode());
      }

      const childNode = current.children.get(segment);

      if (childNode) {
        current = childNode;
      }
    }

    if (!current.routes.has(route.method)) {
      current.routes.set(route.method, []);
    }

    const routeList = current.routes.get(route.method);

    if (routeList) {
      routeList.push(route);
    }
  }

  /**
   * Rebuild path trie from current routes
   */
  private rebuildTrie(): void {
    this.pathTrie = new PathTrieNode();

    for (const route of this.routes.values()) {
      this.addToTrie(route);
    }
  }

  /**
   * Create HTTP response from route response
   */
  private createHttpResponse(routeResponse: RouteResponse): Response {
    const headers = new Headers(routeResponse.headers);

    if (!headers.has('Content-Type') && routeResponse.body) {
      if (typeof routeResponse.body === 'object') {
        headers.set('Content-Type', 'application/json');
      } else {
        headers.set('Content-Type', 'text/plain');
      }
    }

    let body: BodyInit | null = null;

    if (routeResponse.body !== undefined) {
      if (typeof routeResponse.body === 'object') {
        body = JSON.stringify(routeResponse.body);
      } else {
        body = String(routeResponse.body);
      }
    }

    return new Response(body, {
      status: routeResponse.status,
      headers,
    });
  }

  /**
   * Create error response
   */
  private createErrorResponse(status: number, title: string, detail: string): Response {
    const errorBody = {
      error: {
        code: status,
        message: title,
        details: detail,
      },
    };

    return new Response(JSON.stringify(errorBody, null, 2), {
      status,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Record router metric
   */
  private recordMetric(type: 'success' | 'error' | 'notFound'): void {
    if (!this.config.enableMetrics) {
      return;
    }

    switch (type) {
      case 'success':
        this.metrics.successfulRequests++;
        break;
      case 'error':
        this.metrics.errorRequests++;
        break;
      case 'notFound':
        this.metrics.notFoundRequests++;
        break;
    }
  }

  /**
   * Update average response time
   */
  private updateAverageResponseTime(responseTime: number): number {
    const currentAverage = this.metrics.averageResponseTime || 0;
    const totalRequests = this.metrics.totalRequests;

    // Ensure minimum response time for metrics (sub-millisecond operations)
    const measuredTime = Math.max(responseTime, 0.1);

    if (totalRequests === 1) {
      return measuredTime;
    }

    return (currentAverage * (totalRequests - 1) + measuredTime) / totalRequests;
  }

  /**
   * Create initial metrics object
   */
  private createMetrics(): RouterMetrics {
    return {
      totalRoutes: 0,
      totalRequests: 0,
      successfulRequests: 0,
      errorRequests: 0,
      notFoundRequests: 0,
      averageResponseTime: 0,
    };
  }
}

// Path trie for fast route lookups
class PathTrieNode {
  children: Map<string, PathTrieNode> = new Map();
  routes: Map<HttpMethod, RouteDefinition[]> = new Map();
}

// Router metrics interface
export interface RouterMetrics {
  totalRoutes: number;
  totalRequests: number;
  successfulRequests: number;
  errorRequests: number;
  notFoundRequests: number;
  averageResponseTime: number;
}

// Utility functions for route creation
export const createRoute = {
  get: (
    path: string,
    handler: RouteHandler,
    options?: Partial<RouteDefinition>
  ): RouteDefinition => ({
    id: options?.id || `GET:${path}`,
    method: 'GET',
    path,
    handler,
    ...options,
  }),

  post: (
    path: string,
    handler: RouteHandler,
    options?: Partial<RouteDefinition>
  ): RouteDefinition => ({
    id: options?.id || `POST:${path}`,
    method: 'POST',
    path,
    handler,
    ...options,
  }),

  put: (
    path: string,
    handler: RouteHandler,
    options?: Partial<RouteDefinition>
  ): RouteDefinition => ({
    id: options?.id || `PUT:${path}`,
    method: 'PUT',
    path,
    handler,
    ...options,
  }),

  delete: (
    path: string,
    handler: RouteHandler,
    options?: Partial<RouteDefinition>
  ): RouteDefinition => ({
    id: options?.id || `DELETE:${path}`,
    method: 'DELETE',
    path,
    handler,
    ...options,
  }),

  patch: (
    path: string,
    handler: RouteHandler,
    options?: Partial<RouteDefinition>
  ): RouteDefinition => ({
    id: options?.id || `PATCH:${path}`,
    method: 'PATCH',
    path,
    handler,
    ...options,
  }),
};
