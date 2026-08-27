/**
 * HTTP layer for AlloyDB users. Parses requests, delegates, serializes.
 *
 * <p><b>NOTE:</b> these routes return the `User` resource directly, and delete
 * returns an empty object — not `Operation`, unlike every cluster and instance
 * mutation. See {@link UserService}.
 */

import type {
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import type { ResponseUtils } from '@/core/gateway/response-handlers.ts';
import { parsePageSize } from '@/shared/utils/pagination.ts';
import { parseBooleanFlag, readBody, readQueryString, respondWith } from './handler-support.ts';
import { AlloyDbError } from './types.ts';
import type { UserService } from './user-service.ts';

const RESOURCE_TYPE = 'User';

const USERS_COLLECTION_PATH = '/v1/projects/:project/locations/:location/clusters/:cluster/users';
const USER_PATH = `${USERS_COLLECTION_PATH}/:user`;

export class UserHandlers {
  private readonly service: UserService;
  private readonly responseUtils: ResponseUtils;

  constructor(service: UserService, responseUtils: ResponseUtils) {
    this.service = service;
    this.responseUtils = responseUtils;
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'alloydb.clusters.users.create',
        method: 'POST',
        path: USERS_COLLECTION_PATH,
        handler: req => this.handleCreate(req),
      },
      {
        id: 'alloydb.clusters.users.list',
        method: 'GET',
        path: USERS_COLLECTION_PATH,
        handler: req => this.handleList(req),
      },
      {
        id: 'alloydb.clusters.users.get',
        method: 'GET',
        path: USER_PATH,
        handler: req => this.handleGet(req),
      },
      {
        id: 'alloydb.clusters.users.patch',
        method: 'PATCH',
        path: USER_PATH,
        handler: req => this.handlePatch(req),
      },
      {
        id: 'alloydb.clusters.users.delete',
        method: 'DELETE',
        path: USER_PATH,
        handler: req => this.handleDelete(req),
      },
    ];
  }

  private handleCreate(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, () => {
      const userId = readQueryString(req.query.userId);

      if (userId === undefined) {
        throw new AlloyDbError('INVALID_ARGUMENT', 'userId query parameter is required');
      }

      return this.service.createUser(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.cluster ?? '',
        userId,
        readBody(req),
        { validateOnly: parseBooleanFlag(req.query.validateOnly) }
      );
    });
  }

  private handleList(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, async () => {
      const result = await this.service.listUsers(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.cluster ?? '',
        parsePageSize(req.query.pageSize),
        readQueryString(req.query.pageToken)
      );

      return result.nextPageToken === undefined
        ? { users: result.users }
        : { users: result.users, nextPageToken: result.nextPageToken };
    });
  }

  private handleGet(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, () =>
      this.service.getUser(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.cluster ?? '',
        req.params.user ?? ''
      )
    );
  }

  private handlePatch(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, () =>
      this.service.updateUser(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.cluster ?? '',
        req.params.user ?? '',
        readBody(req),
        {
          updateMask: readQueryString(req.query.updateMask),
          allowMissing: parseBooleanFlag(req.query.allowMissing),
          validateOnly: parseBooleanFlag(req.query.validateOnly),
        }
      )
    );
  }

  /** Answers `google.protobuf.Empty` — an empty JSON object with status 200. */
  private handleDelete(req: RouteRequest): Promise<RouteResponse> {
    return respondWith(RESOURCE_TYPE, this.responseUtils, async () => {
      await this.service.deleteUser(
        req.params.project ?? '',
        req.params.location ?? '',
        req.params.cluster ?? '',
        req.params.user ?? '',
        { validateOnly: parseBooleanFlag(req.query.validateOnly) }
      );

      return {};
    });
  }
}
