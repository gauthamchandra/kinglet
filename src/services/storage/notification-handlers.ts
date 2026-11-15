/**
 * Notification HTTP route handlers for Cloud Storage
 */

import type {
  RouteContext,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { handleGcsError } from './error-handler.ts';
import type { NotificationService } from './notification-service.ts';

export class NotificationHandlers {
  private service: NotificationService;
  private responseUtils: ResponseUtils;

  constructor(service: NotificationService, logger: Logger) {
    this.service = service;
    const formatter = new StandardResponseFormatter(logger);
    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'storage.notifications.insert',
        method: 'POST',
        path: '/storage/v1/b/:bucket/notificationConfigs',
        handler: (req, ctx) => this.handleInsert(req, ctx),
      },
      {
        id: 'storage.notifications.get',
        method: 'GET',
        path: '/storage/v1/b/:bucket/notificationConfigs/:notification',
        handler: (req, ctx) => this.handleGet(req, ctx),
      },
      {
        id: 'storage.notifications.list',
        method: 'GET',
        path: '/storage/v1/b/:bucket/notificationConfigs',
        handler: (req, ctx) => this.handleList(req, ctx),
      },
      {
        id: 'storage.notifications.delete',
        method: 'DELETE',
        path: '/storage/v1/b/:bucket/notificationConfigs/:notification',
        handler: (req, ctx) => this.handleDelete(req, ctx),
      },
    ];
  }

  private async handleInsert(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.insertNotification(req.params.bucket ?? '', req.body);
      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleGet(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.getNotification(
        req.params.bucket ?? '',
        req.params.notification ?? ''
      );
      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleList(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.listNotifications(req.params.bucket ?? '');
      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleDelete(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      await this.service.deleteNotification(req.params.bucket ?? '', req.params.notification ?? '');
      return { status: 204 };
    } catch (err) {
      return this.handleError(err);
    }
  }

  private handleError(err: unknown): RouteResponse {
    return handleGcsError(err, 'Notification', this.responseUtils);
  }
}
