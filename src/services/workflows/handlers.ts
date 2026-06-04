/**
 * Workflows HTTP route handlers
 */

import type {
  RouteContext,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import type { OperationsStore } from './operations.ts';
import type { WorkflowService } from './service.ts';
import { WorkflowsError } from './service.ts';
import { buildOperationName, buildWorkflowName, parseWorkflowName } from './types.ts';

export class WorkflowHandlers {
  private service: WorkflowService;
  private operationsStore: OperationsStore;
  private responseUtils: ResponseUtils;
  private formatter: StandardResponseFormatter;
  private logger: Logger;

  constructor(service: WorkflowService, operationsStore: OperationsStore, logger: Logger) {
    this.service = service;
    this.operationsStore = operationsStore;
    this.logger = logger;
    this.formatter = new StandardResponseFormatter(logger);

    this.responseUtils = new ResponseUtils(this.formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      // Revisions (must be before workflows.get to match action suffix first)
      {
        id: 'workflows.revisions.list',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/workflows/:workflowId:listRevisions',
        handler: (req, ctx) => this.handleListRevisions(req, ctx),
      },
      // Workflow CRUD
      {
        id: 'workflows.create',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/workflows',
        handler: (req, ctx) => this.handleCreateWorkflow(req, ctx),
      },
      {
        id: 'workflows.get',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/workflows/:workflowId',
        handler: (req, ctx) => this.handleGetWorkflow(req, ctx),
      },
      {
        id: 'workflows.list',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/workflows',
        handler: (req, ctx) => this.handleListWorkflows(req, ctx),
      },
      {
        id: 'workflows.update',
        method: 'PATCH',
        path: '/v1/projects/:project/locations/:location/workflows/:workflowId',
        handler: (req, ctx) => this.handleUpdateWorkflow(req, ctx),
      },
      {
        id: 'workflows.delete',
        method: 'DELETE',
        path: '/v1/projects/:project/locations/:location/workflows/:workflowId',
        handler: (req, ctx) => this.handleDeleteWorkflow(req, ctx),
      },
      // Operations
      {
        id: 'workflows.operations.list',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/operations',
        handler: (req, ctx) => this.handleListOperations(req, ctx),
      },
      {
        id: 'workflows.operations.get',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/operations/:operationId',
        handler: (req, ctx) => this.handleGetOperation(req, ctx),
      },
      {
        id: 'workflows.operations.delete',
        method: 'DELETE',
        path: '/v1/projects/:project/locations/:location/operations/:operationId',
        handler: (req, ctx) => this.handleDeleteOperation(req, ctx),
      },
    ];
  }

  // ── Workflow Handlers ──

  private async handleCreateWorkflow(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, location } = req.params;
      const body = req.body as Record<string, unknown> | undefined;

      let workflowId = (body?.workflowId as string) ?? (req.query.workflowId as string) ?? '';

      if (!workflowId && typeof body?.name === 'string') {
        try {
          const parsed = parseWorkflowName(body.name);

          workflowId = parsed.workflowId;
        } catch (err) {
          this.logger.debug(`Could not parse workflow name from body.name: ${body.name}`, err);
        }
      }

      const result = await this.service.createWorkflow(
        project ?? '',
        location ?? '',
        workflowId,
        body
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleGetWorkflow(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildWorkflowNameFromParams(req.params);
      const revisionId = (req.query.revisionId as string) || undefined;
      const result = await this.service.getWorkflow(name, revisionId);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleListWorkflows(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, location } = req.params;
      const pageSizeRaw = req.query.pageSize
        ? parseInt(req.query.pageSize as string, 10)
        : undefined;

      const pageSize =
        pageSizeRaw && !Number.isNaN(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : undefined;
      const pageToken = (req.query.pageToken as string) || undefined;

      const result = await this.service.listWorkflows(
        project ?? '',
        location ?? '',
        pageSize,
        pageToken
      );

      const body: Record<string, unknown> = { workflows: result.workflows };

      if (result.nextPageToken) {
        body.nextPageToken = result.nextPageToken;
      }

      return this.responseUtils.success(body);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleUpdateWorkflow(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const name = this.buildWorkflowNameFromParams(req.params);
      const updateMask = (req.query.updateMask as string) || undefined;
      const result = await this.service.updateWorkflow(name, req.body, updateMask);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleDeleteWorkflow(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const name = this.buildWorkflowNameFromParams(req.params);
      const result = await this.service.deleteWorkflow(name);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  // ── Revisions Handler ──

  private async handleListRevisions(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildWorkflowNameFromParams(req.params);
      const pageSizeRaw = req.query.pageSize
        ? parseInt(req.query.pageSize as string, 10)
        : undefined;

      const pageSize =
        pageSizeRaw && !Number.isNaN(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : undefined;
      const pageToken = (req.query.pageToken as string) || undefined;

      const result = await this.service.listRevisions(name, pageSize, pageToken);

      const body: Record<string, unknown> = { workflows: result.workflows };

      if (result.nextPageToken) {
        body.nextPageToken = result.nextPageToken;
      }

      return this.responseUtils.success(body);
    } catch (err) {
      return this.handleError(err);
    }
  }

  // ── Operations Handlers ──

  private async handleListOperations(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, location } = req.params;
      const pageSizeRaw = req.query.pageSize
        ? parseInt(req.query.pageSize as string, 10)
        : undefined;

      const pageSize =
        pageSizeRaw && !Number.isNaN(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : undefined;
      const pageToken = (req.query.pageToken as string) || undefined;

      const result = await this.operationsStore.listOperations(
        project ?? '',
        location ?? '',
        pageSize,
        pageToken
      );

      const body: Record<string, unknown> = { operations: result.operations };

      if (result.nextPageToken) {
        body.nextPageToken = result.nextPageToken;
      }

      return this.responseUtils.success(body);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleGetOperation(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = buildOperationName(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.operationId ?? ''
      );

      const result = await this.operationsStore.getOperation(name);

      if (!result) {
        return this.responseUtils.notFound('Operation', name);
      }

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleDeleteOperation(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const name = buildOperationName(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.operationId ?? ''
      );

      const deleted = await this.operationsStore.deleteOperation(name);

      if (!deleted) {
        return this.responseUtils.notFound('Operation', name);
      }

      return this.responseUtils.success({});
    } catch (err) {
      return this.handleError(err);
    }
  }

  // ── Helpers ──

  private buildWorkflowNameFromParams(params: Record<string, string>): string {
    return buildWorkflowName(params.project ?? '', params.location ?? '', params.workflowId ?? '');
  }

  private handleError(err: unknown): RouteResponse {
    if (err instanceof WorkflowsError) {
      switch (err.code) {
        case 'NOT_FOUND':
          return this.responseUtils.notFound('Workflow', err.message);
        case 'ALREADY_EXISTS':
          return this.responseUtils.alreadyExists('Workflow', err.message);
        case 'INVALID_ARGUMENT':
          return this.responseUtils.badRequest(err.message);
        case 'FAILED_PRECONDITION':
          return this.responseUtils.failedPrecondition(err.message);
      }
    }

    this.logger.error('Unexpected error in workflow handler', err);

    return this.formatter.formatError(500);
  }
}
