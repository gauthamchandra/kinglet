/**
 * Task HTTP route handlers for Cloud Tasks
 */

import type {
  RouteDefinition,
  RouteRequest,
  RouteContext,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { StandardResponseFormatter, ResponseUtils } from '@/core/gateway/response-handlers.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { buildTaskName, buildQueueName } from './types.ts';
import { handleTasksError } from './queue-service.ts';
import type { TaskService } from './task-service.ts';

export class TaskHandlers {
  private service: TaskService;
  private responseUtils: ResponseUtils;
  private logger: Logger;

  constructor(service: TaskService, logger: Logger) {
    this.service = service;
    this.logger = logger;
    const formatter = new StandardResponseFormatter(logger);

    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'tasks.tasks.create',
        method: 'POST',
        path: '/v2/projects/:project/locations/:location/queues/:queueId/tasks',
        handler: (req, ctx) => this.handleCreateTask(req, ctx),
      },
      {
        id: 'tasks.tasks.get',
        method: 'GET',
        path: '/v2/projects/:project/locations/:location/queues/:queueId/tasks/:taskId',
        handler: (req, ctx) => this.handleGetTask(req, ctx),
      },
      {
        id: 'tasks.tasks.list',
        method: 'GET',
        path: '/v2/projects/:project/locations/:location/queues/:queueId/tasks',
        handler: (req, ctx) => this.handleListTasks(req, ctx),
      },
      {
        id: 'tasks.tasks.delete',
        method: 'DELETE',
        path: '/v2/projects/:project/locations/:location/queues/:queueId/tasks/:taskId',
        handler: (req, ctx) => this.handleDeleteTask(req, ctx),
      },
      {
        id: 'tasks.tasks.run',
        method: 'POST',
        path: '/v2/projects/:project/locations/:location/queues/:queueId/tasks/:taskId:run',
        handler: (req, ctx) => this.handleRunTask(req, ctx),
      },
      {
        id: 'tasks.tasks.buffer',
        method: 'POST',
        path: '/v2/projects/:project/locations/:location/queues/:queueId/tasks/:taskId:buffer',
        handler: (req, ctx) => this.handleBufferTask(req, ctx),
      },
    ];
  }

  private async handleCreateTask(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, location, queueId } = req.params;

      const result = await this.service.createTask(
        project ?? '',
        location ?? '',
        queueId ?? '',
        req.body
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleGetTask(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildTaskNameFromParams(req.params);
      const responseView = req.query.responseView ? String(req.query.responseView) : undefined;
      const result = await this.service.getTask(name, responseView);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleListTasks(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, location, queueId } = req.params;
      const queueName = buildQueueName(project ?? '', location ?? '', queueId ?? '');

      const responseView = req.query.responseView ? String(req.query.responseView) : undefined;
      const pageSizeRaw = req.query.pageSize ? parseInt(String(req.query.pageSize), 10) : undefined;

      const pageSize =
        pageSizeRaw && !Number.isNaN(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : undefined;
      const pageToken = req.query.pageToken ? String(req.query.pageToken) : undefined;

      const result = await this.service.listTasks(queueName, responseView, pageSize, pageToken);

      const responseBody: Record<string, unknown> = { tasks: result.tasks };

      if (result.nextPageToken) {
        responseBody.nextPageToken = result.nextPageToken;
      }

      return this.responseUtils.success(responseBody);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleDeleteTask(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildTaskNameFromParams(req.params);

      await this.service.deleteTask(name);

      return this.responseUtils.success({});
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleRunTask(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildTaskNameFromParams(req.params);
      const body = req.body as Record<string, unknown> | undefined;
      const responseView = body?.responseView ? String(body.responseView) : undefined;

      const result = await this.service.runTask(name, responseView);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleBufferTask(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, location, queueId, taskId } = req.params;
      const queueName = buildQueueName(project ?? '', location ?? '', queueId ?? '');
      const body = req.body as Record<string, unknown> | undefined;

      const result = await this.service.bufferTask(
        project ?? '',
        location ?? '',
        queueId ?? '',
        taskId ?? '',
        queueName,
        body
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private buildTaskNameFromParams(params: Record<string, string>): string {
    return buildTaskName(
      params.project ?? '',
      params.location ?? '',
      params.queueId ?? '',
      params.taskId ?? ''
    );
  }

  private handleError(err: unknown): RouteResponse {
    return handleTasksError(err, 'Task', this.responseUtils);
  }
}
