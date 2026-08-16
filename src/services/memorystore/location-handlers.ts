/**
 * Location HTTP route handlers for Memorystore for Valkey
 *
 * Locations are a hardcoded GCP region list, matching the precedent set by
 * src/services/workflows/handlers.ts.
 */

import type {
  RouteContext,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import type { Logger } from '@/shared/utils/logger.ts';

const GCP_LOCATIONS = [
  { locationId: 'us-central1', displayName: 'Council Bluffs, Iowa, USA' },
  { locationId: 'us-east1', displayName: 'Moncks Corner, South Carolina, USA' },
  { locationId: 'us-east4', displayName: 'Ashburn, Virginia, USA' },
  { locationId: 'us-west1', displayName: 'The Dalles, Oregon, USA' },
  { locationId: 'us-west2', displayName: 'Los Angeles, California, USA' },
  { locationId: 'us-west3', displayName: 'Salt Lake City, Utah, USA' },
  { locationId: 'us-west4', displayName: 'Las Vegas, Nevada, USA' },
  { locationId: 'europe-west1', displayName: 'St. Ghislain, Belgium' },
  { locationId: 'europe-west2', displayName: 'London, England, UK' },
  { locationId: 'europe-west3', displayName: 'Frankfurt, Germany' },
  { locationId: 'europe-west4', displayName: 'Eemshaven, Netherlands' },
  { locationId: 'europe-west6', displayName: 'Zurich, Switzerland' },
  { locationId: 'asia-east1', displayName: 'Changhua County, Taiwan' },
  { locationId: 'asia-east2', displayName: 'Hong Kong' },
  { locationId: 'asia-northeast1', displayName: 'Tokyo, Japan' },
  { locationId: 'asia-northeast2', displayName: 'Osaka, Japan' },
  { locationId: 'asia-southeast1', displayName: 'Jurong West, Singapore' },
  { locationId: 'australia-southeast1', displayName: 'Sydney, Australia' },
  { locationId: 'northamerica-northeast1', displayName: 'Montreal, Quebec, Canada' },
  { locationId: 'southamerica-east1', displayName: 'Osasco, Sao Paulo, Brazil' },
  { locationId: 'me-west1', displayName: 'Tel Aviv, Israel' },
];

export class LocationHandlers {
  private responseUtils: ResponseUtils;

  constructor(logger: Logger) {
    const formatter = new StandardResponseFormatter(logger);

    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'memorystore.locations.getSharedRegionalCertificateAuthority',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/sharedRegionalCertificateAuthority',
        handler: (req, ctx) => this.handleGetSharedRegionalCertificateAuthority(req, ctx),
      },
      {
        id: 'memorystore.locations.list',
        method: 'GET',
        path: '/v1/projects/:project/locations',
        handler: (req, ctx) => this.handleListLocations(req, ctx),
      },
      {
        id: 'memorystore.locations.get',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location',
        handler: (req, ctx) => this.handleGetLocation(req, ctx),
      },
    ];
  }

  private handleListLocations(req: RouteRequest, _ctx: RouteContext): RouteResponse {
    const { project } = req.params;

    const locations = GCP_LOCATIONS.map(loc => ({
      name: `projects/${project}/locations/${loc.locationId}`,
      locationId: loc.locationId,
      displayName: loc.displayName,
      labels: {},
      metadata: {
        '@type': 'type.googleapis.com/google.cloud.location.Location',
      },
    }));

    return this.responseUtils.success({ locations });
  }

  private handleGetLocation(req: RouteRequest, _ctx: RouteContext): RouteResponse {
    const { project, location: locationId } = req.params;
    const loc = GCP_LOCATIONS.find(l => l.locationId === locationId);

    if (!loc) {
      return this.responseUtils.notFound('Location', locationId ?? '');
    }

    return this.responseUtils.success({
      name: `projects/${project}/locations/${loc.locationId}`,
      locationId: loc.locationId,
      displayName: loc.displayName,
      labels: {},
      metadata: {
        '@type': 'type.googleapis.com/google.cloud.location.Location',
      },
    });
  }

  private handleGetSharedRegionalCertificateAuthority(
    req: RouteRequest,
    _ctx: RouteContext
  ): RouteResponse {
    const { project, location } = req.params;

    // managedServerCa is the payload this RPC exists to deliver. Omitting it
    // leaves a client wiring TLS with `undefined` rather than an empty-but-
    // present cert list, mirroring instances.getCertificateAuthority.
    return this.responseUtils.success({
      name: `projects/${project}/locations/${location}/sharedRegionalCertificateAuthority`,
      managedServerCa: { caCerts: [] },
    });
  }
}
