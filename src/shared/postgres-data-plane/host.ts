/**
 * Factory helpers for constructing a product-stamped Postgres data plane.
 *
 * <p>Both Cloud SQL and AlloyDB use real Postgres servers (ADR-019). The
 * on-disk directory name keeps their data from colliding.
 */

import { dirname } from 'node:path';
import type { Logger } from '@/shared/utils/logger.ts';
import type {
  DataPlaneManagerOptions,
  LookupUser,
  PostgresDataPlane,
} from './data-plane-manager.ts';
import { DisabledDataPlane } from './data-plane-manager.ts';
import { PostgresContainerSupervisor } from './postgres-container-supervisor.ts';
import { PostgresProcessManager } from './postgres-process-manager.ts';
import { PostgresServerDataPlane } from './postgres-server-data-plane.ts';

export type ProductDataPlaneOptions = Omit<
  DataPlaneManagerOptions,
  'productLabel' | 'dataDirectoryName'
> & {
  /** Directory of `postgres` and `initdb`. Unset searches `pg_config`, then `PATH`. */
  postgresBinDir?: string | undefined;
  /**
   * Docker image to use for Cloud SQL instances. When set, each instance
   * starts inside a container running this image instead of a supervised
   * child process. Unset (default) keeps the existing process-manager path.
   * See ADR-019 and {@link PostgresContainerSupervisor}.
   */
  postgresImage?: string | undefined;
};

/**
 * What a service entry point accepts for its data plane: the product's port
 * range and PostGIS choice, plus whether to run one at all. Shared so the two
 * products cannot drift on the shape.
 */
export interface ServiceDataPlaneOptions extends Partial<ProductDataPlaneOptions> {
  enabled?: boolean;
}

/** The two products that share this data plane. Adding a third means adding it here. */
export type PostgresDataPlaneProductLabel = 'Cloud SQL' | 'AlloyDB';
export type PostgresDataPlaneDirectoryName = 'cloudsql' | 'alloydb';

export interface PostgresDataPlaneProduct {
  productLabel: PostgresDataPlaneProductLabel;
  dataDirectoryName: PostgresDataPlaneDirectoryName;
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
 * Build the data plane for `product`, or a {@link DisabledDataPlane} when the
 * service is running control-plane-only. Both Cloud SQL and AlloyDB get a real
 * Postgres server; the on-disk directory name keeps their data from colliding.
 */
export function createPostgresDataPlane(
  logger: Logger,
  product: PostgresDataPlaneProduct,
  options: ProductDataPlaneOptions & { enabled: boolean },
  _lookupUser: LookupUser
): PostgresDataPlane {
  if (!options.enabled) return new DisabledDataPlane();

  const { enabled: _enabled, postgresBinDir, postgresImage, ...managerOptions } = options;
  const supervisor =
    product === CLOUDSQL_DATA_PLANE_PRODUCT && postgresImage != null
      ? new PostgresContainerSupervisor({ image: postgresImage })
      : new PostgresProcessManager(logger, {
          ...(postgresBinDir != null ? { binDir: postgresBinDir } : {}),
        });

  return new PostgresServerDataPlane(logger, {
    product,
    dataDirectory:
      managerOptions.storageType === 'memory' ? null : dirname(managerOptions.sqlitePath),
    portRangeStart: managerOptions.portRangeStart,
    portRangeEnd: managerOptions.portRangeEnd,
    processManager: supervisor,
  });
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
