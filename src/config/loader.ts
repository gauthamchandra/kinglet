/**
 * Configuration loader with multiple source support
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './schema.ts';
import { mapEnvToConfig, validateConfig, validateEnv } from './schema.ts';

// Deep partial type for configuration merging
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export interface ConfigSource {
  name: string;
  load(): Promise<DeepPartial<Config> | null>;
}

/**
 * Environment variables configuration source
 */
export class EnvConfigSource implements ConfigSource {
  name = 'environment';

  async load(): Promise<DeepPartial<Config> | null> {
    try {
      const envConfig = validateEnv(process.env);

      return mapEnvToConfig(envConfig);
    } catch (error) {
      console.warn(`Failed to load environment configuration: ${error}`);

      return null;
    }
  }
}

/**
 * JSON file configuration source
 */
export class JsonConfigSource implements ConfigSource {
  constructor(
    public readonly filePath: string,
    public readonly name: string = `json:${filePath}`
  ) {}

  async load(): Promise<DeepPartial<Config> | null> {
    try {
      if (!existsSync(this.filePath)) {
        return null;
      }

      const content = await readFile(this.filePath, 'utf-8');
      const rawConfig = JSON.parse(content);

      // Validate the structure but allow partial configuration
      return rawConfig as DeepPartial<Config>;
    } catch (error) {
      console.warn(`Failed to load configuration from ${this.filePath}: ${error}`);

      return null;
    }
  }
}

/**
 * Configuration loader with multiple sources and precedence
 */
export class ConfigLoader {
  private sources: ConfigSource[] = [];

  /**
   * Add a configuration source
   */
  addSource(source: ConfigSource): ConfigLoader {
    this.sources.push(source);

    return this;
  }

  /**
   * Add a JSON file source
   */
  addJsonFile(filePath: string, name?: string): ConfigLoader {
    return this.addSource(new JsonConfigSource(filePath, name));
  }

  /**
   * Add environment variables source
   */
  addEnvironment(): ConfigLoader {
    return this.addSource(new EnvConfigSource());
  }

  /**
   * Load and merge configuration from all sources
   * Sources are processed in the order they were added
   * Later sources override earlier sources
   */
  async load(): Promise<Config> {
    let mergedConfig: DeepPartial<Config> = {};

    for (const source of this.sources) {
      const config = await source.load();

      if (config) {
        mergedConfig = this.mergeConfigs(mergedConfig, config);
      }
    }

    // Ensure all required top-level objects exist before validation
    // This allows the Zod schema defaults to be applied properly
    const configWithDefaults = {
      server: {},
      storage: {},
      auth: {},
      logging: {},
      ...mergedConfig,
      // Ensure nested services objects are merged properly with defaults
      services: {
        pubsub: {},
        scheduler: {},
        tasks: {},
        secrets: {},
        storage: {},
        workflows: {},
        kms: {},
        memorystore: {},
        cloudsql: {},
        ...mergedConfig.services,
      },
    };

    // Validate the final merged configuration
    return validateConfig(configWithDefaults);
  }

  /**
   * Deep merge two configuration objects
   * Later config values override earlier ones
   */
  mergeConfigs(target: DeepPartial<Config>, source: DeepPartial<Config>): DeepPartial<Config> {
    const result = { ...target };

    for (const [key, value] of Object.entries(source)) {
      if (value === null || value === undefined) {
        continue;
      }

      if (typeof value === 'object' && !Array.isArray(value) && key in result) {
        // Deep merge objects
        (result as Record<string, unknown>)[key] = this.mergeConfigs(
          ((result as Record<string, unknown>)[key] as DeepPartial<Config>) || {},
          value as DeepPartial<Config>
        );
      } else {
        // Direct assignment for primitives and arrays
        (result as Record<string, unknown>)[key] = value;
      }
    }

    return result;
  }
}

/**
 * Create a standard configuration loader with common sources
 */
export function createStandardLoader(): ConfigLoader {
  const loader = new ConfigLoader();
  const nodeEnv = process.env.NODE_ENV || 'development';

  // Load configuration in this order (later sources override earlier ones):
  // 1. Default configuration
  // 2. Environment-specific configuration
  // 3. Local configuration (ignored by git)
  // 4. Environment variables

  // Default configuration
  loader.addJsonFile(join(process.cwd(), 'config', 'default.json'), 'default');

  // Environment-specific configuration
  const envConfigPath = join(process.cwd(), 'config', `${nodeEnv}.json`);

  loader.addJsonFile(envConfigPath, `environment:${nodeEnv}`);

  // Local configuration (optional)
  const localConfigPath = join(process.cwd(), 'config', 'local.json');

  loader.addJsonFile(localConfigPath, 'local');

  // Environment variables (highest precedence)
  loader.addEnvironment();

  return loader;
}

/**
 * Singleton configuration instance
 */
let cachedConfig: Config | null = null;

/**
 * Get the application configuration
 * Configuration is loaded once and cached
 */
export async function getConfig(): Promise<Config> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const loader = createStandardLoader();

  cachedConfig = await loader.load();

  return cachedConfig;
}

/**
 * Reset the cached configuration (useful for testing)
 */
export function resetConfig(): void {
  cachedConfig = null;
}

/**
 * Load configuration from a specific file for testing
 */
export async function loadConfigFromFile(filePath: string): Promise<Config> {
  const loader = new ConfigLoader();

  loader.addJsonFile(filePath);

  return await loader.load();
}

/**
 * Create configuration from environment variables only
 */
export async function loadConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): Promise<Config> {
  const envConfig = validateEnv(env);
  const partialConfig = mapEnvToConfig(envConfig);

  // Ensure all required top-level objects exist before validation
  const configWithDefaults = {
    server: {},
    storage: {},
    auth: {},
    logging: {},
    ...partialConfig,
    // Ensure nested services objects are merged properly with defaults
    services: {
      pubsub: {},
      scheduler: {},
      tasks: {},
      secrets: {},
      storage: {},
      workflows: {},
      kms: {},
      memorystore: {},
      cloudsql: {},
      ...partialConfig.services,
    },
  };

  return validateConfig(configWithDefaults);
}
