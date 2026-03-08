/**
 * Shared E2E test utilities
 *
 * Generic infrastructure for black-box e2e tests: request routing,
 * callback recording, and fake auth for GCP client libraries.
 */

import { Logger } from '@/shared/utils/logger.ts';
import type { RouteDefinition } from '@/core/gateway/request-router.ts';

// ── Types ──

export interface CallbackRecord {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  receivedAt: number;
}

// ── Router ──

/**
 * Build a simple request router from RouteDefinition[] for use with Bun.serve
 */
export function buildRouter(routes: RouteDefinition[]) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;

    for (const route of routes) {
      if (route.method !== method) continue;

      const params = matchRoute(route.path, pathname);

      if (params) {
        const query: Record<string, string> = {};

        for (const [key, value] of url.searchParams.entries()) {
          query[key] = value;
        }

        let body: unknown;
        const contentType = request.headers.get('content-type') ?? '';

        if (contentType.includes('application/json')) {
          try {
            body = await request.json();
          } catch {
            body = undefined;
          }
        }

        const routeRequest = {
          method,
          path: pathname,
          query,
          headers: Object.fromEntries(request.headers.entries()),
          params,
          body,
          originalRequest: request,
        };

        const context = {
          routeId: route.id,
          startTime: Date.now(),
          metadata: {},
          logger: new Logger('e2e', 'error'),
        };

        const result = await route.handler(routeRequest, context);

        // Support binary responses (e.g., object media downloads)
        if (result.body instanceof Uint8Array) {
          return new Response(result.body, {
            status: result.status,
            headers: result.headers ?? {},
          });
        }

        return new Response(result.body !== undefined ? JSON.stringify(result.body) : null, {
          status: result.status,
          headers: {
            'content-type': 'application/json',
            ...(result.headers ?? {}),
          },
        });
      }
    }

    return new Response(
      JSON.stringify({ error: { code: 404, message: 'Not Found', status: 'NOT_FOUND' } }),
      {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }
    );
  };
}

/**
 * Simple route pattern matcher: converts :param patterns to extracted values.
 * Handles GCP action suffixes like :pause, :resume, :run on the last segment.
 * E.g., pattern "/jobs/:jobId:pause" matches path "/jobs/my-job:pause"
 */
export function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i] ?? '';
    const pathPart = pathParts[i] ?? '';

    // Check for action suffix pattern like :jobId:pause
    const actionMatch = pp.match(/^:([^:]+)(:[a-zA-Z]+)$/);

    if (actionMatch) {
      const paramName = actionMatch[1] as string;
      const actionSuffix = actionMatch[2] as string;

      if (!pathPart.endsWith(actionSuffix)) return null;

      params[paramName] = pathPart.substring(0, pathPart.length - actionSuffix.length);
    } else if (pp.startsWith(':')) {
      params[pp.substring(1)] = pathPart;
    } else if (pp !== pathPart) {
      return null;
    }
  }

  return params;
}

// ── Callback Helpers ──

/**
 * Poll a callback array until expectedCount records are present (or timeout).
 */
export async function waitForCallback(
  requests: CallbackRecord[],
  expectedCount: number = 1,
  timeoutMs: number = 5000
): Promise<void> {
  const start = Date.now();

  while (requests.length < expectedCount) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for ${expectedCount} callback(s). Got ${requests.length}.`);
    }

    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

// ── Auth Helpers ──

/**
 * Build a fake auth object for GCP client library tests.
 * Bypasses real GCP credentials by routing requests through plain fetch.
 */
export function createFakeAuth(project: string) {
  return {
    fetch: (url: string, opts: RequestInit) => fetch(url, opts),
    getClient: () =>
      Promise.resolve({
        fetch: (url: string, opts: RequestInit) => fetch(url, opts),
      }),
    getProjectId: () => Promise.resolve(project),
  };
}
