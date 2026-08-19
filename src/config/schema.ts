/**
 * Configuration schema using Zod for type-safe configuration
 */

import { z } from 'zod';

// Server configuration schema
const ServerConfigSchema = z.object({
  httpPort: z.number().int().min(1).max(65535).default(8765),
  grpcPort: z.number().int().min(1).max(65535).default(8766),
  maxConnections: z.number().int().min(1).default(100),
});

// Storage configuration schema
const StorageConfigSchema = z.object({
  type: z.enum(['memory', 'sqlite', 'hybrid']).default('hybrid'),
  sqlitePath: z.string().optional().default('./data/emulator.db'),
  cacheSize: z.number().int().min(0).default(104857600), // 100MB
});

// Authentication configuration schema
const AuthConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(['bypass', 'mock', 'validate']).default('bypass'),
  mockCredentials: z
    .object({
      projectId: z.string().default('kinglet-project'),
      serviceAccount: z.string().default('kinglet@kinglet-project.iam.gserviceaccount.com'),
    })
    .optional(),
});

// Services configuration schema
const ServicesConfigSchema = z.object({
  // `.prefault({})` rather than a bare object: every sibling here is a required
  // key, kept satisfiable only by the per-service `{}` literals hardcoded in
  // src/config/loader.ts. Defaulting the whole block means a partial
  // config/local.json cannot turn into a startup Zod failure.
  alloydb: z.object({ enabled: z.boolean().default(true) }).prefault({}),
  pubsub: z.object({ enabled: z.boolean().default(true) }),
  scheduler: z.object({ enabled: z.boolean().default(true) }),
  tasks: z.object({ enabled: z.boolean().default(true) }),
  secrets: z.object({ enabled: z.boolean().default(true) }),
  storage: z.object({ enabled: z.boolean().default(true) }),
  workflows: z.object({ enabled: z.boolean().default(true) }),
  memorystore: z
    .object({
      enabled: z.boolean().default(true),
      dataPlane: z
        .object({
          // On by default: a Memorystore instance you cannot actually connect a
          // Valkey client to is metadata, not emulation. Set
          // MEMORYSTORE_DATA_PLANE=false for the metadata-only control plane.
          // When the binary is absent this degrades to metadata-only endpoints
          // anyway (see ValkeyProcessManager), so defaulting to `true` cannot
          // harden into a startup failure on a host without valkey-server.
          enabled: z.boolean().default(true),
          binaryPath: z.string().optional(),
          // 6380 onwards sits next to the well-known Valkey/Redis port without
          // colliding with a valkey the developer may already run on 6379.
          // Deliberately NOT 7000-7099: macOS ships AirPlay Receiver listening
          // on 7000, so the first instance a Mac developer created would appear
          // to bind fine and then answer with something that is not Valkey.
          portRangeStart: z.number().int().min(1).max(65535).default(6380),
          portRangeEnd: z.number().int().min(1).max(65535).default(6479),
        })
        .refine(dataPlane => dataPlane.portRangeStart <= dataPlane.portRangeEnd, {
          message: 'portRangeStart must be less than or equal to portRangeEnd',
          path: ['portRangeStart'],
        })
        .prefault({}),
    })
    .prefault({}),
});

// Logging configuration schema
const LoggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  format: z.enum(['json', 'pretty']).default('json'),
});

// Main configuration schema
export const ConfigSchema = z.object({
  server: ServerConfigSchema,
  storage: StorageConfigSchema,
  auth: AuthConfigSchema,
  services: ServicesConfigSchema,
  logging: LoggingConfigSchema,
});

// Infer the TypeScript type from the schema
export type Config = z.infer<typeof ConfigSchema>;

// Deep partial type for configuration merging
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// Environment variable mapping schema
export const EnvConfigSchema = z.object({
  // Server configuration
  PORT: z.string().transform(Number).pipe(z.number().int().min(1).max(65535)).optional(),
  HTTP_PORT: z.string().transform(Number).pipe(z.number().int().min(1).max(65535)).optional(),
  GRPC_PORT: z.string().transform(Number).pipe(z.number().int().min(1).max(65535)).optional(),
  MAX_CONNECTIONS: z.string().transform(Number).pipe(z.number().int().min(1)).optional(),

  // Storage configuration
  STORAGE_TYPE: z.enum(['memory', 'sqlite', 'hybrid']).optional(),
  SQLITE_PATH: z.string().optional(),
  CACHE_SIZE: z.string().transform(Number).pipe(z.number().int().min(0)).optional(),

  // Authentication configuration
  AUTH_ENABLED: z
    .string()
    .transform(val => val.toLowerCase() === 'true')
    .optional(),
  AUTH_MODE: z.enum(['bypass', 'mock', 'validate']).optional(),
  MOCK_PROJECT_ID: z.string().optional(),
  MOCK_SERVICE_ACCOUNT: z.string().optional(),

  // Services configuration
  SERVICES: z.string().optional(), // Comma-separated list like "pubsub,scheduler"
  ENABLE_PUBSUB: z
    .string()
    .transform(val => val.toLowerCase() === 'true')
    .optional(),
  ENABLE_SCHEDULER: z
    .string()
    .transform(val => val.toLowerCase() === 'true')
    .optional(),
  ENABLE_TASKS: z
    .string()
    .transform(val => val.toLowerCase() === 'true')
    .optional(),
  ENABLE_SECRETS: z
    .string()
    .transform(val => val.toLowerCase() === 'true')
    .optional(),
  ENABLE_STORAGE: z
    .string()
    .transform(val => val.toLowerCase() === 'true')
    .optional(),
  ENABLE_WORKFLOWS: z
    .string()
    .transform(val => val.toLowerCase() === 'true')
    .optional(),
  ENABLE_ALLOYDB: z
    .string()
    .transform(val => val.toLowerCase() === 'true')
    .optional(),
  ENABLE_MEMORYSTORE: z
    .string()
    .transform(val => val.toLowerCase() === 'true')
    .optional(),
  MEMORYSTORE_DATA_PLANE: z
    .string()
    .transform(val => val.toLowerCase() === 'true')
    .optional(),
  MEMORYSTORE_VALKEY_BINARY: z.string().optional(),
  MEMORYSTORE_PORT_RANGE_START: z
    .string()
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535))
    .optional(),
  MEMORYSTORE_PORT_RANGE_END: z
    .string()
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535))
    .optional(),

  // Logging configuration
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  LOG_FORMAT: z.enum(['json', 'pretty']).optional(),

  // Node environment
  NODE_ENV: z.enum(['development', 'production', 'test']).optional().default('development'),
});

export type EnvConfig = z.infer<typeof EnvConfigSchema>;

/**
 * Map environment variables to configuration structure
 */
export function mapEnvToConfig(env: Partial<EnvConfig>): DeepPartial<Config> {
  const config: DeepPartial<Config> = {};

  // Map server configuration
  if (
    env.PORT !== undefined ||
    env.HTTP_PORT !== undefined ||
    env.GRPC_PORT !== undefined ||
    env.MAX_CONNECTIONS !== undefined
  ) {
    config.server = {};
    if (env.PORT !== undefined) config.server.httpPort = env.PORT;
    if (env.HTTP_PORT !== undefined) config.server.httpPort = env.HTTP_PORT;
    if (env.GRPC_PORT !== undefined) config.server.grpcPort = env.GRPC_PORT;
    if (env.MAX_CONNECTIONS !== undefined) config.server.maxConnections = env.MAX_CONNECTIONS;
  }

  // Map storage configuration
  if (
    env.STORAGE_TYPE !== undefined ||
    env.SQLITE_PATH !== undefined ||
    env.CACHE_SIZE !== undefined
  ) {
    config.storage = {};
    if (env.STORAGE_TYPE !== undefined) config.storage.type = env.STORAGE_TYPE;
    if (env.SQLITE_PATH !== undefined) config.storage.sqlitePath = env.SQLITE_PATH;
    if (env.CACHE_SIZE !== undefined) config.storage.cacheSize = env.CACHE_SIZE;
  }

  // Map authentication configuration
  if (
    env.AUTH_ENABLED !== undefined ||
    env.AUTH_MODE !== undefined ||
    env.MOCK_PROJECT_ID !== undefined ||
    env.MOCK_SERVICE_ACCOUNT !== undefined
  ) {
    config.auth = {};
    if (env.AUTH_ENABLED !== undefined) config.auth.enabled = env.AUTH_ENABLED;
    if (env.AUTH_MODE !== undefined) config.auth.mode = env.AUTH_MODE;
    if (env.MOCK_PROJECT_ID !== undefined || env.MOCK_SERVICE_ACCOUNT !== undefined) {
      config.auth.mockCredentials = {
        projectId: env.MOCK_PROJECT_ID || 'kinglet-project',
        serviceAccount:
          env.MOCK_SERVICE_ACCOUNT || 'kinglet@kinglet-project.iam.gserviceaccount.com',
      };
    }
  }

  // Map services configuration
  const hasServiceConfig =
    env.SERVICES !== undefined ||
    env.ENABLE_PUBSUB !== undefined ||
    env.ENABLE_SCHEDULER !== undefined ||
    env.ENABLE_TASKS !== undefined ||
    env.ENABLE_SECRETS !== undefined ||
    env.ENABLE_STORAGE !== undefined ||
    env.ENABLE_WORKFLOWS !== undefined ||
    env.ENABLE_ALLOYDB !== undefined ||
    env.ENABLE_MEMORYSTORE !== undefined ||
    env.MEMORYSTORE_DATA_PLANE !== undefined ||
    env.MEMORYSTORE_VALKEY_BINARY !== undefined ||
    env.MEMORYSTORE_PORT_RANGE_START !== undefined ||
    env.MEMORYSTORE_PORT_RANGE_END !== undefined;

  if (hasServiceConfig) {
    config.services = {};

    // Map services configuration from SERVICES environment variable
    if (env.SERVICES !== undefined) {
      const enabledServices = env.SERVICES.split(',').map(s => s.trim().toLowerCase());

      config.services.pubsub = { enabled: enabledServices.includes('pubsub') };
      config.services.scheduler = { enabled: enabledServices.includes('scheduler') };
      config.services.tasks = { enabled: enabledServices.includes('tasks') };
      config.services.secrets = { enabled: enabledServices.includes('secrets') };
      config.services.storage = { enabled: enabledServices.includes('storage') };
      config.services.workflows = { enabled: enabledServices.includes('workflows') };
      config.services.memorystore = { enabled: enabledServices.includes('memorystore') };
      config.services.alloydb = { enabled: enabledServices.includes('alloydb') };
    }

    // Map individual service enablement
    if (env.ENABLE_PUBSUB !== undefined) {
      if (!config.services.pubsub) config.services.pubsub = {};
      config.services.pubsub.enabled = env.ENABLE_PUBSUB;
    }
    if (env.ENABLE_SCHEDULER !== undefined) {
      if (!config.services.scheduler) config.services.scheduler = {};
      config.services.scheduler.enabled = env.ENABLE_SCHEDULER;
    }
    if (env.ENABLE_TASKS !== undefined) {
      if (!config.services.tasks) config.services.tasks = {};
      config.services.tasks.enabled = env.ENABLE_TASKS;
    }
    if (env.ENABLE_SECRETS !== undefined) {
      if (!config.services.secrets) config.services.secrets = {};
      config.services.secrets.enabled = env.ENABLE_SECRETS;
    }
    if (env.ENABLE_STORAGE !== undefined) {
      if (!config.services.storage) config.services.storage = {};
      config.services.storage.enabled = env.ENABLE_STORAGE;
    }

    if (env.ENABLE_WORKFLOWS !== undefined) {
      if (!config.services.workflows) config.services.workflows = {};
      config.services.workflows.enabled = env.ENABLE_WORKFLOWS;
    }

    if (env.ENABLE_ALLOYDB !== undefined) {
      if (!config.services.alloydb) config.services.alloydb = {};
      config.services.alloydb.enabled = env.ENABLE_ALLOYDB;
    }

    if (env.ENABLE_MEMORYSTORE !== undefined) {
      if (!config.services.memorystore) config.services.memorystore = {};
      config.services.memorystore.enabled = env.ENABLE_MEMORYSTORE;
    }

    if (
      env.MEMORYSTORE_DATA_PLANE !== undefined ||
      env.MEMORYSTORE_VALKEY_BINARY !== undefined ||
      env.MEMORYSTORE_PORT_RANGE_START !== undefined ||
      env.MEMORYSTORE_PORT_RANGE_END !== undefined
    ) {
      if (!config.services.memorystore) config.services.memorystore = {};

      const dataPlane: NonNullable<
        NonNullable<DeepPartial<Config>['services']>['memorystore']
      >['dataPlane'] = {};

      if (env.MEMORYSTORE_DATA_PLANE !== undefined) dataPlane.enabled = env.MEMORYSTORE_DATA_PLANE;
      if (env.MEMORYSTORE_VALKEY_BINARY !== undefined) {
        dataPlane.binaryPath = env.MEMORYSTORE_VALKEY_BINARY;
      }
      if (env.MEMORYSTORE_PORT_RANGE_START !== undefined) {
        dataPlane.portRangeStart = env.MEMORYSTORE_PORT_RANGE_START;
      }
      if (env.MEMORYSTORE_PORT_RANGE_END !== undefined) {
        dataPlane.portRangeEnd = env.MEMORYSTORE_PORT_RANGE_END;
      }

      config.services.memorystore.dataPlane = dataPlane;
    }
  }

  // Map logging configuration
  if (env.LOG_LEVEL !== undefined || env.LOG_FORMAT !== undefined) {
    config.logging = {};
    if (env.LOG_LEVEL !== undefined) config.logging.level = env.LOG_LEVEL;
    if (env.LOG_FORMAT !== undefined) config.logging.format = env.LOG_FORMAT;
  }

  return config;
}

/**
 * Validate configuration object against schema
 */
export function validateConfig(config: unknown): Config {
  return ConfigSchema.parse(config);
}

/**
 * Validate environment variables against schema
 */
export function validateEnv(env: Record<string, string | undefined> = process.env): EnvConfig {
  return EnvConfigSchema.parse(env);
}
