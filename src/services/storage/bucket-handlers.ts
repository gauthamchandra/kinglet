/**
 * Bucket HTTP route handlers for Cloud Storage
 */

import type {
  RouteContext,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import type { BucketService } from './bucket-service.ts';
import { GcsError } from './bucket-service.ts';

export class BucketHandlers {
  private service: BucketService;
  private responseUtils: ResponseUtils;

  constructor(service: BucketService, logger: Logger) {
    this.service = service;
    const formatter = new StandardResponseFormatter(logger);
    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'storage.buckets.insert',
        method: 'POST',
        path: '/storage/v1/b',
        handler: (req, ctx) => this.handleInsertBucket(req, ctx),
      },
      {
        id: 'storage.buckets.get',
        method: 'GET',
        path: '/storage/v1/b/:bucket',
        handler: (req, ctx) => this.handleGetBucket(req, ctx),
      },
      {
        id: 'storage.buckets.list',
        method: 'GET',
        path: '/storage/v1/b',
        handler: (req, ctx) => this.handleListBuckets(req, ctx),
      },
      {
        id: 'storage.buckets.delete',
        method: 'DELETE',
        path: '/storage/v1/b/:bucket',
        handler: (req, ctx) => this.handleDeleteBucket(req, ctx),
      },
      {
        id: 'storage.buckets.patch',
        method: 'PATCH',
        path: '/storage/v1/b/:bucket',
        handler: (req, ctx) => this.handlePatchBucket(req, ctx),
      },
      {
        id: 'storage.buckets.update',
        method: 'PUT',
        path: '/storage/v1/b/:bucket',
        handler: (req, ctx) => this.handleUpdateBucket(req, ctx),
      },
    ];
  }

  private async handleInsertBucket(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const project = (req.query.project as string) ?? '';
      const result = await this.service.createBucket(project, req.body);
      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleGetBucket(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.getBucket(req.params.bucket ?? '');
      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleListBuckets(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const project = (req.query.project as string) ?? '';
      const pageSizeRaw = req.query.maxResults
        ? parseInt(req.query.maxResults as string, 10)
        : undefined;
      const pageSize =
        pageSizeRaw && !Number.isNaN(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : undefined;
      const pageToken = (req.query.pageToken as string) || undefined;

      const result = await this.service.listBuckets(project, pageSize, pageToken);
      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleDeleteBucket(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      await this.service.deleteBucket(req.params.bucket ?? '');
      return { status: 204 };
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handlePatchBucket(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.patchBucket(req.params.bucket ?? '', req.body);
      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleUpdateBucket(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.updateBucket(req.params.bucket ?? '', req.body);
      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private handleError(err: unknown): RouteResponse {
    if (err instanceof GcsError) {
      switch (err.code) {
        case 'NOT_FOUND':
          return this.responseUtils.notFound('Bucket', err.message);
        case 'ALREADY_EXISTS':
          return this.responseUtils.alreadyExists('Bucket', err.message);
        case 'INVALID_ARGUMENT':
          return this.responseUtils.badRequest(err.message);
        case 'FAILED_PRECONDITION':
          return this.responseUtils.failedPrecondition(err.message);
      }
    }

    return this.responseUtils.badRequest(err instanceof Error ? err.message : 'Unknown error');
  }
}
