/**
 * Bucket IAM HTTP routes.
 *
 * Discovery: https://storage.googleapis.com/$discovery/rest?version=v1
 * buckets.getIamPolicy, buckets.setIamPolicy, buckets.testIamPermissions.
 */

import type {
  RouteContext,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { GcsError } from './bucket-service.ts';
import { handleGcsError } from './error-handler.ts';
import type { IamService } from './iam-service.ts';

export class IamHandlers {
  private service: IamService;
  private responseUtils: ResponseUtils;

  constructor(service: IamService, logger: Logger) {
    this.service = service;
    const formatter = new StandardResponseFormatter(logger);
    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'storage.buckets.getIamPolicy',
        method: 'GET',
        path: '/storage/v1/b/:bucket/iam',
        handler: (req, ctx) => this.handleGetIamPolicy(req, ctx),
      },
      {
        id: 'storage.buckets.setIamPolicy',
        method: 'PUT',
        path: '/storage/v1/b/:bucket/iam',
        handler: (req, ctx) => this.handleSetIamPolicy(req, ctx),
      },
      {
        id: 'storage.buckets.testIamPermissions',
        method: 'GET',
        path: '/storage/v1/b/:bucket/iam/testPermissions',
        handler: (req, ctx) => this.handleTestIamPermissions(req, ctx),
      },
    ];
  }

  private async handleGetIamPolicy(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.getIamPolicy(req.params.bucket ?? '');
      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleSetIamPolicy(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.setIamPolicy(req.params.bucket ?? '', req.body);
      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleTestIamPermissions(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const permissions = readPermissions(req.query);
      const result = await this.service.testIamPermissions(req.params.bucket ?? '', permissions);
      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private handleError(err: unknown): RouteResponse {
    return handleGcsError(err, 'Bucket', this.responseUtils);
  }
}

function readPermissions(query: RouteRequest['query']): string[] {
  const raw = query.permissions;

  if (typeof raw === 'string' && raw.length > 0) {
    return [raw];
  }

  if (Array.isArray(raw) && raw.length > 0 && raw.every(permission => permission.length > 0)) {
    return raw;
  }

  throw new GcsError('INVALID_ARGUMENT', 'permissions is required');
}
