/**
 * Validation Layer
 *
 * Comprehensive request validation with Zod integration, custom validators,
 * request sanitization, and quota checking for the LocalStack GCP emulator.
 */

import { z } from 'zod';
import type { Logger } from '@/shared/utils/logger.ts';

// Validation configuration and interfaces
export interface ValidationConfig {
  readonly sanitization: SanitizationConfig;
  readonly quotas: QuotaConfig;
  readonly customValidators: CustomValidatorConfig;
  readonly errorHandling: ErrorHandlingConfig;
}

export interface SanitizationConfig {
  readonly enabled: boolean;
  readonly removeHtml: boolean;
  readonly normalizePaths: boolean;
  readonly trimStrings: boolean;
  readonly sanitizeHeaders: boolean;
  readonly maxStringLength: number;
  readonly maxArrayLength: number;
  readonly maxObjectDepth: number;
}

export interface QuotaConfig {
  readonly enabled: boolean;
  readonly windowMs: number;
  readonly storage: QuotaStorageType;
  readonly defaultLimits: QuotaLimits;
  readonly customLimits: Map<string, QuotaLimits>;
}

export interface QuotaLimits {
  readonly requests: number;
  readonly bandwidth: number; // bytes
  readonly operations: Record<string, number>;
}

export interface CustomValidatorConfig {
  readonly enabled: boolean;
  readonly validators: Map<string, CustomValidator>;
  readonly strictMode: boolean;
}

export interface ErrorHandlingConfig {
  readonly includeDetails: boolean;
  readonly sanitizeErrors: boolean;
  readonly maxErrorDepth: number;
}

export type QuotaStorageType = 'memory' | 'redis' | 'database';

export const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  sanitization: {
    enabled: true,
    removeHtml: true,
    normalizePaths: true,
    trimStrings: true,
    sanitizeHeaders: true,
    maxStringLength: 10000,
    maxArrayLength: 1000,
    maxObjectDepth: 10,
  },
  quotas: {
    enabled: true,
    windowMs: 60000, // 1 minute
    storage: 'memory',
    defaultLimits: {
      requests: 1000,
      bandwidth: 10 * 1024 * 1024, // 10MB
      operations: {
        read: 10000,
        write: 1000,
        delete: 100,
      },
    },
    customLimits: new Map(),
  },
  customValidators: {
    enabled: true,
    validators: new Map(),
    strictMode: false,
  },
  errorHandling: {
    includeDetails: true,
    sanitizeErrors: true,
    maxErrorDepth: 5,
  },
};

// Validation request and response interfaces
export interface ValidationRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, unknown>;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
  readonly clientId: string;
  readonly operation: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly sanitized?: ValidationRequest;
  readonly errors: ValidationFieldError[];
  readonly warnings: ValidationWarning[];
  readonly quotaInfo?: QuotaInfo;
}

export interface ValidationFieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
  readonly value?: unknown;
  readonly constraint?: unknown;
}

export interface ValidationWarning {
  readonly field: string;
  readonly code: string;
  readonly message: string;
  readonly suggestion?: string;
}

export interface QuotaInfo {
  readonly clientId: string;
  readonly remaining: QuotaLimits;
  readonly resetTime: Date;
  readonly exceeded: boolean;
}

export interface ValidationSchema {
  readonly name: string;
  readonly schema: z.ZodSchema;
  readonly sanitizers?: SanitizerFunction[];
  readonly customValidators?: CustomValidator[];
}

export type SanitizerFunction = (value: unknown) => unknown;
export type CustomValidator = (
  value: unknown,
  context: ValidationContext
) => ValidationFieldError | null;

export interface ValidationContext {
  readonly path: string[];
  readonly method: string;
  readonly clientId: string;
  readonly operation: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * Comprehensive Validation Layer
 */
export class ValidationLayer {
  private logger: Logger;
  private config: ValidationConfig;
  private schemas: Map<string, ValidationSchema> = new Map();
  private quotaStorage: QuotaStorage;
  private sanitizers: Map<string, SanitizerFunction> = new Map();

  constructor(logger: Logger, config: Partial<ValidationConfig> = {}) {
    this.logger = logger;
    this.config = { ...DEFAULT_VALIDATION_CONFIG, ...config };
    this.quotaStorage = this.createQuotaStorage();

    this.initializeBuiltInSanitizers();
    this.initializeBuiltInValidators();

    this.logger.info('Validation Layer initialized', {
      sanitization: this.config.sanitization.enabled,
      quotas: this.config.quotas.enabled,
      customValidators: this.config.customValidators.enabled,
    });
  }

  /**
   * Validate request with full validation pipeline
   */
  async validate(request: ValidationRequest): Promise<ValidationResult> {
    const startTime = Date.now();
    const errors: ValidationFieldError[] = [];
    const warnings: ValidationWarning[] = [];

    this.logger.debug('Validating request', {
      method: request.method,
      path: request.path,
      operation: request.operation,
      clientId: request.clientId,
    });

    try {
      // 1. Check quotas first (fail fast)
      let quotaInfo: QuotaInfo | undefined;

      if (this.config.quotas.enabled) {
        quotaInfo = await this.checkQuotas(request);

        if (quotaInfo.exceeded) {
          errors.push({
            field: 'quota',
            code: 'QUOTA_EXCEEDED',
            message: 'Request quota exceeded',
            constraint: quotaInfo.remaining,
          });

          return {
            valid: false,
            errors,
            warnings,
            quotaInfo,
          };
        }
      }

      // 2. Additional validation rules (before sanitization to preserve original types)
      const additionalErrors = this.validateAdditionalRules(request);

      errors.push(...additionalErrors);

      // 3. Sanitize request
      let sanitizedRequest = request;

      if (this.config.sanitization.enabled) {
        sanitizedRequest = this.sanitizeRequest(request);
      }

      // 4. Schema validation
      const schemaErrors = this.validateWithSchema(sanitizedRequest);

      errors.push(...schemaErrors);

      // 5. Custom validation
      if (this.config.customValidators.enabled) {
        const customErrors = await this.runCustomValidators(sanitizedRequest);

        errors.push(...customErrors);
      }

      const valid = errors.length === 0;

      const result: ValidationResult = {
        valid,
        errors,
        warnings,
        ...(valid && { sanitized: sanitizedRequest }),
        ...(quotaInfo && { quotaInfo }),
      };

      this.logger.debug('Validation completed', {
        valid,
        errorCount: errors.length,
        warningCount: warnings.length,
        responseTime: Date.now() - startTime,
      });

      return result;
    } catch (error) {
      const err = error as Error;

      this.logger.error('Validation failed', {
        error: err.message,
        clientId: request.clientId,
      });

      errors.push({
        field: 'validation',
        code: 'VALIDATION_ERROR',
        message: 'Internal validation error',
      });

      return {
        valid: false,
        errors,
        warnings,
      };
    }
  }

  /**
   * Register validation schema
   */
  registerSchema(schema: ValidationSchema): void {
    this.schemas.set(schema.name, schema);

    this.logger.debug(`Validation schema registered: ${schema.name}`);
  }

  /**
   * Register custom sanitizer
   */
  registerSanitizer(name: string, sanitizer: SanitizerFunction): void {
    this.sanitizers.set(name, sanitizer);

    this.logger.debug(`Sanitizer registered: ${name}`);
  }

  /**
   * Register custom validator
   */
  registerValidator(name: string, validator: CustomValidator): void {
    this.config.customValidators.validators.set(name, validator);

    this.logger.debug(`Custom validator registered: ${name}`);
  }

  /**
   * Update quota limits for client
   */
  updateQuotaLimits(clientId: string, limits: QuotaLimits): void {
    this.config.quotas.customLimits.set(clientId, limits);

    this.logger.debug(`Quota limits updated for client: ${clientId}`);
  }

  /**
   * Get validation statistics
   */
  getStats(): ValidationStats {
    return {
      registeredSchemas: this.schemas.size,
      customValidators: this.config.customValidators.validators.size,
      sanitizers: this.sanitizers.size,
      quotaEnabled: this.config.quotas.enabled,
    };
  }

  /**
   * Reset quota storage (useful for testing)
   */
  async resetQuotaStorage(): Promise<void> {
    if (this.quotaStorage instanceof MemoryQuotaStorage) {
      await this.quotaStorage.clearAll();
    }
  }

  /**
   * Sanitize request data
   */
  private sanitizeRequest(request: ValidationRequest): ValidationRequest {
    const sanitized = { ...request };

    // Sanitize query parameters
    if (sanitized.query) {
      sanitized.query = this.sanitizeValue(sanitized.query, ['query']) as Record<string, unknown>;
    }

    // Sanitize headers
    if (this.config.sanitization.sanitizeHeaders && sanitized.headers) {
      const sanitizedHeaders: Record<string, string> = {};

      for (const [key, value] of Object.entries(sanitized.headers)) {
        const sanitizedKey = this.sanitizeString(key);
        const sanitizedValue =
          typeof value === 'string' ? this.sanitizeString(value) : String(value);

        sanitizedHeaders[sanitizedKey] = sanitizedValue;
      }

      sanitized.headers = sanitizedHeaders;
    }

    // Sanitize body
    if (sanitized.body) {
      sanitized.body = this.sanitizeValue(sanitized.body, ['body']);
    }

    // Normalize path
    if (this.config.sanitization.normalizePaths) {
      sanitized.path = this.normalizePath(sanitized.path);
    }

    return sanitized;
  }

  /**
   * Sanitize any value recursively
   */
  private sanitizeValue(value: unknown, path: string[], depth = 0): unknown {
    if (depth > this.config.sanitization.maxObjectDepth) {
      return '[Object too deep]';
    }

    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      return this.sanitizeString(value);
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (Array.isArray(value)) {
      if (value.length > this.config.sanitization.maxArrayLength) {
        return value.slice(0, this.config.sanitization.maxArrayLength);
      }

      return value.map((item, index) =>
        this.sanitizeValue(item, [...path, String(index)], depth + 1)
      );
    }

    if (typeof value === 'object') {
      const sanitized: Record<string, unknown> = {};

      for (const [key, val] of Object.entries(value)) {
        const sanitizedKey = this.sanitizeString(key);

        sanitized[sanitizedKey] = this.sanitizeValue(val, [...path, key], depth + 1);
      }

      return sanitized;
    }

    return String(value);
  }

  /**
   * Sanitize string value
   */
  private sanitizeString(value: string): string {
    let sanitized = value;

    // Trim whitespace
    if (this.config.sanitization.trimStrings) {
      sanitized = sanitized.trim();
    }

    // Remove HTML tags and their content
    if (this.config.sanitization.removeHtml) {
      sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
      sanitized = sanitized.replace(/<[^>]*>/g, '');
    }

    // Limit string length
    if (sanitized.length > this.config.sanitization.maxStringLength) {
      sanitized = sanitized.substring(0, this.config.sanitization.maxStringLength);
    }

    return sanitized;
  }

  /**
   * Normalize path
   */
  private normalizePath(path: string): string {
    // Remove duplicate slashes
    let normalized = path.replace(/\/+/g, '/');

    // Remove trailing slash except for root
    if (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }

    // Decode URI components safely
    try {
      normalized = decodeURIComponent(normalized);
    } catch {
      // Keep original if decoding fails
    }

    return normalized;
  }

  /**
   * Validate with registered schemas
   */
  private validateWithSchema(request: ValidationRequest): ValidationFieldError[] {
    const errors: ValidationFieldError[] = [];

    // Find applicable schemas
    const schemaName = this.determineSchemaName(request);
    const schema = this.schemas.get(schemaName);

    if (!schema) {
      // No specific schema found, use generic validation
      return this.validateGenericRequest(request);
    }

    try {
      // Validate with Zod schema
      schema.schema.parse(request);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorList = error.issues;

        for (const issue of errorList) {
          errors.push({
            field: issue.path.join('.') || 'root',
            code: issue.code.toUpperCase(),
            message: issue.message,
            value: 'received' in issue ? issue.received : undefined,
            constraint: 'expected' in issue ? issue.expected : undefined,
          });
        }
      } else {
        errors.push({
          field: 'schema',
          code: 'SCHEMA_ERROR',
          message: 'Schema validation failed',
        });
      }
    }

    return errors;
  }

  /**
   * Determine schema name from request
   */
  private determineSchemaName(request: ValidationRequest): string {
    // Simple heuristic - could be made more sophisticated
    const segments = request.path.split('/').filter(Boolean);

    if (segments.length >= 2) {
      return `${segments[0]}-${request.method.toLowerCase()}`;
    }

    return 'generic';
  }

  /**
   * Generic request validation
   */
  private validateGenericRequest(request: ValidationRequest): ValidationFieldError[] {
    const errors: ValidationFieldError[] = [];

    // Validate required fields
    if (!request.method) {
      errors.push({
        field: 'method',
        code: 'REQUIRED',
        message: 'HTTP method is required',
      });
    }

    if (!request.path) {
      errors.push({
        field: 'path',
        code: 'REQUIRED',
        message: 'Request path is required',
      });
    }

    if (!request.clientId) {
      errors.push({
        field: 'clientId',
        code: 'REQUIRED',
        message: 'Client ID is required',
      });
    }

    // Validate HTTP method
    const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

    if (request.method && !validMethods.includes(request.method.toUpperCase())) {
      errors.push({
        field: 'method',
        code: 'INVALID',
        message: 'Invalid HTTP method',
        value: request.method,
        constraint: validMethods,
      });
    }

    return errors;
  }

  /**
   * Run custom validators
   */
  private async runCustomValidators(request: ValidationRequest): Promise<ValidationFieldError[]> {
    const errors: ValidationFieldError[] = [];
    const context: ValidationContext = {
      path: request.path.split('/').filter(Boolean),
      method: request.method,
      clientId: request.clientId,
      operation: request.operation,
      metadata: request.metadata || {},
    };

    for (const [name, validator] of this.config.customValidators.validators.entries()) {
      try {
        const error = validator(request, context);

        if (error) {
          errors.push(error);
        }
      } catch (err) {
        const error = err as Error;

        this.logger.warn(`Custom validator '${name}' failed`, {
          error: error.message,
          clientId: request.clientId,
        });

        if (this.config.customValidators.strictMode) {
          errors.push({
            field: 'validation',
            code: 'CUSTOM_VALIDATOR_ERROR',
            message: `Custom validator '${name}' failed`,
          });
        }
      }
    }

    return errors;
  }

  /**
   * Validate additional rules
   */
  private validateAdditionalRules(request: ValidationRequest): ValidationFieldError[] {
    const errors: ValidationFieldError[] = [];

    // Validate path format
    if (!request.path.startsWith('/')) {
      errors.push({
        field: 'path',
        code: 'INVALID_FORMAT',
        message: 'Path must start with /',
        value: request.path,
      });
    }

    // Validate headers format
    if (request.headers) {
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value !== 'string') {
          errors.push({
            field: `headers.${key}`,
            code: 'INVALID_TYPE',
            message: 'Header value must be a string',
            value: typeof value,
          });
        }
      }
    }

    return errors;
  }

  /**
   * Check request quotas
   */
  private async checkQuotas(request: ValidationRequest): Promise<QuotaInfo> {
    const clientLimits =
      this.config.quotas.customLimits.get(request.clientId) || this.config.quotas.defaultLimits;

    const usage = await this.quotaStorage.getUsage(request.clientId);

    // Record current request usage first
    const newUsage = {
      requests: 1,
      bandwidth: this.estimateRequestSize(request),
      operations: { [request.operation]: 1 },
    };

    // Calculate what usage will be after this request
    const projectedUsage = {
      requests: usage.requests + newUsage.requests,
      bandwidth: usage.bandwidth + newUsage.bandwidth,
      operations: { ...usage.operations },
    };

    for (const [op, count] of Object.entries(newUsage.operations)) {
      projectedUsage.operations[op] = (projectedUsage.operations[op] || 0) + count;
    }

    // Check if this request would exceed quotas
    const exceeded =
      projectedUsage.requests > clientLimits.requests ||
      projectedUsage.bandwidth > clientLimits.bandwidth ||
      Object.entries(projectedUsage.operations).some(
        ([op, count]) => count > (clientLimits.operations[op] || 0)
      );

    // Record usage only if not exceeded
    if (!exceeded) {
      await this.quotaStorage.recordUsage(request.clientId, newUsage);
    }

    // Calculate remaining quotas after recording usage
    const finalUsage = exceeded ? usage : projectedUsage;
    const remaining: QuotaLimits = {
      requests: Math.max(0, clientLimits.requests - finalUsage.requests),
      bandwidth: Math.max(0, clientLimits.bandwidth - finalUsage.bandwidth),
      operations: {},
    };

    for (const [op, limit] of Object.entries(clientLimits.operations)) {
      remaining.operations[op] = Math.max(0, limit - (finalUsage.operations[op] || 0));
    }

    return {
      clientId: request.clientId,
      remaining,
      resetTime: new Date(Date.now() + this.config.quotas.windowMs),
      exceeded,
    };
  }

  /**
   * Estimate request size in bytes
   */
  private estimateRequestSize(request: ValidationRequest): number {
    let size = 0;

    // Estimate path size
    size += Buffer.byteLength(request.path, 'utf8');

    // Estimate query size
    if (request.query) {
      size += Buffer.byteLength(JSON.stringify(request.query), 'utf8');
    }

    // Estimate headers size
    for (const [key, value] of Object.entries(request.headers)) {
      size += Buffer.byteLength(`${key}: ${value}`, 'utf8');
    }

    // Estimate body size
    if (request.body) {
      if (typeof request.body === 'string') {
        size += Buffer.byteLength(request.body, 'utf8');
      } else {
        size += Buffer.byteLength(JSON.stringify(request.body), 'utf8');
      }
    }

    return size;
  }

  /**
   * Initialize built-in sanitizers
   */
  private initializeBuiltInSanitizers(): void {
    // HTML sanitizer
    this.registerSanitizer('html', (value: unknown) => {
      if (typeof value === 'string') {
        return value.replace(/<[^>]*>/g, '');
      }

      return value;
    });

    // URL sanitizer
    this.registerSanitizer('url', (value: unknown) => {
      if (typeof value === 'string') {
        try {
          const url = new URL(value);

          return url.toString();
        } catch {
          return value;
        }
      }

      return value;
    });

    // Email sanitizer
    this.registerSanitizer('email', (value: unknown) => {
      if (typeof value === 'string') {
        return value.toLowerCase().trim();
      }

      return value;
    });
  }

  /**
   * Initialize built-in validators
   */
  private initializeBuiltInValidators(): void {
    // GCP resource name validator
    this.registerValidator('gcp-resource-name', (value: unknown, context: ValidationContext) => {
      if (typeof value !== 'string') {
        return null;
      }

      const resourcePattern = /^(projects|folders|organizations)\/[^/]+/;

      if (!resourcePattern.test(value)) {
        return {
          field: context.path.join('.'),
          code: 'INVALID_RESOURCE_NAME',
          message: 'Invalid GCP resource name format',
          value,
        };
      }

      return null;
    });

    // Project ID validator
    this.registerValidator('project-id', (value: unknown, context: ValidationContext) => {
      if (typeof value !== 'string') {
        return null;
      }

      const projectIdPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

      if (!projectIdPattern.test(value)) {
        return {
          field: context.path.join('.'),
          code: 'INVALID_PROJECT_ID',
          message: 'Invalid project ID format',
          value,
        };
      }

      return null;
    });
  }

  /**
   * Create quota storage
   */
  private createQuotaStorage(): QuotaStorage {
    switch (this.config.quotas.storage) {
      case 'memory':
        return new MemoryQuotaStorage();
      case 'redis':
        // Would implement Redis storage
        throw new Error('Redis quota storage not implemented');
      case 'database':
        // Would implement database storage
        throw new Error('Database quota storage not implemented');
      default:
        return new MemoryQuotaStorage();
    }
  }
}

// Quota storage interfaces and implementations
interface QuotaUsage {
  requests: number;
  bandwidth: number;
  operations: Record<string, number>;
}

interface QuotaStorage {
  getUsage(clientId: string): Promise<QuotaUsage>;
  recordUsage(clientId: string, usage: QuotaUsage): Promise<void>;
  resetUsage(clientId: string): Promise<void>;
}

class MemoryQuotaStorage implements QuotaStorage {
  private storage: Map<string, { usage: QuotaUsage; timestamp: number }> = new Map();
  private windowMs = 60000; // 1 minute default

  async getUsage(clientId: string): Promise<QuotaUsage> {
    const entry = this.storage.get(clientId);
    const now = Date.now();

    if (!entry || now - entry.timestamp > this.windowMs) {
      return {
        requests: 0,
        bandwidth: 0,
        operations: {},
      };
    }

    return entry.usage;
  }

  async recordUsage(clientId: string, newUsage: QuotaUsage): Promise<void> {
    const currentUsage = await this.getUsage(clientId);
    const now = Date.now();

    const mergedOperations = { ...currentUsage.operations };

    for (const [op, count] of Object.entries(newUsage.operations)) {
      mergedOperations[op] = (mergedOperations[op] || 0) + count;
    }

    this.storage.set(clientId, {
      usage: {
        requests: currentUsage.requests + newUsage.requests,
        bandwidth: currentUsage.bandwidth + newUsage.bandwidth,
        operations: mergedOperations,
      },
      timestamp: now,
    });
  }

  async resetUsage(clientId: string): Promise<void> {
    this.storage.delete(clientId);
  }

  async clearAll(): Promise<void> {
    this.storage.clear();
  }

  setWindowMs(windowMs: number): void {
    this.windowMs = windowMs;
  }
}

// Supporting interfaces
export interface ValidationStats {
  readonly registeredSchemas: number;
  readonly customValidators: number;
  readonly sanitizers: number;
  readonly quotaEnabled: boolean;
}

// Predefined Zod schemas for common GCP operations
export const CommonSchemas = {
  // Generic GCP request
  gcpRequest: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
    path: z.string().min(1),
    query: z.any().optional(),
    headers: z.any().optional(),
    body: z.unknown().optional(),
    clientId: z.string().min(1),
    operation: z.string().min(1),
    metadata: z.any().optional(),
  }),

  // Project resource
  projectResource: z.object({
    projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, 'Invalid project ID format'),
    displayName: z.string().optional(),
    parent: z.string().optional(),
    labels: z.any().optional(),
  }),

  // Resource name
  resourceName: z
    .string()
    .regex(/^(projects|folders|organizations)\/[^/]+/, 'Invalid resource name format'),

  // Pagination
  pagination: z.object({
    pageSize: z.number().int().min(1).max(1000).optional(),
    pageToken: z.string().optional(),
  }),
};
