/**
 * HTTP layer for AlloyDB's supported-database-flag endpoint.
 *
 * <p>A static catalogue rather than stored state, so there is no service or
 * repository layer beneath it. The generic `locations.list`/`get` pair is served
 * once by the shared gateway routes (see src/core/gateway/location-routes.ts) and
 * is deliberately not registered here — one owner per path, per
 * docs/adrs/009-shared-route-namespace.md.
 */

import type {
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import type { ResponseUtils } from '@/core/gateway/response-handlers.ts';
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
        id: 'alloydb.supportedDatabaseFlags.list',
        method: 'GET',
        path: '/v1/projects/:project/locations/:location/supportedDatabaseFlags',
        handler: req => this.handleListSupportedDatabaseFlags(req),
      },
    ];
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
