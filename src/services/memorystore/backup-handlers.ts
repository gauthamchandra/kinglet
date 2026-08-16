/**
 * Backup collection / backup HTTP route handlers for Memorystore for Valkey
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
import type { BackupService } from './backup-service.ts';
import { buildBackupCollectionName, buildBackupName, handleMemoryStoreError } from './types.ts';

export class BackupHandlers {
  private service: BackupService;
  private responseUtils: ResponseUtils;

  constructor(service: BackupService, logger: Logger) {
    this.service = service;
    const formatter = new StandardResponseFormatter(logger);

    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'memorystore.backupCollections.list',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/backupCollections',
        handler: (req, ctx) => this.handleListBackupCollections(req, ctx),
      },
      {
        id: 'memorystore.backupCollections.get',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/backupCollections/:backupCollection',
        handler: (req, ctx) => this.handleGetBackupCollection(req, ctx),
      },
      {
        id: 'memorystore.backupCollections.backups.list',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/backupCollections/:backupCollection/backups',
        handler: (req, ctx) => this.handleListBackups(req, ctx),
      },
      {
        id: 'memorystore.backupCollections.backups.export',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/backupCollections/:backupCollection/backups/:backup:export',
        handler: (req, ctx) => this.handleExportBackup(req, ctx),
      },
      {
        id: 'memorystore.backupCollections.backups.get',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/backupCollections/:backupCollection/backups/:backup',
        handler: (req, ctx) => this.handleGetBackup(req, ctx),
      },
      {
        id: 'memorystore.backupCollections.backups.delete',
        method: 'DELETE',
        path: '/v1/projects/:project/locations/:location/backupCollections/:backupCollection/backups/:backup',
        handler: (req, ctx) => this.handleDeleteBackup(req, ctx),
      },
    ];
  }

  private async handleListBackupCollections(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, location } = req.params;
      const pageSize = parsePageSize(req.query.pageSize);
      const pageToken = (req.query.pageToken as string) || undefined;

      const result = await this.service.listBackupCollections(
        project ?? '',
        location ?? '',
        pageSize,
        pageToken
      );

      const body: Record<string, unknown> = { backupCollections: result.backupCollections };

      if (result.nextPageToken) body.nextPageToken = result.nextPageToken;

      return this.responseUtils.success(body);
    } catch (err) {
      return handleMemoryStoreError(err, 'BackupCollection', this.responseUtils);
    }
  }

  private async handleGetBackupCollection(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const name = this.buildCollectionNameFromParams(req.params);
      const result = await this.service.getBackupCollection(name);

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'BackupCollection', this.responseUtils);
    }
  }

  private async handleListBackups(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const collectionName = this.buildCollectionNameFromParams(req.params);
      const pageSize = parsePageSize(req.query.pageSize);
      const pageToken = (req.query.pageToken as string) || undefined;

      const result = await this.service.listBackups(collectionName, pageSize, pageToken);

      const body: Record<string, unknown> = { backups: result.backups };

      if (result.nextPageToken) body.nextPageToken = result.nextPageToken;

      return this.responseUtils.success(body);
    } catch (err) {
      return handleMemoryStoreError(err, 'Backup', this.responseUtils);
    }
  }

  private async handleGetBackup(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.getBackup(this.buildBackupNameFromParams(req.params));

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'Backup', this.responseUtils);
    }
  }

  private async handleDeleteBackup(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.deleteBackup(this.buildBackupNameFromParams(req.params));

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'Backup', this.responseUtils);
    }
  }

  private async handleExportBackup(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildBackupNameFromParams(req.params);
      const body = (req.body as { gcsBucket?: string }) ?? {};

      const result = await this.service.exportBackup(name, body);

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'Backup', this.responseUtils);
    }
  }

  private buildCollectionNameFromParams(params: Record<string, string>): string {
    return buildBackupCollectionName(
      params.project ?? '',
      params.location ?? '',
      params.backupCollection ?? ''
    );
  }

  private buildBackupNameFromParams(params: Record<string, string>): string {
    return buildBackupName(
      params.project ?? '',
      params.location ?? '',
      params.backupCollection ?? '',
      params.backup ?? ''
    );
  }
}
