/**
 * Bun HTTP Server implementation
 * Provides the foundation HTTP server with basic routing and middleware support
 */

import { serve } from 'bun';
import type { Server } from 'bun';
import type { Logger } from '@/shared/utils/logger.ts';
import type { Config } from '@/config/schema.ts';

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string>;
  context?: unknown; // Dynamic context added by middleware
}

export interface HttpResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface Middleware {
  (request: HttpRequest, next: () => Promise<HttpResponse>): Promise<HttpResponse>;
}

export interface RouteHandler {
  (request: HttpRequest): Promise<HttpResponse>;
}

export interface Route {
  method: string;
  path: string;
  handler: RouteHandler;
}

export class HttpServer {
  private server: Server | null = null;
  private routes: Map<string, Route> = new Map();
  private middleware: Middleware[] = [];
  private config: Config['server'];
  private logger: Logger;

  constructor(config: Config['server'], logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Add middleware to the request pipeline
   */
  use(middleware: Middleware): void {
    this.middleware.push(middleware);
  }

  /**
   * Register a route handler
   */
  addRoute(method: string, path: string, handler: RouteHandler): void {
    const key = `${method.toUpperCase()}:${path}`;

    this.routes.set(key, { method: method.toUpperCase(), path, handler });
    this.logger.debug(`Registered route: ${method.toUpperCase()} ${path}`);
  }

  /**
   * Add GET route handler
   */
  get(path: string, handler: RouteHandler): void {
    this.addRoute('GET', path, handler);
  }

  /**
   * Add POST route handler
   */
  post(path: string, handler: RouteHandler): void {
    this.addRoute('POST', path, handler);
  }

  /**
   * Add PUT route handler
   */
  put(path: string, handler: RouteHandler): void {
    this.addRoute('PUT', path, handler);
  }

  /**
   * Add DELETE route handler
   */
  delete(path: string, handler: RouteHandler): void {
    this.addRoute('DELETE', path, handler);
  }

  /**
   * Add PATCH route handler
   */
  patch(path: string, handler: RouteHandler): void {
    this.addRoute('PATCH', path, handler);
  }

  /**
   * Start the HTTP server
   */
  async start(): Promise<void> {
    try {
      this.server = serve({
        port: this.config.httpPort,
        fetch: request => this.handleRequest(request),
        error: error => {
          this.logger.error('HTTP server error:', error);

          return new Response('Internal Server Error', { status: 500 });
        },
      });

      this.logger.info(`HTTP server started on port ${this.config.httpPort}`);
    } catch (error) {
      this.logger.error('Failed to start HTTP server:', error);

      // Handle specific error types for better error messages
      if (error instanceof Error && error.message.includes('EADDRINUSE')) {
        throw new Error(`Failed to start server. Is port ${this.config.httpPort} in use?`);
      }

      throw error;
    }
  }

  /**
   * Stop the HTTP server
   */
  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop();
      this.server = null;
      this.logger.info('HTTP server stopped');
    }
  }

  /**
   * Get server status
   */
  isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * Get the actual port the server is running on
   */
  getPort(): number | null {
    return this.server?.port ?? null;
  }

  /**
   * Handle incoming HTTP requests
   */
  private async handleRequest(request: Request): Promise<Response> {
    const startTime = Date.now();
    const url = new URL(request.url);

    try {
      // Convert native Request to our HttpRequest format
      const httpRequest: HttpRequest = {
        method: request.method,
        url: request.url,
        headers: this.headersToRecord(request.headers),
        body: await this.parseBody(request),
        query: this.parseQuery(url.searchParams),
      };

      // Find matching route
      const route = this.findRoute(request.method, url.pathname);

      if (!route) {
        return this.createErrorResponse(404, 'Not Found');
      }

      // Execute middleware chain and route handler
      const response = await this.executeMiddleware(httpRequest, async () => {
        return await route.handler(httpRequest);
      });

      // Convert HttpResponse to native Response
      const nativeResponse = this.createNativeResponse(response);

      // Log the request
      const duration = Date.now() - startTime;

      this.logger.info(`${request.method} ${url.pathname} - ${response.status} (${duration}ms)`);

      return nativeResponse;
    } catch (error) {
      this.logger.error('Request handling error:', error);
      const duration = Date.now() - startTime;

      this.logger.info(`${request.method} ${url.pathname} - 500 (${duration}ms)`);

      return this.createErrorResponse(500, 'Internal Server Error');
    }
  }

  /**
   * Find route handler for method and path
   */
  private findRoute(method: string, path: string): Route | null {
    // Exact match first
    const exactKey = `${method.toUpperCase()}:${path}`;
    const exactRoute = this.routes.get(exactKey);

    if (exactRoute) {
      return exactRoute;
    }

    // Pattern matching for dynamic routes
    for (const [, route] of this.routes) {
      if (route.method !== method.toUpperCase()) continue;

      const pattern = this.createPathPattern(route.path);

      if (pattern.test(path)) {
        return route;
      }
    }

    return null;
  }

  /**
   * Create regex pattern for path matching
   */
  private createPathPattern(path: string): RegExp {
    // Convert path parameters (e.g., "/users/:id" -> "/users/([^/]+)")
    const pattern = path.replace(/:[^/]+/g, '([^/]+)').replace(/\*/g, '.*');

    return new RegExp(`^${pattern}$`);
  }

  /**
   * Execute middleware chain
   */
  private async executeMiddleware(
    request: HttpRequest,
    finalHandler: () => Promise<HttpResponse>
  ): Promise<HttpResponse> {
    let index = 0;

    const next = async (): Promise<HttpResponse> => {
      if (index >= this.middleware.length) {
        return await finalHandler();
      }

      const middleware = this.middleware[index++];

      if (!middleware) {
        throw new Error('Middleware not found at index');
      }

      return await middleware(request, next);
    };

    return await next();
  }

  /**
   * Parse request body based on content type
   */
  private async parseBody(request: Request): Promise<unknown> {
    const contentType = request.headers.get('content-type');

    if (!contentType || request.method === 'GET' || request.method === 'HEAD') {
      return undefined;
    }

    try {
      if (contentType.includes('application/json')) {
        return await request.json();
      }

      if (contentType.includes('text/')) {
        return await request.text();
      }

      if (contentType.includes('application/x-www-form-urlencoded')) {
        const text = await request.text();

        return this.parseFormData(text);
      }

      // Default to text for other content types
      return await request.text();
    } catch (error) {
      this.logger.warn('Failed to parse request body:', error);

      return undefined;
    }
  }

  /**
   * Parse form data string to object
   */
  private parseFormData(data: string): Record<string, string> {
    const params = new URLSearchParams(data);
    const result: Record<string, string> = {};

    for (const [key, value] of params) {
      result[key] = value;
    }

    return result;
  }

  /**
   * Parse URL search parameters to object
   */
  private parseQuery(searchParams: URLSearchParams): Record<string, string> {
    const query: Record<string, string> = {};

    for (const [key, value] of searchParams) {
      query[key] = value;
    }

    return query;
  }

  /**
   * Convert Headers to plain object
   */
  private headersToRecord(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};

    headers.forEach((value, key) => {
      result[key] = value;
    });

    return result;
  }

  /**
   * Create native Response from HttpResponse
   */
  private createNativeResponse(response: HttpResponse): Response {
    let body: BodyInit | undefined;
    const headers = new Headers(response.headers);

    if (response.body !== undefined) {
      if (typeof response.body === 'string') {
        body = response.body;
      } else {
        body = JSON.stringify(response.body);
        headers.set('content-type', 'application/json');
      }
    }

    return new Response(body, {
      status: response.status,
      headers,
    });
  }

  /**
   * Create error response
   */
  private createErrorResponse(status: number, message: string): Response {
    return new Response(JSON.stringify({ error: { code: status, message } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
}
