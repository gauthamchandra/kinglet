/**
 * GCP Workflows Standard Library
 *
 * Implements the built-in functions and modules available in GCP Workflows:
 * sys, http, json, base64, map, list, text, math, uuid, and built-in type functions.
 */

import { ErrorTag, WorkflowRuntimeError } from './types.ts';

export interface StdlibOptions {
  envVars: Record<string, string>;
  httpHandler?: (method: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Async stdlib resolver type — only HTTP functions return Promises,
 * the engine awaits the result of any call step.
 */
export type AsyncStdlibResolver = (name: string, args: unknown[]) => unknown | Promise<unknown>;

/**
 * Create a stdlib resolver function with the given options.
 */
export function createStdlib(options: StdlibOptions): AsyncStdlibResolver {
  const { envVars, httpHandler } = options;

  const registry: Record<string, (args: unknown[]) => unknown | Promise<unknown>> = {
    // ── Built-in Functions ──

    default: args => {
      return args[0] ?? args[1];
    },

    string: args => {
      const val = args[0];

      if (val === null) return 'null';

      if (typeof val === 'object') return JSON.stringify(val);

      return String(val);
    },

    int: args => {
      const val = args[0];

      if (typeof val === 'number') return Math.trunc(val);

      if (typeof val === 'string') {
        const parsed = parseInt(val, 10);

        if (Number.isNaN(parsed)) {
          throw new WorkflowRuntimeError(
            `Cannot convert '${val}' to int`,
            [ErrorTag.ValueError],
            0
          );
        }

        return parsed;
      }

      throw new WorkflowRuntimeError(
        `Cannot convert ${typeof val} to int`,
        [ErrorTag.ValueError],
        0
      );
    },

    double: args => {
      const val = args[0];

      if (typeof val === 'number') return val;

      if (typeof val === 'string') {
        const parsed = parseFloat(val);

        if (Number.isNaN(parsed)) {
          throw new WorkflowRuntimeError(
            `Cannot convert '${val}' to double`,
            [ErrorTag.ValueError],
            0
          );
        }

        return parsed;
      }

      throw new WorkflowRuntimeError(
        `Cannot convert ${typeof val} to double`,
        [ErrorTag.ValueError],
        0
      );
    },

    len: args => {
      const val = args[0];

      if (typeof val === 'string') return val.length;
      if (Array.isArray(val)) return val.length;
      if (val !== null && typeof val === 'object') return Object.keys(val).length;

      throw new WorkflowRuntimeError(`Cannot get length of ${typeof val}`, [ErrorTag.TypeError], 0);
    },

    keys: args => {
      const val = args[0];

      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        return Object.keys(val);
      }

      throw new WorkflowRuntimeError('keys() requires a map argument', [ErrorTag.TypeError], 0);
    },

    if: args => {
      return args[0] ? args[1] : args[2];
    },

    // ── sys module ──

    'sys.get_env': args => {
      const name = args[0] as string;

      if (!(name in envVars)) {
        throw new WorkflowRuntimeError(
          `Environment variable not found: '${name}'`,
          [ErrorTag.KeyError],
          0
        );
      }

      return envVars[name];
    },

    'sys.log': _args => {
      // No-op in emulator — real GCP logs to Cloud Logging
      return null;
    },

    'sys.now': () => {
      return Math.floor(Date.now() / 1000);
    },

    'sys.sleep': _args => {
      // No-op in emulator — real GCP pauses execution
      return null;
    },

    // ── json module ──

    'json.encode_to_string': args => {
      return JSON.stringify(args[0]);
    },

    'json.encode': args => {
      // In GCP Workflows, json.encode converts a value to a JSON-compatible form
      // For most types this is identity; for strings it parses JSON
      return args[0];
    },

    'json.decode': args => {
      const str = args[0] as string;

      try {
        return JSON.parse(str);
      } catch {
        throw new WorkflowRuntimeError(`Cannot decode JSON: ${str}`, [ErrorTag.ValueError], 0);
      }
    },

    // ── base64 module ──

    'base64.encode': args => {
      return btoa(args[0] as string);
    },

    'base64.decode': args => {
      return atob(args[0] as string);
    },

    // ── map module ──

    'map.get': args => {
      const obj = args[0] as Record<string, unknown>;
      const keyOrPath = args[1] as string;
      const hasDefault = args.length >= 3;

      // Support dot-path access
      const parts = keyOrPath.split('.');
      let current: unknown = obj;

      for (const part of parts) {
        if (current === null || current === undefined || typeof current !== 'object') {
          if (hasDefault) return args[2];

          throw new WorkflowRuntimeError(`Key not found: '${keyOrPath}'`, [ErrorTag.KeyError], 0);
        }

        const map = current as Record<string, unknown>;

        if (!(part in map)) {
          if (hasDefault) return args[2];

          throw new WorkflowRuntimeError(`Key not found: '${keyOrPath}'`, [ErrorTag.KeyError], 0);
        }

        current = map[part];
      }

      return current;
    },

    'map.merge': args => {
      const m1 = args[0] as Record<string, unknown>;
      const m2 = args[1] as Record<string, unknown>;

      return { ...m1, ...m2 };
    },

    'map.merge_nested': args => {
      const m1 = args[0] as Record<string, unknown>;
      const m2 = args[1] as Record<string, unknown>;

      return deepMerge(m1, m2);
    },

    'map.keys': args => {
      return Object.keys(args[0] as Record<string, unknown>);
    },

    'map.values': args => {
      return Object.values(args[0] as Record<string, unknown>);
    },

    // ── list module ──

    'list.concat': args => {
      const list = args[0] as unknown[];
      const item = args[1];

      if (Array.isArray(item)) {
        return [...list, ...item];
      }

      return [...list, item];
    },

    'list.prepend': args => {
      const list = args[0] as unknown[];
      const item = args[1];

      return [item, ...list];
    },

    'list.range': args => {
      const start = args[0] as number;
      const end = args[1] as number;
      const result: number[] = [];

      for (let i = start; i < end; i++) {
        result.push(i);
      }

      return result;
    },

    // ── text module ──

    'text.to_lower': args => {
      return (args[0] as string).toLowerCase();
    },

    'text.to_upper': args => {
      return (args[0] as string).toUpperCase();
    },

    'text.find_all': args => {
      const str = args[0] as string;
      const sub = args[1] as string;
      const indices: number[] = [];
      let pos = 0;

      while (pos <= str.length - sub.length) {
        const idx = str.indexOf(sub, pos);

        if (idx === -1) break;

        indices.push(idx);
        pos = idx + 1;
      }

      return indices;
    },

    'text.replace_all': args => {
      const str = args[0] as string;
      const search = args[1] as string;
      const replacement = args[2] as string;

      return str.split(search).join(replacement);
    },

    'text.split': args => {
      const str = args[0] as string;
      const delimiter = args[1] as string;

      return str.split(delimiter);
    },

    'text.substring': args => {
      const str = args[0] as string;
      const start = args[1] as number;
      const end = args[2] as number;

      return str.substring(start, end);
    },

    'text.url_encode': args => {
      return encodeURIComponent(args[0] as string).replace(/%20/g, '+');
    },

    // ── math module ──

    'math.abs': args => {
      return Math.abs(args[0] as number);
    },

    'math.max': args => {
      return Math.max(args[0] as number, args[1] as number);
    },

    'math.min': args => {
      return Math.min(args[0] as number, args[1] as number);
    },

    // ── uuid module ──

    'uuid.generate': () => {
      return crypto.randomUUID();
    },

    // ── http module ──

    'http.get': async args => {
      const callArgs = args[0] as Record<string, unknown>;

      return executeHttpCall('GET', callArgs, httpHandler);
    },

    'http.post': async args => {
      const callArgs = args[0] as Record<string, unknown>;

      return executeHttpCall('POST', callArgs, httpHandler);
    },

    'http.request': async args => {
      const callArgs = args[0] as Record<string, unknown>;
      const method = (callArgs.method as string) ?? 'GET';

      return executeHttpCall(method, callArgs, httpHandler);
    },

    'http.default_retry_predicate': args => {
      const err = args[0] as { tags?: string[]; code?: number };
      const tags = err.tags ?? [];
      const code = err.code ?? 0;

      // Retry on connection and timeout errors
      if (tags.includes('ConnectionError') || tags.includes('TimeoutError')) {
        return true;
      }

      // Retry on specific HTTP status codes
      if (tags.includes('HttpError') && [429, 502, 503, 504].includes(code)) {
        return true;
      }

      return false;
    },
  };

  return (name: string, args: unknown[]): unknown | Promise<unknown> => {
    const fn = registry[name];

    if (!fn) {
      throw new WorkflowRuntimeError(`Unknown function: ${name}`, [ErrorTag.ValueError], 0);
    }

    return fn(args);
  };
}

// ── Helpers ──

/**
 * Execute an HTTP call using native fetch(), or delegate to a custom handler.
 * Returns the GCP Workflows HTTP response object: { body, code, headers }.
 * Non-2xx responses raise HttpError per gotchas §9.
 */
async function executeHttpCall(
  method: string,
  callArgs: Record<string, unknown>,
  customHandler?: (method: string, args: Record<string, unknown>) => Promise<unknown>
): Promise<unknown> {
  if (customHandler) {
    return customHandler(method, callArgs);
  }

  const url = callArgs.url as string;
  const headers = { ...((callArgs.headers as Record<string, string>) ?? {}) };
  const body = callArgs.body;
  const timeoutSec = (callArgs.timeout as number) ?? 300;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutSec * 1000);

  try {
    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };

    if (body !== undefined && method !== 'GET') {
      fetchOptions.body = JSON.stringify(body);

      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const response = await fetch(url, fetchOptions);

    clearTimeout(timeoutId);

    const responseHeaders: Record<string, string> = {};

    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    let responseBody: unknown;

    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.includes('application/json')) {
      responseBody = await response.json();
    } else {
      responseBody = await response.text();
    }

    const result = { body: responseBody, code: response.status, headers: responseHeaders };

    if (response.status >= 400) {
      const error = new WorkflowRuntimeError(
        `HTTP request failed with status ${response.status}`,
        [ErrorTag.HttpError],
        response.status
      );

      (error as WorkflowRuntimeError & { httpResponse: typeof result }).httpResponse = result;

      throw error;
    }

    return result;
  } catch (err) {
    clearTimeout(timeoutId);

    if (err instanceof WorkflowRuntimeError) throw err;

    if (err instanceof Error && err.name === 'AbortError') {
      throw new WorkflowRuntimeError(
        `HTTP request timed out after ${timeoutSec}s`,
        [ErrorTag.TimeoutError],
        0
      );
    }

    throw new WorkflowRuntimeError(
      `HTTP connection error: ${err instanceof Error ? err.message : String(err)}`,
      [ErrorTag.ConnectionError],
      0
    );
  }
}

function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...a };

  for (const key of Object.keys(b)) {
    const aVal = a[key];
    const bVal = b[key];

    if (
      aVal !== null &&
      bVal !== null &&
      typeof aVal === 'object' &&
      typeof bVal === 'object' &&
      !Array.isArray(aVal) &&
      !Array.isArray(bVal)
    ) {
      result[key] = deepMerge(aVal as Record<string, unknown>, bVal as Record<string, unknown>);
    } else {
      result[key] = bVal;
    }
  }

  return result;
}
