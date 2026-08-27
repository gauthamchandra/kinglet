/**
 * HTTP layer for AlloyDB instances. Parses requests, delegates, serializes.
 */

import type {
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import type { ResponseUtils } from '@/core/gateway/response-handlers.ts';
import { parsePageSize } from '@/shared/utils/pagination.ts';
import { parseBooleanFlag, readBody, readQueryString, respondWith } from './handler-support.ts';
import type { InstanceService } from './instance-service.ts';
import { AlloyDbError } from './types.ts';

const RESOURCE_TYPE = 'Instance';

const INSTANCES_COLLECTION_PATH =
  '/v1/projects/:project/locations/:location/clusters/:cluster/instances';
const INSTANCE_PATH = `${INSTANCES_COLLECTION_PATH}/:instance`;

export class InstanceHandlers {
  private readonly service: InstanceService;
  private readonly responseUtils: ResponseUtils;

  constructor(service: InstanceService, responseUtils: ResponseUtils) {
    this.service = service;
    this.responseUtils = responseUtils;
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'alloydb.clusters.instances.create',
        method: 'POST',
        path: INSTANCES_COLLECTION_PATH,
        handler: req => this.handleCreate(req),
      },
      {
        id: 'alloydb.clusters.instances.list',
        method: 'GET',
        path: INSTANCES_COLLECTION_PATH,
        handler: req => this.handleList(req),
      },
      {
        id: 'alloydb.clusters.instances.getConnectionInfo',
        method: 'GET',
        path: `${INSTANCE_PATH}/connectionInfo`,
        handler: req => this.handleGetConnectionInfo(req),
      },
      {
        id: 'alloydb.clusters.instances.get',
        method: 'GET',
        path: INSTANCE_PATH,
        handler: req => this.handleGet(req),
      },
      {
        id: 'alloydb.clusters.instances.patch',
        method: 'PATCH',
        path: INSTANCE_PATH,
        handler: req => this.handlePatch(req),
      },
      {
        id: 'alloydb.clusters.instances.delete',
        method: 'DELETE',
        path: INSTANCE_PATH,
        handler: req => this.handleDelete(req),
      },
    ];
  }

  private handleCreate(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, () => {
      const instanceId = readQueryString(req.query.instanceId);

      if (instanceId === undefined) {
        throw new AlloyDbError('INVALID_ARGUMENT', 'instanceId query parameter is required');
      }

      return this.service.createInstance(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.cluster ?? '',
        instanceId,
        readBody(req),
        { validateOnly: parseBooleanFlag(req.query.validateOnly) }
      );
    });
  }

  private handleList(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, async () => {
      const result = await this.service.listInstances(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.cluster ?? '',
        parsePageSize(req.query.pageSize),
        readQueryString(req.query.pageToken)
      );

      return result.nextPageToken === undefined
        ? { instances: result.instances }
        : { instances: result.instances, nextPageToken: result.nextPageToken };
    });
  }

  private handleGet(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, () =>
      this.service.getInstance(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.cluster ?? '',
        req.params.instance ?? ''
      )
    );
  }

  private handlePatch(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, () =>
      this.service.updateInstance(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.cluster ?? '',
        req.params.instance ?? '',
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
      this.service.deleteInstance(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.cluster ?? '',
        req.params.instance ?? '',
        { validateOnly: parseBooleanFlag(req.query.validateOnly) }
      )
    );
  }

  private handleGetConnectionInfo(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, () =>
      this.service.getConnectionInfo(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.cluster ?? '',
        req.params.instance ?? ''
      )
    );
  }
}
