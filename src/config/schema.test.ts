/**
 * Tests for configuration schema validation
 */

import { describe, expect, test } from 'bun:test';
import {
  ConfigSchema,
  EnvConfigSchema,
  mapEnvToConfig,
  validateConfig,
  validateEnv,
} from '@/config/schema.ts';

describe('Configuration Schema', () => {
  describe('ConfigSchema', () => {
    test('should accept valid configuration with defaults', () => {
      const config = ConfigSchema.parse({
        server: {},
        storage: {},
        auth: {},
        services: {
          pubsub: {},
          scheduler: {},
          tasks: {},
          secrets: {},
          workflows: {},
        },
        logging: {},
      });

      expect(config.server.httpPort).toBe(8765);
      expect(config.server.grpcPort).toBe(8766);
      expect(config.server.maxConnections).toBe(100);
      expect(config.storage.type).toBe('hybrid');
      expect(config.auth.enabled).toBe(false);
      expect(config.auth.mode).toBe('bypass');
      expect(config.logging.level).toBe('info');
    });

    test('should accept custom configuration values', () => {
      const config = ConfigSchema.parse({
        server: {
          httpPort: 9000,
          grpcPort: 9001,
          maxConnections: 200,
        },
        storage: {
          type: 'memory',
          cacheSize: 50000000,
        },
        auth: {
          enabled: true,
          mode: 'mock',
          mockCredentials: {
            projectId: 'test-project',
            serviceAccount: 'test@test-project.iam.gserviceaccount.com',
          },
        },
        services: {
          pubsub: { enabled: true },
          scheduler: { enabled: false },
          tasks: { enabled: true },
          secrets: { enabled: false },
          workflows: { enabled: true },
        },
        logging: {
          level: 'debug',
          format: 'pretty',
        },
      });

      expect(config.server.httpPort).toBe(9000);
      expect(config.server.grpcPort).toBe(9001);
      expect(config.storage.type).toBe('memory');
      expect(config.auth.enabled).toBe(true);
      expect(config.auth.mode).toBe('mock');
      expect(config.services.scheduler.enabled).toBe(false);
      expect(config.logging.level).toBe('debug');
    });

    test('should reject invalid configuration', () => {
      expect(() => {
        ConfigSchema.parse({
          server: {
            httpPort: -1, // Invalid port
          },
          storage: {},
          auth: {},
          services: {
            pubsub: {},
            scheduler: {},
            tasks: {},
            secrets: {},
          },
          logging: {},
        });
      }).toThrow();

      expect(() => {
        ConfigSchema.parse({
          server: {},
          storage: {
            type: 'invalid', // Invalid storage type
          },
          auth: {},
          services: {
            pubsub: {},
            scheduler: {},
            tasks: {},
            secrets: {},
          },
          logging: {},
        });
      }).toThrow();
    });
  });

  describe('EnvConfigSchema', () => {
    test('should parse environment variables correctly', () => {
      const env = EnvConfigSchema.parse({
        PORT: '8080',
        GRPC_PORT: '8081',
        STORAGE_TYPE: 'memory',
        AUTH_ENABLED: 'true',
        LOG_LEVEL: 'debug',
        SERVICES: 'pubsub,scheduler',
        NODE_ENV: 'development',
      });

      expect(env.PORT).toBe(8080);
      expect(env.GRPC_PORT).toBe(8081);
      expect(env.STORAGE_TYPE).toBe('memory');
      expect(env.AUTH_ENABLED).toBe(true);
      expect(env.LOG_LEVEL).toBe('debug');
      expect(env.SERVICES).toBe('pubsub,scheduler');
      expect(env.NODE_ENV).toBe('development');
    });

    test('should handle boolean transformations', () => {
      const env1 = EnvConfigSchema.parse({ AUTH_ENABLED: 'true' });

      expect(env1.AUTH_ENABLED).toBe(true);

      const env2 = EnvConfigSchema.parse({ AUTH_ENABLED: 'false' });

      expect(env2.AUTH_ENABLED).toBe(false);

      const env3 = EnvConfigSchema.parse({ AUTH_ENABLED: 'TRUE' });

      expect(env3.AUTH_ENABLED).toBe(true);
    });
  });

  describe('mapEnvToConfig', () => {
    test('should map environment variables to configuration structure', () => {
      const envConfig = {
        PORT: 8080,
        GRPC_PORT: 8081,
        STORAGE_TYPE: 'memory' as const,
        AUTH_ENABLED: true,
        LOG_LEVEL: 'debug' as const,
        SERVICES: 'pubsub,tasks',
        NODE_ENV: 'development' as const,
      };

      const config = mapEnvToConfig(envConfig);

      expect(config.server?.httpPort).toBe(8080);
      expect(config.server?.grpcPort).toBe(8081);
      expect(config.storage?.type).toBe('memory');
      expect(config.auth?.enabled).toBe(true);
      expect(config.logging?.level).toBe('debug');
      expect(config.services?.pubsub?.enabled).toBe(true);
      expect(config.services?.scheduler?.enabled).toBe(false);
      expect(config.services?.tasks?.enabled).toBe(true);
      expect(config.services?.secrets?.enabled).toBe(false);
    });

    test('should handle individual service enablement', () => {
      const envConfig = {
        ENABLE_PUBSUB: true,
        ENABLE_SCHEDULER: false,
        ENABLE_TASKS: true,
        ENABLE_SECRETS: false,
      };

      const config = mapEnvToConfig(envConfig);

      expect(config.services?.pubsub?.enabled).toBe(true);
      expect(config.services?.scheduler?.enabled).toBe(false);
      expect(config.services?.tasks?.enabled).toBe(true);
      expect(config.services?.secrets?.enabled).toBe(false);
    });
  });

  describe('validateConfig', () => {
    test('should validate and return typed configuration', () => {
      const rawConfig = {
        server: { httpPort: 8080 },
        storage: { type: 'memory' },
        auth: { enabled: true },
        services: {
          pubsub: { enabled: true },
          scheduler: { enabled: true },
          tasks: { enabled: true },
          secrets: { enabled: true },
          workflows: { enabled: true },
        },
        logging: { level: 'debug' },
      };

      const config = validateConfig(rawConfig);

      expect(config.server.httpPort).toBe(8080);
      expect(config.storage.type).toBe('memory');
      expect(config.auth.enabled).toBe(true);
      expect(config.logging.level).toBe('debug');
    });
  });

  describe('validateEnv', () => {
    test('should validate environment variables with defaults', () => {
      const env = validateEnv({
        PORT: '8080',
        LOG_LEVEL: 'debug',
      });

      expect(env.PORT).toBe(8080);
      expect(env.LOG_LEVEL).toBe('debug');
      expect(env.NODE_ENV).toBe('development'); // Default value
    });

    test('should work with empty environment', () => {
      const env = validateEnv({});

      expect(env.NODE_ENV).toBe('development');
    });
  });
});
