/**
 * Composable Operations Routing
 *
 * Cloud Workflows and Memorystore for Valkey each expose their own
 * `/v1/projects/:project/locations/:location/operations[/:operationId]`
 * routes. Only one route may own a given method+path, so composing both
 * services on one router would otherwise mean one service's LRO endpoints
 * are simply absent.
 *
 * This builds a single shared route set that tries each store in priority
 * order, so an operation is reachable regardless of which service created
 * it. `addRoute` rejects a duplicate method+path outright, so callers must
 * register these routes *instead of* the individual services' own operations
 * routes, not merely before them — see `isComposedOperationsPath` and
 * docs/adrs/009-shared-route-namespace.md.
 */

import type { Logger } from '@/shared/utils/logger.ts';
import {
  DEFAULT_LIST_PAGE_SIZE,
  parseOffsetToken,
  parsePageSize,
} from '@/shared/utils/pagination.ts';
import type { RouteDefinition, RouteRequest } from './request-router.ts';
import { stripRouteParamNames } from './request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from './response-handlers.ts';

export interface ComposableOperationsListResult {
  operations: Record<string, unknown>[];
  nextPageToken?: string;
}

export interface ComposableOperationsStore {
  getOperation(name: string): Promise<Record<string, unknown> | null>;
  listOperations(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ComposableOperationsListResult>;
  deleteOperation(name: string): Promise<boolean>;
}

function buildOperationName(req: RouteRequest): string {
  const { project, location, operationId } = req.params;

  return `projects/${project}/locations/${location}/operations/${operationId}`;
}

// Large enough that no store's own operations table (ephemeral emulator
// state) is ever truncated when fetched for merging; pageSize/pageToken
// semantics are then enforced once, on the MERGED list, instead of being
// fanned out to each store individually (see composedOperations.list).
const UNBOUNDED_STORE_PAGE_SIZE = 1_000_000;

function compareOperationsByName(a: Record<string, unknown>, b: Record<string, unknown>): number {
  return String(a.name ?? '').localeCompare(String(b.name ?? ''));
}

const COMPOSED_OPERATIONS_PATHS = [
  '/v1/projects/:project/locations/:location/operations',
  '/v1/projects/:project/locations/:location/operations/:operationId',
].map(stripRouteParamNames);

/**
 * True when a service's own route would land on a path the composed set owns.
 *
 * <p>Services spell the parameter differently (`:operation` vs `:operationId`), so
 * the comparison has to ignore parameter names. Memorystore's `:cancel` verb keeps
 * its literal suffix and is therefore left to Memorystore.
 */
export function isComposedOperationsPath(path: string): boolean {
  return COMPOSED_OPERATIONS_PATHS.includes(stripRouteParamNames(path));
}

export function buildComposedOperationsRoutes(
  stores: ComposableOperationsStore[],
  logger: Logger
): RouteDefinition[] {
  const responseUtils = new ResponseUtils(new StandardResponseFormatter(logger));

  return [
    {
      id: 'composedOperations.list',
      method: 'GET',
      path: '/v1/projects/:project/locations/:location/operations',
      handler: async req => {
        const { project, location } = req.params;
        // Resolved here rather than left absent: this handler paginates the
        // merged list itself, so nothing downstream would otherwise apply the
        // default each store applies when asked directly, and composing two
        // services would silently turn a bounded list into an unbounded one.
        const pageSize = parsePageSize(req.query.pageSize) ?? DEFAULT_LIST_PAGE_SIZE;
        const offset = parseOffsetToken(req.query.pageToken);

        const results = await Promise.all(
          stores.map(store =>
            store.listOperations(project ?? '', location ?? '', UNBOUNDED_STORE_PAGE_SIZE)
          )
        );

        const merged = results.flatMap(result => result.operations).sort(compareOperationsByName);

        const body: Record<string, unknown> = {
          operations: merged.slice(offset, offset + pageSize),
        };

        if (offset + pageSize < merged.length) {
          body.nextPageToken = String(offset + pageSize);
        }

        return responseUtils.success(body);
      },
    },
    {
      id: 'composedOperations.get',
      method: 'GET',
      path: '/v1/projects/:project/locations/:location/operations/:operationId',
      handler: async req => {
        const name = buildOperationName(req);

        for (const store of stores) {
          const operation = await store.getOperation(name);

          if (operation) return responseUtils.success(operation);
        }

        return responseUtils.notFound('Operation', name);
      },
    },
    {
      id: 'composedOperations.delete',
      method: 'DELETE',
      path: '/v1/projects/:project/locations/:location/operations/:operationId',
      handler: async req => {
        const name = buildOperationName(req);

        for (const store of stores) {
          if (await store.deleteOperation(name)) return responseUtils.success({});
        }

        return responseUtils.notFound('Operation', name);
      },
    },
  ];
}
