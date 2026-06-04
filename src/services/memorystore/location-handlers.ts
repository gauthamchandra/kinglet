/**
 * Location-scoped HTTP route handlers for Memorystore for Valkey.
 *
 * <p>Only the Memorystore-specific location RPCs live here. The generic
 * `locations.list`/`locations.get` pair is shared across services and owned by
 * src/core/gateway/location-routes.ts.
 */

import type {
  RouteContext,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import type { Logger } from '@/shared/utils/logger.ts';

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
    ];
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
