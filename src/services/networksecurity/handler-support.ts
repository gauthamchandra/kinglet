/**
 * HTTP plumbing for Network Security address-group handlers.
 */

import type { RouteRequest, RouteResponse } from '@/core/gateway/request-router.ts';
import type { ResponseUtils } from '@/core/gateway/response-handlers.ts';
import { handleNetworkSecurityError } from './types.ts';

export async function respondWith(
  resourceType: string,
  responseUtils: ResponseUtils,
  produce: () => Promise<unknown>
): Promise<RouteResponse> {
  try {
    return responseUtils.success(await produce());
  } catch (err) {
    return handleNetworkSecurityError(err, resourceType, responseUtils);
  }
}

export function readQueryString(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;

  return value === undefined || value === '' ? undefined : value;
}

export function readBody(req: RouteRequest): Record<string, unknown> {
  return req.body !== null && typeof req.body === 'object'
    ? (req.body as Record<string, unknown>)
    : {};
}
