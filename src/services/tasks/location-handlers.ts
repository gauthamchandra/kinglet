/**
 * Location and CMEK config HTTP route handlers for Cloud Tasks
 *
 * Provides locations.list, locations.get, getCmekConfig, and updateCmekConfig
 * endpoints for GCP client SDK compatibility.
 */

import type {
  RouteDefinition,
  RouteRequest,
  RouteContext,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { StandardResponseFormatter, ResponseUtils } from '@/core/gateway/response-handlers.ts';
import type { Logger } from '@/shared/utils/logger.ts';

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

export class LocationHandlers {
  private responseUtils: ResponseUtils;
  private logger: Logger;

  // TODO(cmek): CMEK/KMS integration is not implemented. These endpoints are
  // stubs that accept and echo back config for client SDK compatibility only.
  // Real CMEK would require integration with a KMS emulator to handle key
  // wrapping, rotation, and encryption operations.
  private cmekConfigs: Map<string, Record<string, unknown>> = new Map();

  constructor(logger: Logger) {
    this.logger = logger;
    const formatter = new StandardResponseFormatter(logger);

    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'tasks.locations.list',
        method: 'GET',
        path: '/v2/projects/:project/locations',
        handler: (req, ctx) => this.handleListLocations(req, ctx),
      },
      {
        id: 'tasks.locations.get',
        method: 'GET',
        path: '/v2/projects/:project/locations/:location',
        handler: (req, ctx) => this.handleGetLocation(req, ctx),
      },
      {
        id: 'tasks.locations.getCmekConfig',
        method: 'GET',
        path: '/v2/projects/:project/locations/:location/cmekConfig',
        handler: (req, ctx) => this.handleGetCmekConfig(req, ctx),
      },
      {
        id: 'tasks.locations.updateCmekConfig',
        method: 'PATCH',
        path: '/v2/projects/:project/locations/:location/cmekConfig',
        handler: (req, ctx) => this.handleUpdateCmekConfig(req, ctx),
      },
    ];
  }

  private handleListLocations(req: RouteRequest, _ctx: RouteContext): RouteResponse {
    const { project } = req.params;

    const locations = DEFAULT_LOCATIONS.map(locId =>
      this.buildLocationResponse(project ?? '', locId)
    );

    return this.responseUtils.success({ locations });
  }

  private handleGetLocation(req: RouteRequest, _ctx: RouteContext): RouteResponse {
    const { project, location } = req.params;

    return this.responseUtils.success(this.buildLocationResponse(project ?? '', location ?? ''));
  }

  private handleGetCmekConfig(req: RouteRequest, _ctx: RouteContext): RouteResponse {
    const { project, location } = req.params;
    const name = `projects/${project}/locations/${location}/cmekConfig`;

    const existing = this.cmekConfigs.get(name);

    return this.responseUtils.success({ name, ...existing });
  }

  private handleUpdateCmekConfig(req: RouteRequest, _ctx: RouteContext): RouteResponse {
    const { project, location } = req.params;
    const name = `projects/${project}/locations/${location}/cmekConfig`;
    const body = (req.body as Record<string, unknown>) ?? {};

    this.logger.warn(
      'CMEK config is stored in-memory only and will be lost on restart. ' +
        'This is a stub for client SDK compatibility.',
      { name }
    );

    const config = { ...body, name };

    this.cmekConfigs.set(name, config);

    return this.responseUtils.success(config);
  }

  private buildLocationResponse(project: string, locationId: string) {
    return {
      name: `projects/${project}/locations/${locationId}`,
      locationId,
      metadata: {
        '@type': 'type.googleapis.com/google.cloud.location.LocationMetadata',
      },
    };
  }
}
