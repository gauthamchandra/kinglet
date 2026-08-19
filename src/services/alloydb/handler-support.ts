/**
 * HTTP plumbing shared by the AlloyDB handler classes.
 *
 * <p>Every AlloyDB endpoint has the same shape — read params, call the service,
 * serialize — so the try/catch that maps a domain error onto a GCP error envelope
 * lives here instead of being written out once per method.
 */

import type { RouteRequest, RouteResponse } from '@/core/gateway/request-router.ts';
import type { ResponseUtils } from '@/core/gateway/response-handlers.ts';
import { handleAlloyDbError } from './types.ts';

/**
 * Run a service call and serialize whatever it returns, converting a thrown
 * {@link AlloyDbError} into the matching GCP error envelope.
 *
 * @param resourceType the route's primary resource, used when the error does not
 *     name one of its own (e.g. a `Cluster` 404 raised by `users.create`).
 */
export async function respondWith(
  resourceType: string,
  responseUtils: ResponseUtils,
  produce: () => Promise<unknown>
): Promise<RouteResponse> {
  try {
    return responseUtils.success(await produce());
  } catch (err) {
    return handleAlloyDbError(err, resourceType, responseUtils);
  }
}

/**
 * Read a query parameter as a single string.
 *
 * <p>A repeated parameter (`?updateMask=a&updateMask=b`) arrives as an array;
 * the last value wins, matching how query strings are normally collapsed.
 */
export function readQueryString(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;

  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;

  return value === undefined || value === '' ? undefined : value;
}

/**
 * Read a boolean query parameter.
 *
 * <p>Absent means absent, not `false`: the caller distinguishes "not specified"
 * from an explicit `false` so an unspecified `allowMissing` cannot be mistaken for
 * a deliberate one. A bare flag (`?validateOnly`) counts as true, which is how
 * `URLSearchParams` renders a valueless parameter.
 */
export function parseBooleanFlag(raw: string | string[] | undefined): boolean | undefined {
  const value = readQueryString(raw);

  if (value === undefined) return raw === '' ? true : undefined;

  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Read a JSON request body as an object.
 *
 * <p>An absent or non-object body becomes `{}` rather than an error: every AlloyDB
 * mutation carries its identifying id in the query string, so a bodyless request
 * is a legitimate "create with all defaults" rather than something to reject.
 */
export function readBody(req: RouteRequest): Record<string, unknown> {
  return req.body !== null && typeof req.body === 'object'
    ? (req.body as Record<string, unknown>)
    : {};
}
