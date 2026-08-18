/**
 * Token auth user / auth token HTTP route handlers for Memorystore for Valkey
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
import type { TokenAuthService } from './token-auth-service.ts';
import {
  buildAuthTokenName,
  buildInstanceName,
  buildTokenAuthUserName,
  handleMemoryStoreError,
} from './types.ts';

export class TokenAuthHandlers {
  private service: TokenAuthService;
  private responseUtils: ResponseUtils;

  constructor(service: TokenAuthService, logger: Logger) {
    this.service = service;
    const formatter = new StandardResponseFormatter(logger);

    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'memorystore.tokenAuthUsers.addAuthToken',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/instances/:instance/tokenAuthUsers/:tokenAuthUser:addAuthToken',
        handler: (req, ctx) => this.handleAddAuthToken(req, ctx),
      },
      {
        id: 'memorystore.tokenAuthUsers.authTokens.list',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/instances/:instance/tokenAuthUsers/:tokenAuthUser/authTokens',
        handler: (req, ctx) => this.handleListAuthTokens(req, ctx),
      },
      {
        id: 'memorystore.tokenAuthUsers.authTokens.get',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/instances/:instance/tokenAuthUsers/:tokenAuthUser/authTokens/:authToken',
        handler: (req, ctx) => this.handleGetAuthToken(req, ctx),
      },
      {
        id: 'memorystore.tokenAuthUsers.authTokens.delete',
        method: 'DELETE',
        path: '/v1/projects/:project/locations/:location/instances/:instance/tokenAuthUsers/:tokenAuthUser/authTokens/:authToken',
        handler: (req, ctx) => this.handleDeleteAuthToken(req, ctx),
      },
      {
        id: 'memorystore.tokenAuthUsers.list',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/instances/:instance/tokenAuthUsers',
        handler: (req, ctx) => this.handleListTokenAuthUsers(req, ctx),
      },
      {
        id: 'memorystore.tokenAuthUsers.get',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/instances/:instance/tokenAuthUsers/:tokenAuthUser',
        handler: (req, ctx) => this.handleGetTokenAuthUser(req, ctx),
      },
      {
        id: 'memorystore.tokenAuthUsers.delete',
        method: 'DELETE',
        path: '/v1/projects/:project/locations/:location/instances/:instance/tokenAuthUsers/:tokenAuthUser',
        handler: (req, ctx) => this.handleDeleteTokenAuthUser(req, ctx),
      },
    ];
  }

  private async handleListTokenAuthUsers(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const instanceName = this.buildInstanceNameFromParams(req.params);
      const pageSize = parsePageSize(req.query.pageSize);
      const pageToken = (req.query.pageToken as string) || undefined;

      const result = await this.service.listTokenAuthUsers(instanceName, pageSize, pageToken);

      const body: Record<string, unknown> = { tokenAuthUsers: result.tokenAuthUsers };

      if (result.nextPageToken) body.nextPageToken = result.nextPageToken;

      return this.responseUtils.success(body);
    } catch (err) {
      return handleMemoryStoreError(err, 'TokenAuthUser', this.responseUtils);
    }
  }

  private async handleGetTokenAuthUser(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const result = await this.service.getTokenAuthUser(this.buildUserNameFromParams(req.params));

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'TokenAuthUser', this.responseUtils);
    }
  }

  private async handleDeleteTokenAuthUser(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const name = this.buildUserNameFromParams(req.params);
      const force = req.query.force === 'true';
      const requestId = (req.query.requestId as string) || undefined;

      const result = await this.service.deleteTokenAuthUser(name, force, requestId);

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'TokenAuthUser', this.responseUtils);
    }
  }

  private async handleAddAuthToken(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildUserNameFromParams(req.params);

      const result = await this.service.addAuthToken(name, req.body);

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'TokenAuthUser', this.responseUtils);
    }
  }

  private async handleListAuthTokens(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const tokenAuthUserName = this.buildUserNameFromParams(req.params);
      const pageSize = parsePageSize(req.query.pageSize);
      const pageToken = (req.query.pageToken as string) || undefined;

      const result = await this.service.listAuthTokens(tokenAuthUserName, pageSize, pageToken);

      const body: Record<string, unknown> = { authTokens: result.authTokens };

      if (result.nextPageToken) body.nextPageToken = result.nextPageToken;

      return this.responseUtils.success(body);
    } catch (err) {
      return handleMemoryStoreError(err, 'AuthToken', this.responseUtils);
    }
  }

  private async handleGetAuthToken(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.getAuthToken(this.buildAuthTokenNameFromParams(req.params));

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'AuthToken', this.responseUtils);
    }
  }

  private async handleDeleteAuthToken(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const result = await this.service.deleteAuthToken(
        this.buildAuthTokenNameFromParams(req.params)
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'AuthToken', this.responseUtils);
    }
  }

  private buildInstanceNameFromParams(params: Record<string, string>): string {
    return buildInstanceName(params.project ?? '', params.location ?? '', params.instance ?? '');
  }

  private buildUserNameFromParams(params: Record<string, string>): string {
    return buildTokenAuthUserName(
      params.project ?? '',
      params.location ?? '',
      params.instance ?? '',
      params.tokenAuthUser ?? ''
    );
  }

  private buildAuthTokenNameFromParams(params: Record<string, string>): string {
    return buildAuthTokenName(
      params.project ?? '',
      params.location ?? '',
      params.instance ?? '',
      params.tokenAuthUser ?? '',
      params.authToken ?? ''
    );
  }
}
