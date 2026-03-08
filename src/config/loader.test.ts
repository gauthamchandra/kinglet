/**
 * Tests for configuration loader
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConfigLoader,
  createStandardLoader,
  EnvConfigSource,
  getConfig,
  JsonConfigSource,
  loadConfigFromEnv,
  loadConfigFromFile,
  resetConfig,
} from '@/config/loader.ts';

describe('Configuration Loader', () => {
  const testConfigPath = join(process.cwd(), 'test-config.json');
  const testConfig = {
    server: {
      httpPort: 9000,
      grpcPort: 9001,
    },
    logging: {
      level: 'debug',
    },
  };

  beforeEach(() => {
    resetConfig();
  });

  afterEach(() => {
    resetConfig();
    // Clean up test files
    const testFiles = [
      testConfigPath,
      join(process.cwd(), 'invalid-test-config.json'),
      join(process.cwd(), 'first-config.json'),
      join(process.cwd(), 'second-config.json'),
    ];

    testFiles.forEach(filePath => {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    });
  });

  describe('JsonConfigSource', () => {
    test('should load configuration from JSON file', async () => {
      writeFileSync(testConfigPath, JSON.stringify(testConfig));

      const source = new JsonConfigSource(testConfigPath);
      const config = await source.load();

      expect(config).not.toBeNull();
      expect(config?.server?.httpPort).toBe(9000);
      expect(config?.server?.grpcPort).toBe(9001);
      expect(config?.logging?.level).toBe('debug');
    });

    test('should return null for non-existent file', async () => {
      const source = new JsonConfigSource('/non/existent/path.json');
      const config = await source.load();

      expect(config).toBeNull();
    });

    test('should handle invalid JSON gracefully', async () => {
      const invalidConfigPath = join(process.cwd(), 'invalid-test-config.json');

      writeFileSync(invalidConfigPath, 'invalid json');

      const source = new JsonConfigSource(invalidConfigPath);
      const config = await source.load();

      expect(config).toBeNull();

      // Clean up
      if (existsSync(invalidConfigPath)) {
        unlinkSync(invalidConfigPath);
      }
    });
  });

  describe('EnvConfigSource', () => {
    test('should load configuration from environment variables', async () => {
      const originalEnv = { ...process.env };

      try {
        process.env.PORT = '8080';
        process.env.LOG_LEVEL = 'debug';
        process.env.STORAGE_TYPE = 'memory';

        const source = new EnvConfigSource();
        const config = await source.load();

        expect(config).not.toBeNull();
        expect(config?.server?.httpPort).toBe(8080);
        expect(config?.logging?.level).toBe('debug');
        expect(config?.storage?.type).toBe('memory');
      } finally {
        process.env = originalEnv;
      }
    });
  });

  describe('ConfigLoader', () => {
    test('should merge configurations from multiple sources', async () => {
      writeFileSync(
        testConfigPath,
        JSON.stringify({
          server: { httpPort: 8080 },
          logging: { level: 'info' },
        })
      );

      const loader = new ConfigLoader();

      loader.addJsonFile(testConfigPath);

      const originalEnv = { ...process.env };

      try {
        process.env.LOG_LEVEL = 'debug';
        process.env.GRPC_PORT = '8081';

        loader.addEnvironment();

        const config = await loader.load();

        // File provides httpPort, env overrides LOG_LEVEL and adds GRPC_PORT
        expect(config.server.httpPort).toBe(8080); // From file
        expect(config.server.grpcPort).toBe(8081); // From env
        expect(config.logging.level).toBe('debug'); // Env overrides file
      } finally {
        process.env = originalEnv;
      }
    });

    test('should apply sources in order with later sources taking precedence', async () => {
      const firstConfigPath = join(process.cwd(), 'first-config.json');
      const secondConfigPath = join(process.cwd(), 'second-config.json');

      try {
        writeFileSync(
          firstConfigPath,
          JSON.stringify({
            server: { httpPort: 8080 },
            logging: { level: 'info' },
          })
        );

        writeFileSync(
          secondConfigPath,
          JSON.stringify({
            server: { httpPort: 9000 }, // Should override first
            storage: { type: 'memory' },
          })
        );

        const loader = new ConfigLoader();

        loader.addJsonFile(firstConfigPath);
        loader.addJsonFile(secondConfigPath);

        const config = await loader.load();

        expect(config.server.httpPort).toBe(9000); // From second file
        expect(config.logging.level).toBe('info'); // From first file
        expect(config.storage.type).toBe('memory'); // From second file
      } finally {
        [firstConfigPath, secondConfigPath].forEach(path => {
          if (existsSync(path)) unlinkSync(path);
        });
      }
    });

    test('should provide default values for missing configuration', async () => {
      const loader = new ConfigLoader();
      const config = await loader.load();

      expect(config.server.httpPort).toBe(8765); // Default value
      expect(config.server.grpcPort).toBe(8766); // Default value
      expect(config.storage.type).toBe('hybrid'); // Default value
    });
  });

  describe('createStandardLoader', () => {
    test('should create loader with standard configuration sources', () => {
      const loader = createStandardLoader();

      expect(loader).toBeInstanceOf(ConfigLoader);
    });
  });

  describe('getConfig', () => {
    test('should return cached configuration on subsequent calls', async () => {
      const config1 = await getConfig();
      const config2 = await getConfig();

      expect(config1).toBe(config2); // Same instance
    });

    test('should load fresh configuration after reset', async () => {
      const config1 = await getConfig();

      resetConfig();
      const config2 = await getConfig();

      expect(config1).not.toBe(config2); // Different instances
      expect(config1).toEqual(config2); // But same values
    });
  });

  describe('loadConfigFromFile', () => {
    test('should load configuration from specific file', async () => {
      const customConfig = {
        server: { httpPort: 7777 },
        logging: { level: 'warn' },
      };

      writeFileSync(testConfigPath, JSON.stringify(customConfig));

      const config = await loadConfigFromFile(testConfigPath);

      expect(config.server.httpPort).toBe(7777);
      expect(config.logging.level).toBe('warn');
    });
  });

  describe('loadConfigFromEnv', () => {
    test('should load configuration from environment variables only', async () => {
      const env = {
        PORT: '8080',
        LOG_LEVEL: 'debug',
        STORAGE_TYPE: 'memory',
      };

      const config = await loadConfigFromEnv(env);

      expect(config.server.httpPort).toBe(8080);
      expect(config.logging.level).toBe('debug');
      expect(config.storage.type).toBe('memory');
    });

    test('should use defaults for missing environment variables', async () => {
      const config = await loadConfigFromEnv({});

      expect(config.server.httpPort).toBe(8765); // Default value
      expect(config.logging.level).toBe('info'); // Default value
    });
  });
});
