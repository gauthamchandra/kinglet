/**
 * Instance HTTP route handlers for Memorystore for Valkey
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
import type { InstanceService } from './instance-service.ts';
import { buildInstanceName, handleMemoryStoreError, MemoryStoreError } from './types.ts';

export class InstanceHandlers {
  private service: InstanceService;
  private responseUtils: ResponseUtils;

  constructor(service: InstanceService, logger: Logger) {
    this.service = service;
    const formatter = new StandardResponseFormatter(logger);

    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'memorystore.instances.create',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/instances',
        handler: (req, ctx) => this.handleCreateInstance(req, ctx),
      },
      {
        id: 'memorystore.instances.list',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/instances',
        handler: (req, ctx) => this.handleListInstances(req, ctx),
      },
      {
        id: 'memorystore.instances.backup',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/instances/:instance:backup',
        handler: (req, ctx) => this.handleBackupInstance(req, ctx),
      },
      {
        id: 'memorystore.instances.startMigration',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/instances/:instance:startMigration',
        handler: (req, ctx) => this.handleStartMigration(req, ctx),
      },
      {
        id: 'memorystore.instances.finishMigration',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/instances/:instance:finishMigration',
        handler: (req, ctx) => this.handleFinishMigration(req, ctx),
      },
      {
        id: 'memorystore.instances.rescheduleMaintenance',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/instances/:instance:rescheduleMaintenance',
        handler: (req, ctx) => this.handleRescheduleMaintenance(req, ctx),
      },
      {
        id: 'memorystore.instances.addTokenAuthUser',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/instances/:instance:addTokenAuthUser',
        handler: (req, ctx) => this.handleAddTokenAuthUser(req, ctx),
      },
      {
        id: 'memorystore.instances.getCertificateAuthority',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/instances/:instance/certificateAuthority',
        handler: (req, ctx) => this.handleGetCertificateAuthority(req, ctx),
      },
      {
        id: 'memorystore.instances.get',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/instances/:instance',
        handler: (req, ctx) => this.handleGetInstance(req, ctx),
      },
      {
        id: 'memorystore.instances.patch',
        method: 'PATCH',
        path: '/v1/projects/:project/locations/:location/instances/:instance',
        handler: (req, ctx) => this.handleUpdateInstance(req, ctx),
      },
      {
        id: 'memorystore.instances.delete',
        method: 'DELETE',
        path: '/v1/projects/:project/locations/:location/instances/:instance',
        handler: (req, ctx) => this.handleDeleteInstance(req, ctx),
      },
    ];
  }

  private async handleCreateInstance(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, location } = req.params;
      const instanceId = (req.query.instanceId as string) ?? '';
      const body = (req.body as Record<string, unknown>) ?? {};

      if (!instanceId) {
        throw new MemoryStoreError('INVALID_ARGUMENT', 'instanceId is required');
      }

      const result = await this.service.createInstance(
        project ?? '',
        location ?? '',
        instanceId,
        body
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'Instance', this.responseUtils);
    }
  }

  private async handleGetInstance(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.getInstance(this.buildNameFromParams(req.params));

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'Instance', this.responseUtils);
    }
  }

  private async handleListInstances(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, location } = req.params;
      const pageSize = parsePageSize(req.query.pageSize);
      const pageToken = (req.query.pageToken as string) || undefined;
      const filter = (req.query.filter as string) || undefined;
      const orderBy = (req.query.orderBy as string) || undefined;

      const result = await this.service.listInstances(
        project ?? '',
        location ?? '',
        pageSize,
        pageToken,
        filter,
        orderBy
      );

      const body: Record<string, unknown> = { instances: result.instances };

      if (result.nextPageToken) body.nextPageToken = result.nextPageToken;

      return this.responseUtils.success(body);
    } catch (err) {
      return handleMemoryStoreError(err, 'Instance', this.responseUtils);
    }
  }

  private async handleUpdateInstance(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);
      const updateMask = (req.query.updateMask as string) || undefined;
      const body = (req.body as Record<string, unknown>) ?? {};

      const result = await this.service.updateInstance(name, body, updateMask);

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'Instance', this.responseUtils);
    }
  }

  private async handleDeleteInstance(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const result = await this.service.deleteInstance(this.buildNameFromParams(req.params));

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'Instance', this.responseUtils);
    }
  }

  private async handleGetCertificateAuthority(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const result = await this.service.getCertificateAuthority(
        this.buildNameFromParams(req.params)
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'Instance', this.responseUtils);
    }
  }

  private async handleBackupInstance(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);
      const body = (req.body as { ttl?: string; backupId?: string }) ?? {};

      const result = await this.service.backupInstance(name, body);

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'Instance', this.responseUtils);
    }
  }

  private async handleStartMigration(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);
      const body = (req.body as { selfManagedSource?: unknown }) ?? {};

      const result = await this.service.startMigration(name, body);

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'Instance', this.responseUtils);
    }
  }

  private async handleFinishMigration(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);
      const body = (req.body as { force?: boolean }) ?? {};

      const result = await this.service.finishMigration(name, body);

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'Instance', this.responseUtils);
    }
  }

  private async handleRescheduleMaintenance(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);
      const body = (req.body as { rescheduleType?: string; scheduleTime?: string }) ?? {};

      const result = await this.service.rescheduleMaintenance(name, body);

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'Instance', this.responseUtils);
    }
  }

  private async handleAddTokenAuthUser(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);

      const result = await this.service.addTokenAuthUser(name, req.body);

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'Instance', this.responseUtils);
    }
  }

  private buildNameFromParams(params: Record<string, string>): string {
    return buildInstanceName(params.project ?? '', params.location ?? '', params.instance ?? '');
  }
}
