/**
 * Queue HTTP route handlers for Cloud Tasks
 */

import type {
  RouteContext,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import type { QueueService } from './queue-service.ts';
import { handleTasksError } from './queue-service.ts';
import { buildQueueName, parseQueueName } from './types.ts';

export class QueueHandlers {
  private service: QueueService;
  private responseUtils: ResponseUtils;
  private logger: Logger;

  constructor(service: QueueService, logger: Logger) {
    this.service = service;
    this.logger = logger;
    const formatter = new StandardResponseFormatter(logger);

    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'tasks.queues.create',
        method: 'POST',
        path: '/v2/projects/:project/locations/:location/queues',
        handler: (req, ctx) => this.handleCreateQueue(req, ctx),
      },
      {
        id: 'tasks.queues.get',
        method: 'GET',
        path: '/v2/projects/:project/locations/:location/queues/:queueId',
        handler: (req, ctx) => this.handleGetQueue(req, ctx),
      },
      {
        id: 'tasks.queues.list',
        method: 'GET',
        path: '/v2/projects/:project/locations/:location/queues',
        handler: (req, ctx) => this.handleListQueues(req, ctx),
      },
      {
        id: 'tasks.queues.patch',
        method: 'PATCH',
        path: '/v2/projects/:project/locations/:location/queues/:queueId',
        handler: (req, ctx) => this.handleUpdateQueue(req, ctx),
      },
      {
        id: 'tasks.queues.delete',
        method: 'DELETE',
        path: '/v2/projects/:project/locations/:location/queues/:queueId',
        handler: (req, ctx) => this.handleDeleteQueue(req, ctx),
      },
      {
        id: 'tasks.queues.pause',
        method: 'POST',
        path: '/v2/projects/:project/locations/:location/queues/:queueId:pause',
        handler: (req, ctx) => this.handlePauseQueue(req, ctx),
      },
      {
        id: 'tasks.queues.resume',
        method: 'POST',
        path: '/v2/projects/:project/locations/:location/queues/:queueId:resume',
        handler: (req, ctx) => this.handleResumeQueue(req, ctx),
      },
      {
        id: 'tasks.queues.purge',
        method: 'POST',
        path: '/v2/projects/:project/locations/:location/queues/:queueId:purge',
        handler: (req, ctx) => this.handlePurgeQueue(req, ctx),
      },
    ];
  }

  private async handleCreateQueue(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, location } = req.params;
      const body = req.body as Record<string, unknown> | undefined;

      let queueId =
        (typeof body?.queueId === 'string' ? body.queueId : undefined) ??
        String(req.query.queueId ?? '');

      if (!queueId && typeof body?.name === 'string') {
        try {
          const parsed = parseQueueName(body.name);

          queueId = parsed.queueId;
        } catch (err) {
          this.logger.debug(`Could not parse queue name from body.name: ${body.name}`, err);
        }
      }

      const result = await this.service.createQueue(
        project ?? '',
        location ?? '',
        queueId,
        body ?? {}
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleGetQueue(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);
      const result = await this.service.getQueue(name);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleListQueues(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, location } = req.params;
      const pageSizeRaw = req.query.pageSize ? parseInt(String(req.query.pageSize), 10) : undefined;

      const pageSize =
        pageSizeRaw && !Number.isNaN(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : undefined;
      const pageToken = req.query.pageToken ? String(req.query.pageToken) : undefined;

      const result = await this.service.listQueues(
        project ?? '',
        location ?? '',
        pageSize,
        pageToken
      );

      const responseBody: Record<string, unknown> = { queues: result.queues };

      if (result.nextPageToken) {
        responseBody.nextPageToken = result.nextPageToken;
      }

      return this.responseUtils.success(responseBody);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleUpdateQueue(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);
      const result = await this.service.updateQueue(name, req.body);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleDeleteQueue(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);

      await this.service.deleteQueue(name);

      return this.responseUtils.success({});
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handlePauseQueue(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);
      const result = await this.service.pauseQueue(name);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleResumeQueue(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);
      const result = await this.service.resumeQueue(name);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handlePurgeQueue(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);
      const result = await this.service.purgeQueue(name);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private buildNameFromParams(params: Record<string, string>): string {
    return buildQueueName(params.project ?? '', params.location ?? '', params.queueId ?? '');
  }

  private handleError(err: unknown): RouteResponse {
    return handleTasksError(err, 'Queue', this.responseUtils);
  }
}
