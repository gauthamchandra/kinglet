/**
 * Shared type definitions for LocalStack GCP Emulator
 */

// Core service interfaces
export interface ServiceModule {
  name: string;
  version: string;
  discoveryDocument: DiscoveryDocument;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  registerRoutes(router: Router): void;
}

export interface DiscoveryDocument {
  kind: string;
  discoveryVersion: string;
  id: string;
  name: string;
  version: string;
  title: string;
  description: string;
  baseUrl: string;
  basePath: string;
  rootUrl: string;
  servicePath: string;
  resources: Record<string, unknown>;
  schemas: Record<string, unknown>;
}

export interface Router {
  get(path: string, handler: RequestHandler): void;
  post(path: string, handler: RequestHandler): void;
  put(path: string, handler: RequestHandler): void;
  patch(path: string, handler: RequestHandler): void;
  delete(path: string, handler: RequestHandler): void;
}

export type RequestHandler = (request: Request, context: RequestContext) => Promise<Response>;

export interface RequestContext {
  params: Record<string, string>;
  query: Record<string, string>;
  body?: unknown;
  user?: AuthContext;
}

export interface AuthContext {
  authenticated: boolean;
  projectId: string;
  serviceAccount?: string;
}

// Configuration interfaces
export interface Config {
  server: ServerConfig;
  storage: StorageConfig;
  auth: AuthConfig;
  services: ServicesConfig;
  logging: LoggingConfig;
}

export interface ServerConfig {
  httpPort: number;
  grpcPort: number;
  maxConnections: number;
}

export interface StorageConfig {
  type: 'memory' | 'sqlite' | 'hybrid';
  sqlitePath?: string;
  cacheSize: number;
}

export interface AuthConfig {
  enabled: boolean;
  mode: 'bypass' | 'mock' | 'validate';
  mockCredentials?: {
    projectId: string;
    serviceAccount: string;
  };
}

export interface ServicesConfig {
  pubsub: { enabled: boolean };
  scheduler: { enabled: boolean };
  tasks: { enabled: boolean };
  secrets: { enabled: boolean };
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  format: 'json' | 'pretty';
}

// Health check interfaces
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  uptime: number;
  services: Record<string, ServiceHealth>;
  checks: HealthCheck[];
}

export interface ServiceHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
}

export interface HealthCheck {
  name: string;
  status: 'pass' | 'fail';
  message?: string;
}

// Error handling
export interface ErrorResponse {
  error: {
    code: number;
    message: string;
    status: string;
    details?: Array<{
      '@type': string;
      [key: string]: unknown;
    }>;
  };
}

// Storage interfaces
export interface StorageProvider {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttl?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  query<T>(table: string, conditions: QueryConditions): Promise<T[]>;
  transaction<T>(operations: Operation[]): Promise<T>;
}

export interface QueryConditions {
  where?: Record<string, unknown>;
  orderBy?: string;
  limit?: number;
  offset?: number;
}

export interface Operation {
  type: 'get' | 'set' | 'delete';
  key: string;
  value?: unknown;
}
