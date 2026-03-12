/**
 * Execution HTTP route handlers
 */

import type {
  RouteContext,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import type { WorkflowRepository } from '../repository.ts';
import { buildWorkflowName } from '../types.ts';
import type { ExecutionService } from './service.ts';
import { buildExecutionName, executionRecordToResponse } from './types.ts';

export class ExecutionHandlers {
  private service: ExecutionService;
  private workflowRepo: WorkflowRepository;
  private responseUtils: ResponseUtils;

  constructor(service: ExecutionService, workflowRepo: WorkflowRepository, logger: Logger) {
    this.service = service;
    this.workflowRepo = workflowRepo;

    const formatter = new StandardResponseFormatter(logger);
    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      // Cancel must come before get to match the :cancel suffix
      {
        id: 'executions.cancel',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/workflows/:workflowId/executions/:executionId:cancel',
        handler: (req, ctx) => this.handleCancelExecution(req, ctx),
      },
      {
        id: 'executions.create',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/workflows/:workflowId/executions',
        handler: (req, ctx) => this.handleCreateExecution(req, ctx),
      },
      {
        id: 'executions.get',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/workflows/:workflowId/executions/:executionId',
        handler: (req, ctx) => this.handleGetExecution(req, ctx),
      },
      {
        id: 'executions.list',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/workflows/:workflowId/executions',
        handler: (req, ctx) => this.handleListExecutions(req, ctx),
      },
    ];
  }

  private async handleCreateExecution(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    const { project = '', location = '', workflowId = '' } = req.params;
    const body = req.body as Record<string, unknown> | undefined;

    // Look up the workflow
    const workflowName = buildWorkflowName(project, location, workflowId);
    const workflow = await this.workflowRepo.getWorkflowByName(workflowName);

    if (!workflow) {
      return this.responseUtils.notFound('Workflow', workflowName);
    }

    // Parse execution arguments
    const argumentStr = (body?.argument as string) ?? '{}';
    let args: Record<string, unknown>;

    try {
      args = JSON.parse(argumentStr) as Record<string, unknown>;
    } catch {
      return this.responseUtils.badRequest('Invalid JSON in argument field');
    }

    // Parse user env vars if present
    const userEnvVars = workflow.userEnvVars
      ? (JSON.parse(workflow.userEnvVars) as Record<string, string>)
      : undefined;

    const execution = await this.service.createExecution(
      project,
      location,
      workflowId,
      workflow.revisionId,
      workflow.sourceContents,
      args,
      userEnvVars,
      body?.callLogLevel as string | undefined
    );

    return this.responseUtils.success(executionRecordToResponse(execution));
  }

  private async handleGetExecution(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    const { project = '', location = '', workflowId = '', executionId = '' } = req.params;
    const name = buildExecutionName(project, location, workflowId, executionId);

    const execution = await this.service.getExecution(name);

    if (!execution) {
      return this.responseUtils.notFound('Execution', name);
    }

    return this.responseUtils.success(executionRecordToResponse(execution));
  }

  private async handleListExecutions(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    const { project = '', location = '', workflowId = '' } = req.params;
    const workflowName = buildWorkflowName(project, location, workflowId);

    const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined;
    const pageToken = req.query.pageToken as string | undefined;

    const result = await this.service.listExecutions(workflowName, pageSize, pageToken);

    const response: Record<string, unknown> = {
      executions: result.executions.map(executionRecordToResponse),
    };

    if (result.nextPageToken) {
      response.nextPageToken = result.nextPageToken;
    }

    return this.responseUtils.success(response);
  }

  private async handleCancelExecution(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    const { project = '', location = '', workflowId = '', executionId = '' } = req.params;
    const name = buildExecutionName(project, location, workflowId, executionId);

    const result = await this.service.cancelExecution(name);

    if ('error' in result) {
      if (result.error === 'not_found') {
        return this.responseUtils.notFound('Execution', name);
      }

      return this.responseUtils.failedPrecondition(
        `Execution ${name} cannot be cancelled because it is in state ${result.state}`
      );
    }

    return this.responseUtils.success(executionRecordToResponse(result.record));
  }
}
