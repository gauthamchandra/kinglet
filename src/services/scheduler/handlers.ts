/**
 * Scheduler HTTP route handlers
 */

import type {
  RouteDefinition,
  RouteRequest,
  RouteContext,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { StandardResponseFormatter, ResponseUtils } from '@/core/gateway/response-handlers.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { buildJobName, parseJobName } from './types.ts';
import { SchedulerError } from './service.ts';
import type { JobService } from './service.ts';

export class SchedulerHandlers {
  private service: JobService;
  private responseUtils: ResponseUtils;

  constructor(service: JobService, logger: Logger) {
    this.service = service;
    const formatter = new StandardResponseFormatter(logger);

    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'scheduler.jobs.create',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/jobs',
        handler: (req, ctx) => this.handleCreateJob(req, ctx),
      },
      {
        id: 'scheduler.jobs.get',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/jobs/:jobId',
        handler: (req, ctx) => this.handleGetJob(req, ctx),
      },
      {
        id: 'scheduler.jobs.list',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/jobs',
        handler: (req, ctx) => this.handleListJobs(req, ctx),
      },
      {
        id: 'scheduler.jobs.update',
        method: 'PATCH',
        path: '/v1/projects/:project/locations/:location/jobs/:jobId',
        handler: (req, ctx) => this.handleUpdateJob(req, ctx),
      },
      {
        id: 'scheduler.jobs.delete',
        method: 'DELETE',
        path: '/v1/projects/:project/locations/:location/jobs/:jobId',
        handler: (req, ctx) => this.handleDeleteJob(req, ctx),
      },
      {
        id: 'scheduler.jobs.pause',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/jobs/:jobId:pause',
        handler: (req, ctx) => this.handlePauseJob(req, ctx),
      },
      {
        id: 'scheduler.jobs.resume',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/jobs/:jobId:resume',
        handler: (req, ctx) => this.handleResumeJob(req, ctx),
      },
      {
        id: 'scheduler.jobs.run',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/jobs/:jobId:run',
        handler: (req, ctx) => this.handleRunJob(req, ctx),
      },
    ];
  }

  private async handleCreateJob(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, location } = req.params;
      const body = req.body as Record<string, unknown> | undefined;

      // Extract jobId from: body.jobId, query param, or body.name (client library sends full name)
      let jobId = (body?.jobId as string) ?? (req.query.jobId as string) ?? '';

      if (!jobId && typeof body?.name === 'string') {
        try {
          const parsed = parseJobName(body.name);

          jobId = parsed.jobId;
        } catch {
          // name was not a valid resource name, leave jobId empty
        }
      }

      const result = await this.service.createJob(project ?? '', location ?? '', jobId, body);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleGetJob(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);
      const result = await this.service.getJob(name);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleListJobs(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, location } = req.params;
      const pageSizeRaw = req.query.pageSize
        ? parseInt(req.query.pageSize as string, 10)
        : undefined;

      const pageSize =
        pageSizeRaw && !Number.isNaN(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : undefined;
      const pageToken = (req.query.pageToken as string) || undefined;

      const result = await this.service.listJobs(
        project ?? '',
        location ?? '',
        pageSize,
        pageToken
      );

      // GCP Cloud Scheduler REST API returns { jobs: [...], nextPageToken: "..." }
      const body: Record<string, unknown> = { jobs: result.jobs };

      if (result.nextPageToken) {
        body.nextPageToken = result.nextPageToken;
      }

      return this.responseUtils.success(body);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleUpdateJob(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);
      const result = await this.service.updateJob(name, req.body);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleDeleteJob(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);

      await this.service.deleteJob(name);

      return this.responseUtils.success({});
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handlePauseJob(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);
      const result = await this.service.pauseJob(name);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleResumeJob(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);
      const result = await this.service.resumeJob(name);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleRunJob(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);
      const result = await this.service.runJob(name);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private buildNameFromParams(params: Record<string, string>): string {
    return buildJobName(params.project ?? '', params.location ?? '', params.jobId ?? '');
  }

  private handleError(err: unknown): RouteResponse {
    if (err instanceof SchedulerError) {
      switch (err.code) {
        case 'NOT_FOUND':
          return this.responseUtils.notFound('Job', err.message);
        case 'ALREADY_EXISTS':
          return this.responseUtils.alreadyExists('Job', err.message);
        case 'INVALID_ARGUMENT':
          return this.responseUtils.badRequest(err.message);
        case 'FAILED_PRECONDITION':
          return this.responseUtils.badRequest(err.message);
      }
    }

    return this.responseUtils.badRequest(err instanceof Error ? err.message : 'Unknown error');
  }
}
