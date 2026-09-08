/**
 * Factory helpers for constructing a product-stamped Postgres data plane.
 *
 * <p>Cloud SQL and AlloyDB share {@link DataPlaneManager}; they differ only in
 * the human-readable product label used in logs and the on-disk directory name
 * that keeps their PGlite data from colliding.
 */

import type { Logger } from '@/shared/utils/logger.ts';
import type {
  DataPlaneManagerOptions,
  LookupUser,
  PostgresDataPlane,
} from './data-plane-manager.ts';
import { DataPlaneManager, DisabledDataPlane } from './data-plane-manager.ts';

export type ProductDataPlaneOptions = Omit<
  DataPlaneManagerOptions,
  'productLabel' | 'dataDirectoryName'
>;

export interface PostgresDataPlaneProduct {
  productLabel: string;
  dataDirectoryName: string;
}

export const CLOUDSQL_DATA_PLANE_PRODUCT: PostgresDataPlaneProduct = {
  productLabel: 'Cloud SQL',
  dataDirectoryName: 'cloudsql',
};

export const ALLOYDB_DATA_PLANE_PRODUCT: PostgresDataPlaneProduct = {
  productLabel: 'AlloyDB',
  dataDirectoryName: 'alloydb',
};

/**
 * Build an enabled {@link DataPlaneManager} for `product`, or a
 * {@link DisabledDataPlane} when the service is running control-plane-only.
 */
export function createPostgresDataPlane(
  logger: Logger,
  product: PostgresDataPlaneProduct,
  options: ProductDataPlaneOptions & { enabled: boolean },
  lookupUser: LookupUser
): PostgresDataPlane {
  if (!options.enabled) return new DisabledDataPlane();

  const { enabled: _enabled, ...managerOptions } = options;

  return new DataPlaneManager(logger, { ...managerOptions, ...product }, lookupUser);
}
