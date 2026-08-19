/**
 * HTTP layer for AlloyDB's location and supported-database-flag endpoints.
 *
 * <p>Both are static catalogues rather than stored state, so there is no service
 * or repository layer beneath them.
 */

import type {
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import type { ResponseUtils } from '@/core/gateway/response-handlers.ts';
import {
  buildLocationResource,
  findGcpLocation,
  GCP_LOCATIONS,
} from '@/shared/utils/gcp-locations.ts';
import { parseOffsetToken, parsePageSize } from '@/shared/utils/pagination.ts';
import { readQueryString } from './handler-support.ts';

/**
 * A representative subset of AlloyDB's supported flags.
 *
 * <p><b>NOTE:</b> real AlloyDB returns hundreds. The discovery document describes
 * the shape but carries no flag data, so enumerating them faithfully is not
 * possible from the specification — this covers the flags most often asserted
 * against and is documented as partial in the README.
 */
const SUPPORTED_DATABASE_FLAGS: readonly Record<string, unknown>[] = [
  {
    flagName: 'max_connections',
    valueType: 'INTEGER',
    acceptsMultipleValues: false,
    requiresDbRestart: true,
    scope: 'DATABASE',
    integerRestrictions: { minValue: '14', maxValue: '262143' },
    supportedDbVersions: ['POSTGRES_14', 'POSTGRES_15', 'POSTGRES_16', 'POSTGRES_17'],
  },
  {
    flagName: 'work_mem',
    valueType: 'INTEGER',
    acceptsMultipleValues: false,
    requiresDbRestart: false,
    scope: 'DATABASE',
    integerRestrictions: { minValue: '64', maxValue: '2097151' },
    supportedDbVersions: ['POSTGRES_14', 'POSTGRES_15', 'POSTGRES_16', 'POSTGRES_17'],
  },
  {
    flagName: 'log_min_duration_statement',
    valueType: 'INTEGER',
    acceptsMultipleValues: false,
    requiresDbRestart: false,
    scope: 'DATABASE',
    integerRestrictions: { minValue: '-1', maxValue: '2147483647' },
    supportedDbVersions: ['POSTGRES_14', 'POSTGRES_15', 'POSTGRES_16', 'POSTGRES_17'],
  },
  {
    flagName: 'alloydb.enable_pgaudit',
    valueType: 'STRING',
    acceptsMultipleValues: false,
    requiresDbRestart: false,
    scope: 'DATABASE',
    stringRestrictions: { allowedValues: ['on', 'off'] },
    supportedDbVersions: ['POSTGRES_14', 'POSTGRES_15', 'POSTGRES_16', 'POSTGRES_17'],
  },
];

export class LocationHandlers {
  private readonly responseUtils: ResponseUtils;

  constructor(responseUtils: ResponseUtils) {
    this.responseUtils = responseUtils;
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'alloydb.locations.list',
        method: 'GET',
        path: '/v1/projects/:project/locations',
        handler: req => this.handleListLocations(req),
      },
      {
        id: 'alloydb.supportedDatabaseFlags.list',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/supportedDatabaseFlags',
        handler: req => this.handleListSupportedDatabaseFlags(req),
      },
      {
        id: 'alloydb.locations.get',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location',
        handler: req => this.handleGetLocation(req),
      },
    ];
  }

  private handleListLocations(req: RouteRequest): RouteResponse {
    const project = req.params.project ?? '';
    const page = paginate(GCP_LOCATIONS, req);

    return this.responseUtils.success({
      locations: page.items.map(location => buildLocationResource(project, location)),
      ...(page.nextPageToken === undefined ? {} : { nextPageToken: page.nextPageToken }),
    });
  }

  private handleGetLocation(req: RouteRequest): RouteResponse {
    const locationId = req.params.location ?? '';
    const location = findGcpLocation(locationId);

    if (!location) {
      return this.responseUtils.notFound('Location', locationId);
    }

    return this.responseUtils.success(buildLocationResource(req.params.project ?? '', location));
  }

  private handleListSupportedDatabaseFlags(req: RouteRequest): RouteResponse {
    const { project, location } = req.params;
    const page = paginate(SUPPORTED_DATABASE_FLAGS, req);

    return this.responseUtils.success({
      supportedDatabaseFlags: page.items.map(flag => ({
        name: `projects/${project}/locations/${location}/flags/${String(flag.flagName)}`,
        ...flag,
      })),
      ...(page.nextPageToken === undefined ? {} : { nextPageToken: page.nextPageToken }),
    });
  }
}

/**
 * Apply `pageSize`/`pageToken` to a constant catalogue.
 *
 * <p>Both list endpoints declare pagination in the discovery document, so serving
 * the whole array regardless would make a client that pages either loop or
 * double-process. An absent `pageSize` returns everything, which is what these
 * endpoints do in practice — the catalogues are small.
 */
function paginate<T>(
  items: readonly T[],
  req: RouteRequest
): { items: readonly T[]; nextPageToken?: string } {
  const pageSize = parsePageSize(req.query.pageSize);

  if (pageSize === undefined) return { items };

  const offset = parseOffsetToken(readQueryString(req.query.pageToken));
  const end = offset + pageSize;

  return {
    items: items.slice(offset, end),
    ...(end < items.length ? { nextPageToken: String(end) } : {}),
  };
}
