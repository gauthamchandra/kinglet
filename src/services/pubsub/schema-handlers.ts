/**
 * Schema HTTP route handlers for Cloud Pub/Sub
 */

import type {
  RouteContext,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import type { SchemaService } from './schema-service.ts';
import { buildSchemaName, handlePubSubError } from './types.ts';

export class SchemaHandlers {
  private service: SchemaService;
  private responseUtils: ResponseUtils;

  constructor(service: SchemaService, logger: Logger) {
    this.service = service;
    const formatter = new StandardResponseFormatter(logger);

    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'pubsub.schemas.create',
        method: 'POST',
        path: '/v1/projects/:project/schemas',
        handler: (req, ctx) => this.handleCreateSchema(req, ctx),
      },
      {
        id: 'pubsub.schemas.get',
        method: 'GET',
        path: '/v1/projects/:project/schemas/:schema',
        handler: (req, ctx) => this.handleGetSchema(req, ctx),
      },
      {
        id: 'pubsub.schemas.list',
        method: 'GET',
        path: '/v1/projects/:project/schemas',
        handler: (req, ctx) => this.handleListSchemas(req, ctx),
      },
      {
        id: 'pubsub.schemas.delete',
        method: 'DELETE',
        path: '/v1/projects/:project/schemas/:schema',
        handler: (req, ctx) => this.handleDeleteSchema(req, ctx),
      },
      {
        id: 'pubsub.schemas.commit',
        method: 'POST',
        path: '/v1/projects/:project/schemas/:schema:commit',
        handler: (req, ctx) => this.handleCommitSchema(req, ctx),
      },
      {
        id: 'pubsub.schemas.rollback',
        method: 'POST',
        path: '/v1/projects/:project/schemas/:schema:rollback',
        handler: (req, ctx) => this.handleRollbackSchema(req, ctx),
      },
      {
        id: 'pubsub.schemas.listRevisions',
        method: 'GET',
        path: '/v1/projects/:project/schemas/:schema:listRevisions',
        handler: (req, ctx) => this.handleListRevisions(req, ctx),
      },
      {
        id: 'pubsub.schemas.deleteRevision',
        method: 'DELETE',
        path: '/v1/projects/:project/schemas/:schema:deleteRevision',
        handler: (req, ctx) => this.handleDeleteRevision(req, ctx),
      },
      {
        id: 'pubsub.schemas.validate',
        method: 'POST',
        path: '/v1/projects/:project/schemas:validate',
        handler: (req, ctx) => this.handleValidateSchema(req, ctx),
      },
      {
        id: 'pubsub.schemas.validateMessage',
        method: 'POST',
        path: '/v1/projects/:project/schemas:validateMessage',
        handler: (req, ctx) => this.handleValidateMessage(req, ctx),
      },
    ];
  }

  private async handleCreateSchema(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project } = req.params;
      const schemaId = req.query.schemaId as string;
      const result = await this.service.createSchema(project as string, schemaId, req.body ?? {});

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Schema', this.responseUtils);
    }
  }

  private async handleGetSchema(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, schema } = req.params;
      const name = buildSchemaName(project as string, schema as string);
      const view = req.query.view as string | undefined;
      const result = await this.service.getSchema(name, view);

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Schema', this.responseUtils);
    }
  }

  private async handleListSchemas(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project } = req.params;
      const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined;
      const pageToken = req.query.pageToken as string | undefined;
      const view = req.query.view as string | undefined;
      const result = await this.service.listSchemas(project as string, pageSize, pageToken, view);

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Schema', this.responseUtils);
    }
  }

  private async handleDeleteSchema(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, schema } = req.params;
      const name = buildSchemaName(project as string, schema as string);
      await this.service.deleteSchema(name);

      return this.responseUtils.success({});
    } catch (err) {
      return handlePubSubError(err, 'Schema', this.responseUtils);
    }
  }

  private async handleCommitSchema(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, schema } = req.params;
      const name = buildSchemaName(project as string, schema as string);
      const result = await this.service.commitSchema(name, req.body ?? {});

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Schema', this.responseUtils);
    }
  }

  private async handleRollbackSchema(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, schema } = req.params;
      const name = buildSchemaName(project as string, schema as string);
      const result = await this.service.rollbackSchema(name, req.body ?? {});

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Schema', this.responseUtils);
    }
  }

  private async handleListRevisions(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, schema } = req.params;
      const name = buildSchemaName(project as string, schema as string);
      const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined;
      const pageToken = req.query.pageToken as string | undefined;
      const view = req.query.view as string | undefined;
      const result = await this.service.listRevisions(name, pageSize, pageToken, view);

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Schema', this.responseUtils);
    }
  }

  private async handleDeleteRevision(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, schema } = req.params;
      const name = buildSchemaName(project as string, schema as string);
      const revisionId = req.query.revisionId as string;
      const result = await this.service.deleteRevision(name, revisionId);

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Schema', this.responseUtils);
    }
  }

  private async handleValidateSchema(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project } = req.params;
      const result = await this.service.validateSchema(project as string, req.body ?? {});

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Schema', this.responseUtils);
    }
  }

  private async handleValidateMessage(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project } = req.params;
      const result = await this.service.validateMessage(project as string, req.body ?? {});

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Schema', this.responseUtils);
    }
  }
}
