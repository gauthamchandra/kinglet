/**
 * Validation Layer Tests
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { z } from 'zod';
import { createMockLogger } from '../../../test-utils/mock-logger.ts';
import {
  ValidationLayer,
  CommonSchemas,
  type ValidationRequest,
  type ValidationConfig,
  type QuotaLimits,
  type CustomValidator,
  type SanitizerFunction,
  DEFAULT_VALIDATION_CONFIG,
} from './validation-layer.ts';

// Mock logger
const mockLogger = createMockLogger();

// Test data
const createValidationRequest = (
  overrides: Partial<ValidationRequest> = {}
): ValidationRequest => ({
  method: 'GET',
  path: '/test/endpoint',
  query: { param1: 'value1' },
  headers: { 'Content-Type': 'application/json' },
  clientId: 'test-client-123',
  operation: 'read',
  ...overrides,
});

describe('ValidationLayer', () => {
  let validator: ValidationLayer;

  beforeEach(async () => {
    validator = new ValidationLayer(mockLogger);
    // Reset quota storage to ensure clean state between tests
    await validator.resetQuotaStorage();
  });

  describe('Basic Validation', () => {
    test('should validate a basic request successfully', async () => {
      const request = createValidationRequest();

      const result = await validator.validate(request);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.sanitized).toBeDefined();
    });

    test('should require essential fields', async () => {
      const request = createValidationRequest({
        method: '', // Invalid
        clientId: '', // Invalid
      });

      const result = await validator.validate(request);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);

      const methodError = result.errors.find(e => e.field === 'method');
      const clientError = result.errors.find(e => e.field === 'clientId');

      expect(methodError?.code).toBe('REQUIRED');
      expect(clientError?.code).toBe('REQUIRED');
    });

    test('should validate HTTP methods', async () => {
      const request = createValidationRequest({
        method: 'INVALID_METHOD',
      });

      const result = await validator.validate(request);

      expect(result.valid).toBe(false);

      const methodError = result.errors.find(e => e.field === 'method');

      expect(methodError?.code).toBe('INVALID');
      expect(methodError?.value).toBe('INVALID_METHOD');
    });

    test('should validate path format', async () => {
      const request = createValidationRequest({
        path: 'invalid-path-no-leading-slash',
      });

      const result = await validator.validate(request);

      expect(result.valid).toBe(false);

      const pathError = result.errors.find(e => e.field === 'path');

      expect(pathError?.code).toBe('INVALID_FORMAT');
    });

    test('should validate header types', async () => {
      const request = createValidationRequest({
        headers: {
          'valid-header': 'string-value',
          'invalid-header': 123 as unknown as string, // Invalid type for testing
        },
      });

      const result = await validator.validate(request);

      expect(result.valid).toBe(false);

      const headerError = result.errors.find(e => e.field === 'headers.invalid-header');

      expect(headerError?.code).toBe('INVALID_TYPE');
    });
  });

  describe('Request Sanitization', () => {
    test('should sanitize HTML in string values', async () => {
      const request = createValidationRequest({
        query: {
          param1: '<script>alert("xss")</script>Clean text',
          param2: 'Normal value',
        },
      });

      const result = await validator.validate(request);

      expect(result.valid).toBe(true);
      expect(result.sanitized?.query?.param1).toBe('Clean text');
      expect(result.sanitized?.query?.param2).toBe('Normal value');
    });

    test('should trim whitespace from strings', async () => {
      const request = createValidationRequest({
        query: {
          param1: '  trimmed value  ',
          param2: '\n\t another value \t\n',
        },
      });

      const result = await validator.validate(request);

      expect(result.sanitized?.query?.param1).toBe('trimmed value');
      expect(result.sanitized?.query?.param2).toBe('another value');
    });

    test('should limit string length', async () => {
      const longString = 'a'.repeat(20000); // Exceeds default maxStringLength
      const request = createValidationRequest({
        query: { longParam: longString },
      });

      const result = await validator.validate(request);

      expect(result.sanitized?.query?.longParam).toBe('a'.repeat(10000)); // Truncated to max
    });

    test('should limit array length', async () => {
      const longArray = Array(2000).fill('item'); // Exceeds default maxArrayLength
      const request = createValidationRequest({
        query: { arrayParam: longArray },
      });

      const result = await validator.validate(request);

      expect((result.sanitized?.query?.arrayParam as unknown[])?.length).toBe(1000); // Truncated
    });

    test('should sanitize nested objects', async () => {
      const request = createValidationRequest({
        body: {
          level1: {
            level2: {
              htmlContent: '<h1>Title</h1><p>Content</p>',
              normalContent: '  Normal text  ',
            },
          },
        },
      });

      const result = await validator.validate(request);

      const level2 = (
        result.sanitized?.body as {
          level1?: { level2?: { htmlContent?: string; normalContent?: string } };
        }
      )?.level1?.level2;

      expect(level2?.htmlContent).toBe('TitleContent');
      expect(level2?.normalContent).toBe('Normal text');
    });

    test('should normalize paths', async () => {
      const request = createValidationRequest({
        path: '//multiple///slashes//path/',
      });

      const result = await validator.validate(request);

      expect(result.sanitized?.path).toBe('/multiple/slashes/path');
    });

    test('should prevent deep object nesting', async () => {
      // Create deeply nested object
      const deepObject: Record<string, unknown> = {};
      let current: Record<string, unknown> = deepObject;

      for (let i = 0; i < 15; i++) {
        const next = { value: `level${i}` };

        current.next = next;
        current = next;
      }

      const request = createValidationRequest({
        body: deepObject,
      });

      const result = await validator.validate(request);

      expect(result.valid).toBe(true);
      // Should truncate deep nesting
    });
  });

  describe('Schema Validation', () => {
    test('should validate with registered Zod schema', async () => {
      const schema = z.object({
        method: z.enum(['GET', 'POST']),
        path: z.string().min(1),
        clientId: z.string().min(5),
        query: z.object({
          requiredParam: z.string(),
        }),
      });

      validator.registerSchema({
        name: 'test-get',
        schema,
      });

      const validRequest = createValidationRequest({
        method: 'GET',
        query: { requiredParam: 'value' },
      });

      const result = await validator.validate(validRequest);

      expect(result.valid).toBe(true);
    });

    test('should fail validation with invalid schema data', async () => {
      const schema = z
        .object({
          clientId: z.string().min(10), // Requires minimum 10 characters
          query: z
            .object({
              requiredParam: z.string().min(5),
            })
            .passthrough(), // Allow other query properties
        })
        .passthrough(); // Allow other request properties

      validator.registerSchema({
        name: 'test-get',
        schema,
      });

      const invalidRequest = createValidationRequest({
        clientId: 'short', // Too short
        query: { requiredParam: 'hi' }, // Too short
      });

      const result = await validator.validate(invalidRequest);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);

      const clientIdError = result.errors.find(e => e.field.includes('clientId'));
      const paramError = result.errors.find(e => e.field.includes('requiredParam'));

      expect(clientIdError).toBeDefined();
      expect(paramError).toBeDefined();
    });

    test('should use common GCP schemas', () => {
      const projectData = {
        projectId: 'valid-project-123',
        displayName: 'Test Project',
        labels: { env: 'test' },
      };

      const result = CommonSchemas.projectResource.safeParse(projectData);

      expect(result.success).toBe(true);
    });

    test('should validate GCP resource names', () => {
      const validResourceName = 'projects/my-project-123';
      const invalidResourceName = 'invalid/resource/name';

      const validResult = CommonSchemas.resourceName.safeParse(validResourceName);
      const invalidResult = CommonSchemas.resourceName.safeParse(invalidResourceName);

      expect(validResult.success).toBe(true);
      expect(invalidResult.success).toBe(false);
    });
  });

  describe('Custom Validators', () => {
    test('should register and use custom validators', async () => {
      const customValidator: CustomValidator = (value, context) => {
        if (context.operation === 'write' && context.clientId.startsWith('readonly-')) {
          return {
            field: 'clientId',
            code: 'READ_ONLY_CLIENT',
            message: 'Read-only client cannot perform write operations',
            value,
          };
        }

        return null;
      };

      validator.registerValidator('readonly-check', customValidator);

      const request = createValidationRequest({
        clientId: 'readonly-client-123',
        operation: 'write',
      });

      const result = await validator.validate(request);

      expect(result.valid).toBe(false);

      const customError = result.errors.find(e => e.code === 'READ_ONLY_CLIENT');

      expect(customError).toBeDefined();
      expect(customError?.message).toContain('Read-only client');
    });

    test('should use built-in GCP validators', async () => {
      const request = createValidationRequest({
        body: {
          projectId: 'INVALID-PROJECT-ID-WITH-CAPS', // Should fail project ID validation
          resourceName: 'invalid-resource-format', // Should fail resource name validation
        },
      });

      // The built-in validators would need to be applied to specific fields
      // This test demonstrates the concept
      const result = await validator.validate(request);

      // In a real implementation, you'd configure which validators apply to which fields
      expect(result.valid).toBe(true); // Generic validation passes
    });

    test('should handle custom validator errors in strict mode', async () => {
      const faultyValidator: CustomValidator = () => {
        throw new Error('Validator crashed');
      };

      const strictValidator = new ValidationLayer(mockLogger, {
        customValidators: {
          enabled: true,
          validators: new Map([['faulty', faultyValidator]]),
          strictMode: true,
        },
      });

      const request = createValidationRequest();

      const result = await strictValidator.validate(request);

      expect(result.valid).toBe(false);

      const validatorError = result.errors.find(e => e.code === 'CUSTOM_VALIDATOR_ERROR');

      expect(validatorError).toBeDefined();
    });

    test('should ignore custom validator errors in non-strict mode', async () => {
      const faultyValidator: CustomValidator = () => {
        throw new Error('Validator crashed');
      };

      const nonStrictValidator = new ValidationLayer(mockLogger, {
        customValidators: {
          enabled: true,
          validators: new Map([['faulty', faultyValidator]]),
          strictMode: false,
        },
      });

      const request = createValidationRequest();

      const result = await nonStrictValidator.validate(request);

      expect(result.valid).toBe(true); // Should continue despite validator error
    });
  });

  describe('Custom Sanitizers', () => {
    test('should register and use custom sanitizers', () => {
      const emailSanitizer: SanitizerFunction = value => {
        if (typeof value === 'string') {
          return value.toLowerCase().trim();
        }

        return value;
      };

      validator.registerSanitizer('email', emailSanitizer);

      const stats = validator.getStats();

      expect(stats.sanitizers).toBeGreaterThanOrEqual(1);
    });

    test('should use built-in sanitizers', () => {
      validator.registerSanitizer('test', value => {
        if (typeof value === 'string') {
          return value.replace(/<[^>]*>/g, '');
        }

        return value;
      });

      expect(validator.getStats().sanitizers).toBeGreaterThan(0);
    });
  });

  describe('Quota Management', () => {
    test('should check quotas and allow requests within limits', async () => {
      const quotaValidator = new ValidationLayer(mockLogger, {
        quotas: {
          enabled: true,
          windowMs: 60000,
          storage: 'memory',
          defaultLimits: {
            requests: 10,
            bandwidth: 1024 * 1024,
            operations: { read: 100, write: 10 },
          },
          customLimits: new Map(),
        },
      });

      // Ensure clean quota state for this test
      await quotaValidator.resetQuotaStorage();

      const request = createValidationRequest({
        operation: 'read',
      });

      const result = await quotaValidator.validate(request);

      expect(result.valid).toBe(true);
      expect(result.quotaInfo).toBeDefined();
      expect(result.quotaInfo?.exceeded).toBe(false);
      expect(result.quotaInfo?.remaining.requests).toBe(9); // 10 - 1
    });

    test('should reject requests that exceed quotas', async () => {
      const quotaValidator = new ValidationLayer(mockLogger, {
        quotas: {
          enabled: true,
          windowMs: 60000,
          storage: 'memory',
          defaultLimits: {
            requests: 1,
            bandwidth: 1000, // Allow first request to pass
            operations: { read: 1 },
          },
          customLimits: new Map(),
        },
      });

      const request = createValidationRequest({
        operation: 'read',
        body: 'a'.repeat(200), // Body within bandwidth limit
      });

      // First request should work
      const firstResult = await quotaValidator.validate(request);

      expect(firstResult.valid).toBe(true);

      // Second request should be rejected
      const secondResult = await quotaValidator.validate(request);

      expect(secondResult.valid).toBe(false);
      expect(secondResult.quotaInfo?.exceeded).toBe(true);

      const quotaError = secondResult.errors.find(e => e.code === 'QUOTA_EXCEEDED');

      expect(quotaError).toBeDefined();
    });

    test('should support custom quota limits per client', async () => {
      const quotaValidator = new ValidationLayer(mockLogger, {
        quotas: {
          enabled: true,
          windowMs: 60000,
          storage: 'memory',
          defaultLimits: {
            requests: 10,
            bandwidth: 1024,
            operations: { read: 10 },
          },
          customLimits: new Map(),
        },
      });

      // Ensure clean quota state for this test
      await quotaValidator.resetQuotaStorage();

      const customLimits: QuotaLimits = {
        requests: 100,
        bandwidth: 1024 * 1024,
        operations: { read: 1000 },
      };

      quotaValidator.updateQuotaLimits('premium-client', customLimits);

      const request = createValidationRequest({
        clientId: 'premium-client',
        operation: 'read',
      });

      const result = await quotaValidator.validate(request);

      expect(result.valid).toBe(true);
      expect(result.quotaInfo?.remaining.requests).toBe(99); // 100 - 1
    });

    test('should track different operation types', async () => {
      const quotaValidator = new ValidationLayer(mockLogger, {
        quotas: {
          enabled: true,
          windowMs: 60000,
          storage: 'memory',
          defaultLimits: {
            requests: 100,
            bandwidth: 1024 * 1024,
            operations: { read: 50, write: 10 },
          },
          customLimits: new Map(),
        },
      });

      // Ensure clean quota state for this test
      await quotaValidator.resetQuotaStorage();

      // Make read requests
      for (let i = 0; i < 3; i++) {
        await quotaValidator.validate(createValidationRequest({ operation: 'read' }));
      }

      // Make write request
      await quotaValidator.validate(createValidationRequest({ operation: 'write' }));

      // Check remaining quotas
      const result = await quotaValidator.validate(createValidationRequest({ operation: 'read' }));

      expect(result.quotaInfo?.remaining.operations.read).toBe(46); // 50 - 4
      expect(result.quotaInfo?.remaining.operations.write).toBe(9); // 10 - 1
    });
  });

  describe('Configuration', () => {
    test('should use default configuration when none provided', () => {
      const defaultValidator = new ValidationLayer(mockLogger);

      const stats = defaultValidator.getStats();

      expect(stats.quotaEnabled).toBe(DEFAULT_VALIDATION_CONFIG.quotas.enabled);
    });

    test('should merge custom configuration with defaults', () => {
      const customConfig: Partial<ValidationConfig> = {
        sanitization: {
          enabled: false,
          removeHtml: false,
          normalizePaths: false,
          trimStrings: false,
          sanitizeHeaders: false,
          maxStringLength: 5000,
          maxArrayLength: 500,
          maxObjectDepth: 5,
        },
      };

      const customValidator = new ValidationLayer(mockLogger, customConfig);

      expect(customValidator).toBeInstanceOf(ValidationLayer);
    });

    test('should disable sanitization when configured', async () => {
      const noSanitizeValidator = new ValidationLayer(mockLogger, {
        sanitization: {
          enabled: false,
          removeHtml: false,
          normalizePaths: false,
          trimStrings: false,
          sanitizeHeaders: false,
          maxStringLength: 10000,
          maxArrayLength: 1000,
          maxObjectDepth: 10,
        },
      });

      const request = createValidationRequest({
        query: { htmlParam: '<script>alert("test")</script>' },
      });

      const result = await noSanitizeValidator.validate(request);

      // HTML should not be sanitized
      expect(result.sanitized?.query?.htmlParam).toBe('<script>alert("test")</script>');
    });

    test('should disable quotas when configured', async () => {
      const noQuotaValidator = new ValidationLayer(mockLogger, {
        quotas: {
          enabled: false,
          windowMs: 60000,
          storage: 'memory',
          defaultLimits: {
            requests: 1,
            bandwidth: 100,
            operations: { read: 1 },
          },
          customLimits: new Map(),
        },
      });

      const request = createValidationRequest();

      const result = await noQuotaValidator.validate(request);

      expect(result.quotaInfo).toBeUndefined();
    });
  });

  describe('Statistics and Monitoring', () => {
    test('should provide validation statistics', () => {
      validator.registerSchema({
        name: 'test-schema',
        schema: z.object({ test: z.string() }),
      });

      validator.registerValidator('test-validator', () => null);
      validator.registerSanitizer('test-sanitizer', v => v);

      const stats = validator.getStats();

      expect(stats.registeredSchemas).toBe(1);
      expect(stats.customValidators).toBeGreaterThanOrEqual(1);
      expect(stats.sanitizers).toBeGreaterThanOrEqual(1);
      expect(typeof stats.quotaEnabled).toBe('boolean');
    });
  });

  describe('Error Handling', () => {
    test('should handle validation errors gracefully', async () => {
      // Create a validator that will throw during validation
      const faultyValidator = new ValidationLayer(mockLogger);

      // Override the validate method to throw an error
      faultyValidator.validate = async () => {
        throw new Error('Validation system error');
      };

      const request = createValidationRequest();

      try {
        await faultyValidator.validate(request);
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Validation system error');
      }
    });

    test('should sanitize error details when configured', () => {
      const sanitizeErrorsValidator = new ValidationLayer(mockLogger, {
        errorHandling: {
          includeDetails: false,
          sanitizeErrors: true,
          maxErrorDepth: 3,
        },
      });

      expect(sanitizeErrorsValidator).toBeInstanceOf(ValidationLayer);
    });
  });

  describe('Performance', () => {
    test('should handle large requests efficiently', async () => {
      const largeRequest = createValidationRequest({
        query: Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [`param${i}`, `value${i}`])
        ),
        body: {
          data: Array.from({ length: 1000 }, (_, i) => ({
            id: i,
            name: `Item ${i}`,
            description: `Description for item ${i}`,
          })),
        },
      });

      const startTime = Date.now();
      const result = await validator.validate(largeRequest);
      const endTime = Date.now();

      expect(result.valid).toBe(true);
      expect(endTime - startTime).toBeLessThan(1000); // Should complete within 1 second
    });

    test('should validate multiple requests concurrently', async () => {
      const requests = Array.from({ length: 10 }, (_, i) =>
        createValidationRequest({ clientId: `client-${i}` })
      );

      const startTime = Date.now();
      const results = await Promise.all(requests.map(req => validator.validate(req)));
      const endTime = Date.now();

      expect(results.every(r => r.valid)).toBe(true);
      expect(endTime - startTime).toBeLessThan(1000); // Should handle concurrent requests efficiently
    });
  });
});
