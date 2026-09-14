/**
 * HTTP layer for AlloyDB backups. Parses requests, delegates, serializes.
 */

import type {
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import type { ResponseUtils } from '@/core/gateway/response-handlers.ts';
import { parsePageSize } from '@/shared/utils/pagination.ts';
import type { BackupService } from './backup-service.ts';
import { parseBooleanFlag, readBody, readQueryString, respondWith } from './handler-support.ts';
import { AlloyDbError } from './types.ts';

const RESOURCE_TYPE = 'Backup';

const BACKUPS_COLLECTION_PATH = '/v1/projects/:project/locations/:location/backups';
const BACKUP_PATH = `${BACKUPS_COLLECTION_PATH}/:backup`;

export class BackupHandlers {
  private readonly service: BackupService;
  private readonly responseUtils: ResponseUtils;

  constructor(service: BackupService, responseUtils: ResponseUtils) {
    this.service = service;
    this.responseUtils = responseUtils;
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'alloydb.backups.create',
        method: 'POST',
        path: BACKUPS_COLLECTION_PATH,
        handler: req => this.handleCreate(req),
      },
      {
        id: 'alloydb.backups.list',
        method: 'GET',
        path: BACKUPS_COLLECTION_PATH,
        handler: req => this.handleList(req),
      },
      {
        id: 'alloydb.backups.get',
        method: 'GET',
        path: BACKUP_PATH,
        handler: req => this.handleGet(req),
      },
      {
        id: 'alloydb.backups.patch',
        method: 'PATCH',
        path: BACKUP_PATH,
        handler: req => this.handlePatch(req),
      },
      {
        id: 'alloydb.backups.delete',
        method: 'DELETE',
        path: BACKUP_PATH,
        handler: req => this.handleDelete(req),
      },
    ];
  }

  private handleCreate(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, () => {
      const backupId = readQueryString(req.query.backupId);

      if (backupId === undefined) {
        throw new AlloyDbError('INVALID_ARGUMENT', 'backupId query parameter is required');
      }

      return this.service.createBackup(
        req.params.project ?? '',
        req.params.location ?? '',
        backupId,
        readBody(req),
        { validateOnly: parseBooleanFlag(req.query.validateOnly) }
      );
    });
  }

  private handleList(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, async () => {
      const result = await this.service.listBackups(
        req.params.project ?? '',
        req.params.location ?? '',
        parsePageSize(req.query.pageSize),
        readQueryString(req.query.pageToken)
      );

      return result.nextPageToken === undefined
        ? { backups: result.backups }
        : { backups: result.backups, nextPageToken: result.nextPageToken };
    });
  }

  private handleGet(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, () =>
      this.service.getBackup(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.backup ?? ''
      )
    );
  }

  private handlePatch(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, () =>
      this.service.updateBackup(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.backup ?? '',
        readBody(req),
        {
          updateMask: readQueryString(req.query.updateMask),
          allowMissing: parseBooleanFlag(req.query.allowMissing),
          validateOnly: parseBooleanFlag(req.query.validateOnly),
        }
      )
    );
  }

  private handleDelete(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, () =>
      this.service.deleteBackup(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.backup ?? '',
        { validateOnly: parseBooleanFlag(req.query.validateOnly) }
      )
    );
  }
}
