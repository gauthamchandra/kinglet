/**
 * HTTP layer for Network Security address groups.
 *
 * `addressGroupId` arrives as a query parameter on create — the body is the
 * AddressGroup resource itself.
 */

import type {
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import type { ResponseUtils } from '@/core/gateway/response-handlers.ts';
import { parsePageSize } from '@/shared/utils/pagination.ts';
import { readBody, readQueryString, respondWith } from './handler-support.ts';
import type { AddressGroupService } from './service.ts';
import { NetworkSecurityError } from './types.ts';

const RESOURCE_TYPE = 'AddressGroup';
const COLLECTION_PATH = '/v1/projects/:project/locations/:location/addressGroups';
const RESOURCE_PATH = `${COLLECTION_PATH}/:addressGroup`;

export class AddressGroupHandlers {
  private readonly service: AddressGroupService;
  private readonly responseUtils: ResponseUtils;

  constructor(service: AddressGroupService, responseUtils: ResponseUtils) {
    this.service = service;
    this.responseUtils = responseUtils;
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'networksecurity.addressGroups.create',
        method: 'POST',
        path: COLLECTION_PATH,
        handler: req => this.handleCreate(req),
      },
      {
        id: 'networksecurity.addressGroups.list',
        method: 'GET',
        path: COLLECTION_PATH,
        handler: req => this.handleList(req),
      },
      {
        id: 'networksecurity.addressGroups.get',
        method: 'GET',
        path: RESOURCE_PATH,
        handler: req => this.handleGet(req),
      },
      {
        id: 'networksecurity.addressGroups.patch',
        method: 'PATCH',
        path: RESOURCE_PATH,
        handler: req => this.handlePatch(req),
      },
      {
        id: 'networksecurity.addressGroups.delete',
        method: 'DELETE',
        path: RESOURCE_PATH,
        handler: req => this.handleDelete(req),
      },
    ];
  }

  private handleCreate(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, () => {
      const addressGroupId = readQueryString(req.query.addressGroupId);

      if (addressGroupId === undefined) {
        throw new NetworkSecurityError(
          'INVALID_ARGUMENT',
          'addressGroupId query parameter is required'
        );
      }

      return this.service.createAddressGroup(
        req.params.project ?? '',
        req.params.location ?? '',
        addressGroupId,
        readBody(req)
      );
    });
  }

  private handleList(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, async () => {
      const result = await this.service.listAddressGroups(
        req.params.project ?? '',
        req.params.location ?? '',
        parsePageSize(req.query.pageSize),
        readQueryString(req.query.pageToken)
      );

      return result.nextPageToken === undefined
        ? { addressGroups: result.addressGroups }
        : { addressGroups: result.addressGroups, nextPageToken: result.nextPageToken };
    });
  }

  private handleGet(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, () =>
      this.service.getAddressGroup(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.addressGroup ?? ''
      )
    );
  }

  private handlePatch(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, () =>
      this.service.updateAddressGroup(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.addressGroup ?? '',
        readBody(req),
        readQueryString(req.query.updateMask)
      )
    );
  }

  private handleDelete(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, () =>
      this.service.deleteAddressGroup(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.addressGroup ?? ''
      )
    );
  }
}
