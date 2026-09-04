/**
 * Compute service HTTP handlers — HTTP routing only, no business logic.
 *
 * Routes follow the Compute v1 discovery document exactly.
 * All mutations return compute#operation with status DONE.
 */

import type {
  RouteContext,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { parsePageSize } from '@/shared/utils/pagination.ts';
import { type SecurityPolicyService, SecurityPolicyServiceError } from './service.ts';

export class ComputeHandlers {
  private service: SecurityPolicyService;
  private logger: Logger;

  constructor(service: SecurityPolicyService, logger: Logger) {
    this.service = service;
    this.logger = logger;
  }

  getRoutes(): RouteDefinition[] {
    return [
      // securityPolicies CRUD
      {
        id: 'compute.securityPolicies.insert',
        method: 'POST',
        path: '/compute/v1/projects/:project/global/securityPolicies',
        handler: (req, ctx) => this.handleInsert(req, ctx),
      },
      {
        id: 'compute.securityPolicies.get',
        method: 'GET',
        path: '/compute/v1/projects/:project/global/securityPolicies/:securityPolicy',
        handler: (req, ctx) => this.handleGet(req, ctx),
      },
      {
        id: 'compute.securityPolicies.list',
        method: 'GET',
        path: '/compute/v1/projects/:project/global/securityPolicies',
        handler: (req, ctx) => this.handleList(req, ctx),
      },
      {
        id: 'compute.securityPolicies.patch',
        method: 'PATCH',
        path: '/compute/v1/projects/:project/global/securityPolicies/:securityPolicy',
        handler: (req, ctx) => this.handlePatch(req, ctx),
      },
      {
        id: 'compute.securityPolicies.delete',
        method: 'DELETE',
        path: '/compute/v1/projects/:project/global/securityPolicies/:securityPolicy',
        handler: (req, ctx) => this.handleDelete(req, ctx),
      },
      // Rule RPCs
      {
        id: 'compute.securityPolicies.addRule',
        method: 'POST',
        path: '/compute/v1/projects/:project/global/securityPolicies/:securityPolicy/addRule',
        handler: (req, ctx) => this.handleAddRule(req, ctx),
      },
      {
        id: 'compute.securityPolicies.removeRule',
        method: 'POST',
        path: '/compute/v1/projects/:project/global/securityPolicies/:securityPolicy/removeRule',
        handler: (req, ctx) => this.handleRemoveRule(req, ctx),
      },
      {
        id: 'compute.securityPolicies.getRule',
        method: 'GET',
        path: '/compute/v1/projects/:project/global/securityPolicies/:securityPolicy/getRule',
        handler: (req, ctx) => this.handleGetRule(req, ctx),
      },
      {
        id: 'compute.securityPolicies.patchRule',
        method: 'POST',
        path: '/compute/v1/projects/:project/global/securityPolicies/:securityPolicy/patchRule',
        handler: (req, ctx) => this.handlePatchRule(req, ctx),
      },
      // setLabels stub (provider calls this after create/update)
      {
        id: 'compute.securityPolicies.setLabels',
        method: 'POST',
        path: '/compute/v1/projects/:project/global/securityPolicies/:securityPolicy/setLabels',
        handler: (req, ctx) => this.handleSetLabels(req, ctx),
      },
      // globalOperations
      {
        id: 'compute.globalOperations.get',
        method: 'GET',
        path: '/compute/v1/projects/:project/global/operations/:operation',
        handler: (req, ctx) => this.handleGetOperation(req, ctx),
      },
      {
        id: 'compute.globalOperations.wait',
        method: 'POST',
        path: '/compute/v1/projects/:project/global/operations/:operation/wait',
        handler: (req, ctx) => this.handleWaitOperation(req, ctx),
      },
    ];
  }

  private async handleInsert(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const project = req.params.project ?? '';
      const body = (req.body ?? {}) as Record<string, unknown>;
      const policyName = body.name as string | undefined;

      if (!policyName) {
        return errorResponse(400, 'INVALID_ARGUMENT', 'name is required');
      }

      const { operation } = await this.service.insert(project, policyName, body);

      this.logger.debug(
        `Inserted security policy: projects/${project}/global/securityPolicies/${policyName}`
      );

      return { status: 200, body: operation };
    } catch (err) {
      return handleError(err, this.logger);
    }
  }

  private async handleGet(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const project = req.params.project ?? '';
      const securityPolicy = req.params.securityPolicy ?? '';
      const policy = await this.service.get(project, securityPolicy);

      if (policy == null) {
        return errorResponse(
          404,
          'NOT_FOUND',
          `The resource 'projects/${project}/global/securityPolicies/${securityPolicy}' was not found`
        );
      }

      return { status: 200, body: policy };
    } catch (err) {
      return handleError(err, this.logger);
    }
  }

  private async handleList(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const project = req.params.project ?? '';
      const pageSize = parsePageSize(req.query.maxResults);
      const pageToken = req.query.pageToken as string | undefined;

      const result = await this.service.list(project, pageSize, pageToken);

      return { status: 200, body: result };
    } catch (err) {
      return handleError(err, this.logger);
    }
  }

  private async handlePatch(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const project = req.params.project ?? '';
      const securityPolicy = req.params.securityPolicy ?? '';
      const body = (req.body ?? {}) as Record<string, unknown>;

      const { operation } = await this.service.patch(project, securityPolicy, body);

      return { status: 200, body: operation };
    } catch (err) {
      return handleError(err, this.logger);
    }
  }

  private async handleDelete(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const project = req.params.project ?? '';
      const securityPolicy = req.params.securityPolicy ?? '';
      const { operation } = await this.service.delete(project, securityPolicy);

      return { status: 200, body: operation };
    } catch (err) {
      return handleError(err, this.logger);
    }
  }

  private async handleAddRule(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const project = req.params.project ?? '';
      const securityPolicy = req.params.securityPolicy ?? '';
      const ruleBody = (req.body ?? {}) as Record<string, unknown>;

      const { operation } = await this.service.addRule(project, securityPolicy, ruleBody);

      return { status: 200, body: operation };
    } catch (err) {
      return handleError(err, this.logger);
    }
  }

  private async handleRemoveRule(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const project = req.params.project ?? '';
      const securityPolicy = req.params.securityPolicy ?? '';
      const parsed = parsePriorityQuery(req.query.priority);

      if (!parsed.ok) {
        return parsed.response;
      }

      const { operation } = await this.service.removeRule(project, securityPolicy, parsed.priority);

      return { status: 200, body: operation };
    } catch (err) {
      return handleError(err, this.logger);
    }
  }

  private async handleGetRule(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const project = req.params.project ?? '';
      const securityPolicy = req.params.securityPolicy ?? '';
      const parsed = parsePriorityQuery(req.query.priority);

      if (!parsed.ok) {
        return parsed.response;
      }

      const rule = await this.service.getRule(project, securityPolicy, parsed.priority);

      if (rule == null) {
        return errorResponse(
          404,
          'NOT_FOUND',
          `No rule found with priority ${parsed.priority} in policy ${securityPolicy}`
        );
      }

      return { status: 200, body: rule };
    } catch (err) {
      return handleError(err, this.logger);
    }
  }

  private async handlePatchRule(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const project = req.params.project ?? '';
      const securityPolicy = req.params.securityPolicy ?? '';
      const parsed = parsePriorityQuery(req.query.priority);

      if (!parsed.ok) {
        return parsed.response;
      }

      const ruleBody = (req.body ?? {}) as Record<string, unknown>;

      const { operation } = await this.service.patchRule(
        project,
        securityPolicy,
        parsed.priority,
        ruleBody
      );

      return { status: 200, body: operation };
    } catch (err) {
      return handleError(err, this.logger);
    }
  }

  private async handleSetLabels(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const project = req.params.project ?? '';
      const securityPolicy = req.params.securityPolicy ?? '';
      const { operation } = await this.service.setLabels(project, securityPolicy);

      return { status: 200, body: operation };
    } catch (err) {
      return handleError(err, this.logger);
    }
  }

  private async handleGetOperation(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const project = req.params.project ?? '';
      const operation = req.params.operation ?? '';
      const result = await this.service.getOperation(project, operation);

      if (result == null) {
        return errorResponse(404, 'NOT_FOUND', `Operation ${operation} not found`);
      }

      return { status: 200, body: result };
    } catch (err) {
      return handleError(err, this.logger);
    }
  }

  private async handleWaitOperation(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const project = req.params.project ?? '';
      const operation = req.params.operation ?? '';
      const result = await this.service.getOperation(project, operation);

      if (result == null) {
        return errorResponse(404, 'NOT_FOUND', `Operation ${operation} not found`);
      }

      return { status: 200, body: result };
    } catch (err) {
      return handleError(err, this.logger);
    }
  }
}

// ── Helpers ──

function parsePriorityQuery(
  raw: unknown
): { ok: true; priority: number } | { ok: false; response: RouteResponse } {
  if (raw == null || raw === '') {
    return {
      ok: false,
      response: errorResponse(400, 'INVALID_ARGUMENT', 'priority query parameter is required'),
    };
  }

  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) {
    return {
      ok: false,
      response: errorResponse(400, 'INVALID_ARGUMENT', 'priority must be an integer'),
    };
  }

  const priority = Number.parseInt(raw, 10);

  if (!Number.isInteger(priority)) {
    return {
      ok: false,
      response: errorResponse(400, 'INVALID_ARGUMENT', 'priority must be an integer'),
    };
  }

  return { ok: true, priority };
}

function errorResponse(code: number, status: string, message: string): RouteResponse {
  return {
    status: code,
    body: {
      error: {
        code,
        message,
        status,
      },
    },
  };
}

function handleError(err: unknown, logger: Logger): RouteResponse {
  if (err instanceof SecurityPolicyServiceError) {
    return {
      status: err.code,
      body: {
        error: {
          code: err.code,
          message: err.message,
          status: err.status,
        },
      },
    };
  }

  logger.error('Unexpected error in compute handler:', err);

  return {
    status: 500,
    body: {
      error: {
        code: 500,
        message: 'Internal server error',
        status: 'INTERNAL',
      },
    },
  };
}
