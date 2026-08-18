/**
 * ACL Policy HTTP route handlers for Memorystore for Valkey
 *
 * `create` returns a bare AclPolicy resource, while `patch` and `delete`
 * return an Operation — an asymmetry mandated by the discovery document.
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
import type { AclPolicyService } from './acl-policy-service.ts';
import {
  buildAclPolicyName,
  buildAclPolicyRevisionName,
  handleMemoryStoreError,
  MemoryStoreError,
} from './types.ts';

export class AclPolicyHandlers {
  private service: AclPolicyService;
  private responseUtils: ResponseUtils;

  constructor(service: AclPolicyService, logger: Logger) {
    this.service = service;
    const formatter = new StandardResponseFormatter(logger);

    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'memorystore.aclPolicies.revisions.list',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/aclPolicies/:aclPolicy/revisions',
        handler: (req, ctx) => this.handleListAclPolicyRevisions(req, ctx),
      },
      {
        id: 'memorystore.aclPolicies.revisions.get',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/aclPolicies/:aclPolicy/revisions/:revision',
        handler: (req, ctx) => this.handleGetAclPolicyRevision(req, ctx),
      },
      {
        id: 'memorystore.aclPolicies.create',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/aclPolicies',
        handler: (req, ctx) => this.handleCreateAclPolicy(req, ctx),
      },
      {
        id: 'memorystore.aclPolicies.list',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/aclPolicies',
        handler: (req, ctx) => this.handleListAclPolicies(req, ctx),
      },
      {
        id: 'memorystore.aclPolicies.get',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/aclPolicies/:aclPolicy',
        handler: (req, ctx) => this.handleGetAclPolicy(req, ctx),
      },
      {
        id: 'memorystore.aclPolicies.patch',
        method: 'PATCH',
        path: '/v1/projects/:project/locations/:location/aclPolicies/:aclPolicy',
        handler: (req, ctx) => this.handleUpdateAclPolicy(req, ctx),
      },
      {
        id: 'memorystore.aclPolicies.delete',
        method: 'DELETE',
        path: '/v1/projects/:project/locations/:location/aclPolicies/:aclPolicy',
        handler: (req, ctx) => this.handleDeleteAclPolicy(req, ctx),
      },
    ];
  }

  private async handleCreateAclPolicy(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, location } = req.params;
      const aclPolicyId = (req.query.aclPolicyId as string) ?? '';
      const body = (req.body as { rules?: Array<{ username: string; rule: string }> }) ?? {};

      if (!aclPolicyId) {
        throw new MemoryStoreError('INVALID_ARGUMENT', 'aclPolicyId is required');
      }

      const result = await this.service.createAclPolicy(
        project ?? '',
        location ?? '',
        aclPolicyId,
        body
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'AclPolicy', this.responseUtils);
    }
  }

  private async handleGetAclPolicy(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const result = await this.service.getAclPolicy(this.buildNameFromParams(req.params));

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'AclPolicy', this.responseUtils);
    }
  }

  private async handleListAclPolicies(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, location } = req.params;
      const pageSize = parsePageSize(req.query.pageSize);
      const pageToken = (req.query.pageToken as string) || undefined;

      const result = await this.service.listAclPolicies(
        project ?? '',
        location ?? '',
        pageSize,
        pageToken
      );

      const body: Record<string, unknown> = { aclPolicies: result.aclPolicies };

      if (result.nextPageToken) body.nextPageToken = result.nextPageToken;

      return this.responseUtils.success(body);
    } catch (err) {
      return handleMemoryStoreError(err, 'AclPolicy', this.responseUtils);
    }
  }

  private async handleUpdateAclPolicy(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);
      const updateMask = (req.query.updateMask as string) || undefined;
      const body = (req.body as { rules?: Array<{ username: string; rule: string }> }) ?? {};

      const result = await this.service.updateAclPolicy(name, body, updateMask);

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'AclPolicy', this.responseUtils);
    }
  }

  private async handleDeleteAclPolicy(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const name = this.buildNameFromParams(req.params);
      const etag = (req.query.etag as string) || undefined;

      const result = await this.service.deleteAclPolicy(name, etag);

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'AclPolicy', this.responseUtils);
    }
  }

  private async handleListAclPolicyRevisions(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const policyName = this.buildNameFromParams(req.params);
      const pageSize = parsePageSize(req.query.pageSize);
      const pageToken = (req.query.pageToken as string) || undefined;

      const result = await this.service.listAclPolicyRevisions(policyName, pageSize, pageToken);

      const body: Record<string, unknown> = { aclPolicyRevisions: result.aclPolicyRevisions };

      if (result.nextPageToken) body.nextPageToken = result.nextPageToken;

      return this.responseUtils.success(body);
    } catch (err) {
      return handleMemoryStoreError(err, 'AclPolicy', this.responseUtils);
    }
  }

  private async handleGetAclPolicyRevision(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, location, aclPolicy, revision } = req.params;
      const revisionName = buildAclPolicyRevisionName(
        project ?? '',
        location ?? '',
        aclPolicy ?? '',
        revision ?? ''
      );

      const result = await this.service.getAclPolicyRevision(revisionName);

      return this.responseUtils.success(result);
    } catch (err) {
      return handleMemoryStoreError(err, 'AclPolicy', this.responseUtils);
    }
  }

  private buildNameFromParams(params: Record<string, string>): string {
    return buildAclPolicyName(params.project ?? '', params.location ?? '', params.aclPolicy ?? '');
  }
}
