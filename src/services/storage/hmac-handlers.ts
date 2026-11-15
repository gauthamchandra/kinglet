/**
 * HMAC key HTTP routes for Cloud Storage.
 *
 * `userProject` is accepted and ignored. The create body is ignored:
 * discovery defines no request schema, and a new key is always ACTIVE.
 */

import type {
  RouteContext,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { parsePageSize } from '@/shared/utils/pagination.ts';
import { handleGcsError } from './error-handler.ts';
import type { HmacKeyService } from './hmac-service.ts';

function readQueryString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return readQueryString(value[0]);
  }

  if (value == null || value.length === 0) {
    return undefined;
  }

  return value;
}

export class HmacKeyHandlers {
  private service: HmacKeyService;
  private responseUtils: ResponseUtils;

  constructor(service: HmacKeyService, logger: Logger) {
    this.service = service;
    const formatter = new StandardResponseFormatter(logger);
    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'storage.projects.hmacKeys.create',
        method: 'POST',
        path: '/storage/v1/projects/:projectId/hmacKeys',
        handler: (req, ctx) => this.handleCreate(req, ctx),
      },
      {
        id: 'storage.projects.hmacKeys.get',
        method: 'GET',
        path: '/storage/v1/projects/:projectId/hmacKeys/:accessId',
        handler: (req, ctx) => this.handleGet(req, ctx),
      },
      {
        id: 'storage.projects.hmacKeys.list',
        method: 'GET',
        path: '/storage/v1/projects/:projectId/hmacKeys',
        handler: (req, ctx) => this.handleList(req, ctx),
      },
      {
        id: 'storage.projects.hmacKeys.update',
        method: 'PUT',
        path: '/storage/v1/projects/:projectId/hmacKeys/:accessId',
        handler: (req, ctx) => this.handleUpdate(req, ctx),
      },
      {
        id: 'storage.projects.hmacKeys.delete',
        method: 'DELETE',
        path: '/storage/v1/projects/:projectId/hmacKeys/:accessId',
        handler: (req, ctx) => this.handleDelete(req, ctx),
      },
    ];
  }

  private async handleCreate(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.createKey(
        req.params.projectId ?? '',
        readQueryString(req.query.serviceAccountEmail) ?? ''
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleGet(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.getKey(
        req.params.projectId ?? '',
        req.params.accessId ?? ''
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleList(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.listKeys(req.params.projectId ?? '', {
        maxResults: parsePageSize(
          Array.isArray(req.query.maxResults) ? req.query.maxResults[0] : req.query.maxResults
        ),
        pageToken: readQueryString(req.query.pageToken),
        serviceAccountEmail: readQueryString(req.query.serviceAccountEmail),
        showDeletedKeys: readQueryString(req.query.showDeletedKeys)?.toLowerCase() === 'true',
      });

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleUpdate(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.updateKey(
        req.params.projectId ?? '',
        req.params.accessId ?? '',
        req.body
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleDelete(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      await this.service.deleteKey(req.params.projectId ?? '', req.params.accessId ?? '');

      return { status: 204 };
    } catch (err) {
      return this.handleError(err);
    }
  }

  private handleError(err: unknown): RouteResponse {
    return handleGcsError(err, 'Access ID', this.responseUtils);
  }
}
