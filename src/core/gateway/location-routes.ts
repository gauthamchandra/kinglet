/**
 * Shared google.cloud.location.Locations routes.
 *
 * <p>Real GCP mixes this API into every service under that service's own host, so each
 * one can answer with the regions it actually supports. The emulator serves every
 * service from a single port, which leaves `/v1/projects/{project}/locations` with room
 * for exactly one owner — a second service registering it would silently shadow the
 * first. Owning it here keeps the endpoint available no matter which services are
 * enabled, and keeps services from competing for the path.
 *
 * <p><b>NOTE:</b> Cloud Tasks serves its own `/v2` locations routes; those live on a
 * different API version and do not collide with these.
 */

import type { Logger } from '@/shared/utils/logger.ts';
import type { RouteDefinition, RouteRequest, RouteResponse } from './request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from './response-handlers.ts';

interface GcpLocation {
  readonly locationId: string;
  readonly displayName: string;
}

export const GCP_LOCATIONS: readonly GcpLocation[] = [
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
  { locationId: 'global', displayName: 'Global' },
];

/**
 * Build the service-neutral `/v1` locations routes.
 *
 * <p>Register these once, alongside the health route, rather than from any individual
 * service. See {@link GCP_LOCATIONS} for the locations the emulator advertises.
 */
export function createLocationRoutes(logger: Logger): RouteDefinition[] {
  const responseUtils = new ResponseUtils(new StandardResponseFormatter(logger));

  return [
    {
      id: 'locations.list',
      method: 'GET',
      path: '/v1/projects/:project/locations',
      handler: req => listLocations(req, responseUtils),
    },
    {
      id: 'locations.get',
      method: 'GET',
      path: '/v1/projects/:project/locations/:location',
      handler: req => getLocation(req, responseUtils),
    },
  ];
}

function listLocations(req: RouteRequest, responseUtils: ResponseUtils): RouteResponse {
  const project = req.params.project ?? '';

  return responseUtils.success({
    locations: GCP_LOCATIONS.map(location => toLocationResource(project, location)),
  });
}

function getLocation(req: RouteRequest, responseUtils: ResponseUtils): RouteResponse {
  const { project, location: locationId } = req.params;
  const location = GCP_LOCATIONS.find(candidate => candidate.locationId === locationId);

  if (!location) {
    return responseUtils.notFound('Location', locationId ?? '');
  }

  return responseUtils.success(toLocationResource(project ?? '', location));
}

function toLocationResource(project: string, location: GcpLocation): Record<string, unknown> {
  return {
    name: `projects/${project}/locations/${location.locationId}`,
    locationId: location.locationId,
    displayName: location.displayName,
    labels: {},
    metadata: {
      '@type': 'type.googleapis.com/google.cloud.location.Location',
    },
  };
}
