/**
 * Secret Manager HTTP route handlers
 */

import type {
  RouteContext,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import type { SecretService } from './service.ts';
import { SecretsError } from './service.ts';
import { buildSecretName, buildSecretVersionName } from './types.ts';

const DEFAULT_LOCATIONS = [
  'us-central1',
  'us-east1',
  'us-east4',
  'us-west1',
  'us-west2',
  'europe-west1',
  'europe-west2',
  'asia-east1',
  'asia-northeast1',
  'asia-southeast1',
];

export class SecretsHandlers {
  private service: SecretService;
  private responseUtils: ResponseUtils;
  private logger: Logger;

  constructor(service: SecretService, logger: Logger) {
    this.service = service;
    this.logger = logger;
    const formatter = new StandardResponseFormatter(logger);

    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      // ── Location routes ──
      {
        id: 'secrets.locations.list',
        method: 'GET',
        path: '/v1/projects/:project/locations',
        handler: (req, ctx) => this.handleListLocations(req, ctx),
      },
      {
        id: 'secrets.locations.get',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location',
        handler: (req, ctx) => this.handleGetLocation(req, ctx),
      },

      // ── Global secret routes ──
      // Action-suffix routes MUST come before plain param routes so the
      // linear-scan e2e router doesn't greedily match "1:access" as a versionId.
      {
        id: 'secrets.secrets.addVersion',
        method: 'POST',
        path: '/v1/projects/:project/secrets/:secretId:addVersion',
        handler: (req, ctx) => this.handleAddVersion(req, ctx),
      },
      {
        id: 'secrets.versions.access',
        method: 'GET',
        path: '/v1/projects/:project/secrets/:secretId/versions/:versionId:access',
        handler: (req, ctx) => this.handleAccessVersion(req, ctx),
      },
      {
        id: 'secrets.versions.destroy',
        method: 'POST',
        path: '/v1/projects/:project/secrets/:secretId/versions/:versionId:destroy',
        handler: (req, ctx) => this.handleDestroyVersion(req, ctx),
      },
      {
        id: 'secrets.versions.disable',
        method: 'POST',
        path: '/v1/projects/:project/secrets/:secretId/versions/:versionId:disable',
        handler: (req, ctx) => this.handleDisableVersion(req, ctx),
      },
      {
        id: 'secrets.versions.enable',
        method: 'POST',
        path: '/v1/projects/:project/secrets/:secretId/versions/:versionId:enable',
        handler: (req, ctx) => this.handleEnableVersion(req, ctx),
      },
      {
        id: 'secrets.secrets.create',
        method: 'POST',
        path: '/v1/projects/:project/secrets',
        handler: (req, ctx) => this.handleCreateSecret(req, ctx),
      },
      {
        id: 'secrets.secrets.get',
        method: 'GET',
        path: '/v1/projects/:project/secrets/:secretId',
        handler: (req, ctx) => this.handleGetSecret(req, ctx),
      },
      {
        id: 'secrets.secrets.list',
        method: 'GET',
        path: '/v1/projects/:project/secrets',
        handler: (req, ctx) => this.handleListSecrets(req, ctx),
      },
      {
        id: 'secrets.secrets.delete',
        method: 'DELETE',
        path: '/v1/projects/:project/secrets/:secretId',
        handler: (req, ctx) => this.handleDeleteSecret(req, ctx),
      },
      {
        id: 'secrets.secrets.patch',
        method: 'PATCH',
        path: '/v1/projects/:project/secrets/:secretId',
        handler: (req, ctx) => this.handlePatchSecret(req, ctx),
      },
      {
        id: 'secrets.versions.get',
        method: 'GET',
        path: '/v1/projects/:project/secrets/:secretId/versions/:versionId',
        handler: (req, ctx) => this.handleGetVersion(req, ctx),
      },
      {
        id: 'secrets.versions.list',
        method: 'GET',
        path: '/v1/projects/:project/secrets/:secretId/versions',
        handler: (req, ctx) => this.handleListVersions(req, ctx),
      },

      // ── Regional secret routes ──
      // Action-suffix routes first, then plain param routes.
      {
        id: 'secrets.regional.secrets.addVersion',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/secrets/:secretId:addVersion',
        handler: (req, ctx) => this.handleAddVersion(req, ctx),
      },
      {
        id: 'secrets.regional.versions.access',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/secrets/:secretId/versions/:versionId:access',
        handler: (req, ctx) => this.handleAccessVersion(req, ctx),
      },
      {
        id: 'secrets.regional.versions.destroy',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/secrets/:secretId/versions/:versionId:destroy',
        handler: (req, ctx) => this.handleDestroyVersion(req, ctx),
      },
      {
        id: 'secrets.regional.versions.disable',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/secrets/:secretId/versions/:versionId:disable',
        handler: (req, ctx) => this.handleDisableVersion(req, ctx),
      },
      {
        id: 'secrets.regional.versions.enable',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/secrets/:secretId/versions/:versionId:enable',
        handler: (req, ctx) => this.handleEnableVersion(req, ctx),
      },
      {
        id: 'secrets.regional.secrets.create',
        method: 'POST',
        path: '/v1/projects/:project/locations/:location/secrets',
        handler: (req, ctx) => this.handleCreateSecret(req, ctx),
      },
      {
        id: 'secrets.regional.secrets.get',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/secrets/:secretId',
        handler: (req, ctx) => this.handleGetSecret(req, ctx),
      },
      {
        id: 'secrets.regional.secrets.list',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/secrets',
        handler: (req, ctx) => this.handleListSecrets(req, ctx),
      },
      {
        id: 'secrets.regional.secrets.delete',
        method: 'DELETE',
        path: '/v1/projects/:project/locations/:location/secrets/:secretId',
        handler: (req, ctx) => this.handleDeleteSecret(req, ctx),
      },
      {
        id: 'secrets.regional.secrets.patch',
        method: 'PATCH',
        path: '/v1/projects/:project/locations/:location/secrets/:secretId',
        handler: (req, ctx) => this.handlePatchSecret(req, ctx),
      },
      {
        id: 'secrets.regional.versions.get',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/secrets/:secretId/versions/:versionId',
        handler: (req, ctx) => this.handleGetVersion(req, ctx),
      },
      {
        id: 'secrets.regional.versions.list',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/secrets/:secretId/versions',
        handler: (req, ctx) => this.handleListVersions(req, ctx),
      },
    ];
  }

  // ── Location Handlers ──

  private handleListLocations(req: RouteRequest, _ctx: RouteContext): RouteResponse {
    const { project } = req.params;

    const locations = DEFAULT_LOCATIONS.map(locId => ({
      name: `projects/${project}/locations/${locId}`,
      locationId: locId,
      metadata: {
        '@type': 'type.googleapis.com/google.cloud.location.LocationMetadata',
      },
    }));

    return this.responseUtils.success({ locations });
  }

  private handleGetLocation(req: RouteRequest, _ctx: RouteContext): RouteResponse {
    const { project, location } = req.params;

    return this.responseUtils.success({
      name: `projects/${project}/locations/${location}`,
      locationId: location,
      metadata: {
        '@type': 'type.googleapis.com/google.cloud.location.LocationMetadata',
      },
    });
  }

  // ── Secret Handlers ──

  private async handleCreateSecret(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, location } = req.params;
      const secretId = (req.query.secretId as string) ?? '';

      const result = await this.service.createSecret(project ?? '', secretId, req.body, location);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleGetSecret(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildSecretNameFromParams(req.params);
      const result = await this.service.getSecret(name);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleListSecrets(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, location } = req.params;
      const pageSize = this.parsePageSize(req.query.pageSize as string);
      const pageToken = (req.query.pageToken as string) || undefined;

      const result = await this.service.listSecrets(project ?? '', location, pageSize, pageToken);

      const body: Record<string, unknown> = { secrets: result.secrets };

      if (result.nextPageToken) {
        body.nextPageToken = result.nextPageToken;
      }

      body.totalSize = result.totalSize;

      return this.responseUtils.success(body);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleDeleteSecret(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildSecretNameFromParams(req.params);

      await this.service.deleteSecret(name);

      return this.responseUtils.success({});
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handlePatchSecret(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const name = this.buildSecretNameFromParams(req.params);
      const updateMask = req.query.updateMask as string | undefined;
      const result = await this.service.patchSecret(name, req.body, updateMask);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  // ── Version Handlers ──

  private async handleAddVersion(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const secretName = this.buildSecretNameFromParams(req.params);
      const result = await this.service.addVersion(secretName, req.body);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleGetVersion(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const versionName = this.buildVersionNameFromParams(req.params);
      const result = await this.service.getVersion(versionName);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleListVersions(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const secretName = this.buildSecretNameFromParams(req.params);
      const pageSize = this.parsePageSize(req.query.pageSize as string);
      const pageToken = (req.query.pageToken as string) || undefined;

      const result = await this.service.listVersions(secretName, pageSize, pageToken);

      const body: Record<string, unknown> = { versions: result.versions };

      if (result.nextPageToken) {
        body.nextPageToken = result.nextPageToken;
      }

      body.totalSize = result.totalSize;

      return this.responseUtils.success(body);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleAccessVersion(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const versionName = this.buildVersionNameFromParams(req.params);
      const result = await this.service.accessVersion(versionName);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleDestroyVersion(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const versionName = this.buildVersionNameFromParams(req.params);
      const result = await this.service.destroyVersion(versionName, req.body);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleDisableVersion(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const versionName = this.buildVersionNameFromParams(req.params);
      const result = await this.service.disableVersion(versionName, req.body);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleEnableVersion(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const versionName = this.buildVersionNameFromParams(req.params);
      const result = await this.service.enableVersion(versionName, req.body);

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  // ── Helpers ──

  private buildSecretNameFromParams(params: Record<string, string>): string {
    return buildSecretName(params.project ?? '', params.secretId ?? '', params.location);
  }

  private buildVersionNameFromParams(params: Record<string, string>): string {
    const secretName = this.buildSecretNameFromParams(params);

    return buildSecretVersionName(secretName, params.versionId ?? '');
  }

  private parsePageSize(raw: string | undefined): number | undefined {
    if (!raw) {
      return undefined;
    }

    const parsed = parseInt(raw, 10);

    return !Number.isNaN(parsed) && parsed > 0 ? parsed : undefined;
  }

  private handleError(err: unknown): RouteResponse {
    if (err instanceof SecretsError) {
      switch (err.code) {
        case 'NOT_FOUND':
          return this.responseUtils.notFound('Secret', err.message);
        case 'ALREADY_EXISTS':
          return this.responseUtils.alreadyExists('Secret', err.message);
        case 'INVALID_ARGUMENT':
          return this.responseUtils.badRequest(err.message);
        case 'FAILED_PRECONDITION':
          return this.responseUtils.failedPrecondition(err.message);
      }
    }

    this.logger.error('Unexpected error in secrets handler', err);

    return this.responseUtils.badRequest(err instanceof Error ? err.message : 'Unknown error');
  }
}
