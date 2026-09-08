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

/**
 * What a service entry point accepts for its data plane: the product's port
 * range and PostGIS choice, plus whether to run one at all. Shared so the two
 * products cannot drift on the shape.
 */
export interface ServiceDataPlaneOptions extends Partial<ProductDataPlaneOptions> {
  enabled?: boolean;
}

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

/** An instance the control plane still has rows for, keyed the way its data plane knows it. */
export interface PersistedInstance {
  /** Resource name, for the log line when the restart fails. */
  name: string;
  project: string;
  /** The key the data plane knows the instance by. */
  instance: string;
  databases: string[];
}

/**
 * Bring the data plane back up for instances that outlived the last run.
 *
 * <p>With durable storage the control-plane rows survive a restart, so without
 * this an instance would keep being listed and described while nothing listened
 * on its endpoint — and no admin call short of a recreate would ever bring it
 * back. One instance that cannot get a port back degrades only itself, not
 * startup for every other persisted instance.
 */
export async function restartPersistedInstances(
  logger: Logger,
  product: PostgresDataPlaneProduct,
  dataPlane: PostgresDataPlane,
  instances: PersistedInstance[]
): Promise<void> {
  for (const instance of instances) {
    try {
      await dataPlane.startInstance(instance.project, instance.instance, instance.databases);
    } catch (error) {
      logger.warn(
        `Failed to restart the data plane for ${product.productLabel} instance ${instance.name}, leaving it degraded`,
        error
      );
    }
  }
}
