/**
 * HTTP layer for AlloyDB clusters. Parses requests, delegates, serializes.
 */

import type {
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import type { ResponseUtils } from '@/core/gateway/response-handlers.ts';
import { parsePageSize } from '@/shared/utils/pagination.ts';
import type { ClusterService } from './cluster-service.ts';
import { parseBooleanFlag, readBody, readQueryString, respondWith } from './handler-support.ts';
import { AlloyDbError } from './types.ts';

const RESOURCE_TYPE = 'Cluster';

export class ClusterHandlers {
  private readonly service: ClusterService;
  private readonly responseUtils: ResponseUtils;

  constructor(service: ClusterService, responseUtils: ResponseUtils) {
    this.service = service;
    this.responseUtils = responseUtils;
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'alloydb.clusters.create',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/clusters',
        handler: req => this.handleCreate(req),
      },
      {
        id: 'alloydb.clusters.list',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/clusters',
        handler: req => this.handleList(req),
      },
      {
        id: 'alloydb.clusters.get',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/clusters/:cluster',
        handler: req => this.handleGet(req),
      },
      {
        id: 'alloydb.clusters.patch',
        method: 'PATCH',
        path: '/v1/projects/:project/locations/:location/clusters/:cluster',
        handler: req => this.handlePatch(req),
      },
      {
        id: 'alloydb.clusters.delete',
        method: 'DELETE',
        path: '/v1/projects/:project/locations/:location/clusters/:cluster',
        handler: req => this.handleDelete(req),
      },
    ];
  }

  /**
   * <p><b>NOTE:</b> the cluster id arrives as the `clusterId` <i>query</i>
   * parameter, not in the body — the body is the Cluster resource itself. Several
   * GCP APIs do this and guessing gets it wrong.
   */
  private handleCreate(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, () => {
      const clusterId = readQueryString(req.query.clusterId);

      if (clusterId === undefined) {
        throw new AlloyDbError('INVALID_ARGUMENT', 'clusterId query parameter is required');
      }

      return this.service.createCluster(
        req.params.project ?? '',
        req.params.location ?? '',
        clusterId,
        readBody(req),
        { validateOnly: parseBooleanFlag(req.query.validateOnly) }
      );
    });
  }

  private handleList(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, async () => {
      const result = await this.service.listClusters(
        req.params.project ?? '',
        req.params.location ?? '',
        parsePageSize(req.query.pageSize),
        readQueryString(req.query.pageToken)
      );

      // Built literally rather than via ResponseUtils.paginated: GCP list
      // responses key on the resource name (`clusters`), not `items`.
      return result.nextPageToken === undefined
        ? { clusters: result.clusters }
        : { clusters: result.clusters, nextPageToken: result.nextPageToken };
    });
  }

  private handleGet(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, () =>
      this.service.getCluster(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.cluster ?? ''
      )
    );
  }

  private handlePatch(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, () =>
      this.service.updateCluster(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.cluster ?? '',
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
      this.service.deleteCluster(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.cluster ?? '',
        {
          force: parseBooleanFlag(req.query.force),
          validateOnly: parseBooleanFlag(req.query.validateOnly),
        }
      )
    );
  }
}
