/**
 * Shared GCS error-to-HTTP response mapping
 */

import type { RouteResponse } from '@/core/gateway/request-router.ts';
import type { ResponseUtils } from '@/core/gateway/response-handlers.ts';
import { GcsError } from './bucket-service.ts';

export function handleGcsError(
  err: unknown,
  resourceType: string,
  responseUtils: ResponseUtils
): RouteResponse {
  if (err instanceof GcsError) {
    switch (err.code) {
      case 'NOT_FOUND':
        return responseUtils.notFound(resourceType, err.message);
      case 'ALREADY_EXISTS':
        return responseUtils.alreadyExists(resourceType, err.message);
      case 'INVALID_ARGUMENT':
        return responseUtils.badRequest(err.message);
      case 'FAILED_PRECONDITION':
        return responseUtils.conflict(err.message);
    }
  }

  return responseUtils.badRequest(err instanceof Error ? err.message : 'Unknown error');
}
