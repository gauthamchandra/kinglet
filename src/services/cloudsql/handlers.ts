/**
 * Cloud SQL HTTP route handlers
 *
 * Paths mirror the sqladmin v1 discovery document exactly (note: no
 * `locations` segment in this API). Quirks honored here:
 * - users.update / users.delete identify the user via ?name= and ?host=
 *   query parameters, not a path segment
 * - instances.list / operations.list paginate with maxResults (not pageSize)
 * - databases.list and users.list are unpaginated and never emit nextPageToken
 */

import type {
  RouteContext,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import type { SqlAdminService } from './service.ts';
import { SqlAdminError } from './service.ts';

export class CloudSqlHandlers {
  private service: SqlAdminService;
  private responseUtils: ResponseUtils;

  constructor(service: SqlAdminService, logger: Logger) {
    this.service = service;

    const formatter = new StandardResponseFormatter(logger);

    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      // ── Instances ──
      {
        id: 'cloudsql.instances.insert',
        method: 'POST',
        path: '/v1/projects/:project/instances',
        handler: (req, ctx) => this.handleInsertInstance(req, ctx),
      },
      {
        id: 'cloudsql.instances.get',
        method: 'GET',
        path: '/v1/projects/:project/instances/:instance',
        handler: (req, ctx) => this.handleGetInstance(req, ctx),
      },
      {
        id: 'cloudsql.instances.list',
        method: 'GET',
        path: '/v1/projects/:project/instances',
        handler: (req, ctx) => this.handleListInstances(req, ctx),
      },
      {
        id: 'cloudsql.instances.delete',
        method: 'DELETE',
        path: '/v1/projects/:project/instances/:instance',
        handler: (req, ctx) => this.handleDeleteInstance(req, ctx),
      },
      {
        id: 'cloudsql.instances.patch',
        method: 'PATCH',
        path: '/v1/projects/:project/instances/:instance',
        handler: (req, ctx) => this.handlePatchInstance(req, ctx),
      },
      {
        id: 'cloudsql.instances.update',
        method: 'PUT',
        path: '/v1/projects/:project/instances/:instance',
        handler: (req, ctx) => this.handleUpdateInstance(req, ctx),
      },
      {
        id: 'cloudsql.instances.restart',
        method: 'POST',
        path: '/v1/projects/:project/instances/:instance/restart',
        handler: (req, ctx) => this.handleRestartInstance(req, ctx),
      },
      // ── Databases ──
      {
        id: 'cloudsql.databases.insert',
        method: 'POST',
        path: '/v1/projects/:project/instances/:instance/databases',
        handler: (req, ctx) => this.handleInsertDatabase(req, ctx),
      },
      {
        id: 'cloudsql.databases.get',
        method: 'GET',
        path: '/v1/projects/:project/instances/:instance/databases/:database',
        handler: (req, ctx) => this.handleGetDatabase(req, ctx),
      },
      {
        id: 'cloudsql.databases.list',
        method: 'GET',
        path: '/v1/projects/:project/instances/:instance/databases',
        handler: (req, ctx) => this.handleListDatabases(req, ctx),
      },
      {
        id: 'cloudsql.databases.patch',
        method: 'PATCH',
        path: '/v1/projects/:project/instances/:instance/databases/:database',
        handler: (req, ctx) => this.handleUpdateDatabase(req, ctx),
      },
      {
        id: 'cloudsql.databases.update',
        method: 'PUT',
        path: '/v1/projects/:project/instances/:instance/databases/:database',
        handler: (req, ctx) => this.handleUpdateDatabase(req, ctx),
      },
      {
        id: 'cloudsql.databases.delete',
        method: 'DELETE',
        path: '/v1/projects/:project/instances/:instance/databases/:database',
        handler: (req, ctx) => this.handleDeleteDatabase(req, ctx),
      },
      // ── Users ──
      {
        id: 'cloudsql.users.insert',
        method: 'POST',
        path: '/v1/projects/:project/instances/:instance/users',
        handler: (req, ctx) => this.handleInsertUser(req, ctx),
      },
      {
        id: 'cloudsql.users.get',
        method: 'GET',
        path: '/v1/projects/:project/instances/:instance/users/:name',
        handler: (req, ctx) => this.handleGetUser(req, ctx),
      },
      {
        id: 'cloudsql.users.list',
        method: 'GET',
        path: '/v1/projects/:project/instances/:instance/users',
        handler: (req, ctx) => this.handleListUsers(req, ctx),
      },
      {
        id: 'cloudsql.users.update',
        method: 'PUT',
        path: '/v1/projects/:project/instances/:instance/users',
        handler: (req, ctx) => this.handleUpdateUser(req, ctx),
      },
      {
        id: 'cloudsql.users.delete',
        method: 'DELETE',
        path: '/v1/projects/:project/instances/:instance/users',
        handler: (req, ctx) => this.handleDeleteUser(req, ctx),
      },
      // ── Operations ──
      {
        id: 'cloudsql.operations.get',
        method: 'GET',
        path: '/v1/projects/:project/operations/:operation',
        handler: (req, ctx) => this.handleGetOperation(req, ctx),
      },
      {
        id: 'cloudsql.operations.list',
        method: 'GET',
        path: '/v1/projects/:project/operations',
        handler: (req, ctx) => this.handleListOperations(req, ctx),
      },
    ];
  }

  // ── Instances ──

  private async handleInsertInstance(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const result = await this.service.createInstance(req.params.project ?? '', req.body);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleGetInstance(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.getInstance(
        req.params.project ?? '',
        req.params.instance ?? ''
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleListInstances(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.listInstances(
        req.params.project ?? '',
        this.parseMaxResults(req),
        this.queryString(req, 'pageToken')
      );

      const body: Record<string, unknown> = { kind: 'sql#instancesList', items: result.items };

      if (result.nextPageToken != null) {
        body.nextPageToken = result.nextPageToken;
      }

      return this.responseUtils.success(body);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleDeleteInstance(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const result = await this.service.deleteInstance(
        req.params.project ?? '',
        req.params.instance ?? ''
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handlePatchInstance(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.patchInstance(
        req.params.project ?? '',
        req.params.instance ?? '',
        req.body
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleUpdateInstance(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const result = await this.service.updateInstance(
        req.params.project ?? '',
        req.params.instance ?? '',
        req.body
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleRestartInstance(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const result = await this.service.restartInstance(
        req.params.project ?? '',
        req.params.instance ?? ''
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  // ── Databases ──

  private async handleInsertDatabase(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const result = await this.service.createDatabase(
        req.params.project ?? '',
        req.params.instance ?? '',
        req.body
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleGetDatabase(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.getDatabase(
        req.params.project ?? '',
        req.params.instance ?? '',
        req.params.database ?? ''
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleListDatabases(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.listDatabases(
        req.params.project ?? '',
        req.params.instance ?? ''
      );

      return this.responseUtils.success({ kind: 'sql#databasesList', items: result.items });
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleUpdateDatabase(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const result = await this.service.updateDatabase(
        req.params.project ?? '',
        req.params.instance ?? '',
        req.params.database ?? '',
        req.body
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleDeleteDatabase(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const result = await this.service.deleteDatabase(
        req.params.project ?? '',
        req.params.instance ?? '',
        req.params.database ?? ''
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  // ── Users ──

  private async handleInsertUser(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.createUser(
        req.params.project ?? '',
        req.params.instance ?? '',
        req.body
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleGetUser(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.getUser(
        req.params.project ?? '',
        req.params.instance ?? '',
        req.params.name ?? '',
        this.queryString(req, 'host')
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleListUsers(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.listUsers(
        req.params.project ?? '',
        req.params.instance ?? ''
      );

      return this.responseUtils.success({ kind: 'sql#usersList', items: result.items });
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleUpdateUser(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.updateUser(
        req.params.project ?? '',
        req.params.instance ?? '',
        this.queryString(req, 'name'),
        this.queryString(req, 'host'),
        req.body
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleDeleteUser(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.deleteUser(
        req.params.project ?? '',
        req.params.instance ?? '',
        this.queryString(req, 'name'),
        this.queryString(req, 'host')
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  // ── Operations ──

  private async handleGetOperation(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.getOperation(
        req.params.project ?? '',
        req.params.operation ?? ''
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleListOperations(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const result = await this.service.listOperations(
        req.params.project ?? '',
        this.queryString(req, 'instance'),
        this.parseMaxResults(req),
        this.queryString(req, 'pageToken')
      );

      const body: Record<string, unknown> = { kind: 'sql#operationsList', items: result.items };

      if (result.nextPageToken != null) {
        body.nextPageToken = result.nextPageToken;
      }

      return this.responseUtils.success(body);
    } catch (err) {
      return this.handleError(err);
    }
  }

  // ── Helpers ──

  private queryString(req: RouteRequest, key: string): string | undefined {
    const value = req.query[key];

    if (typeof value === 'string' && value !== '') {
      return value;
    }

    return undefined;
  }

  private parseMaxResults(req: RouteRequest): number | undefined {
    const raw = this.queryString(req, 'maxResults');

    if (raw == null) {
      return undefined;
    }

    const parsed = parseInt(raw, 10);

    if (Number.isNaN(parsed) || parsed <= 0) {
      return undefined;
    }

    return parsed;
  }

  private handleError(err: unknown): RouteResponse {
    if (err instanceof SqlAdminError) {
      switch (err.code) {
        case 'NOT_FOUND':
          return this.responseUtils.notFound('Cloud SQL resource', err.message);
        case 'ALREADY_EXISTS':
          return this.responseUtils.alreadyExists('Cloud SQL resource', err.message);
        case 'INVALID_ARGUMENT':
          return this.responseUtils.badRequest(err.message);
        case 'FAILED_PRECONDITION':
          // GCP returns 409 for settingsVersion conflicts; conflict() is the
          // 409 + FAILED_PRECONDITION variant (failedPrecondition() is HTTP 400).
          return this.responseUtils.conflict(err.message);
        case 'INTERNAL':
          return this.responseUtils.internalError(err.message);
      }
    }

    return this.responseUtils.badRequest(err instanceof Error ? err.message : 'Unknown error');
  }
}
