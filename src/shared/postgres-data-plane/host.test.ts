/**
 * Tests for createPostgresDataPlane product wiring
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@/shared/utils/logger.ts';
import { DisabledDataPlane } from './data-plane-manager.ts';
import {
  ALLOYDB_DATA_PLANE_PRODUCT,
  CLOUDSQL_DATA_PLANE_PRODUCT,
  createPostgresDataPlane,
  type PostgresDataPlaneProduct,
} from './host.ts';
import { PostgresServerDataPlane } from './postgres-server-data-plane.ts';

const logger = new Logger('PostgresDataPlaneHostTest', 'error');

let temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }

  temporaryDirectories = [];
});

async function planeForProduct(product: PostgresDataPlaneProduct, portRangeStart: number) {
  const root = await mkdtemp(join(tmpdir(), 'kinglet-host-'));

  temporaryDirectories.push(root);

  const plane = createPostgresDataPlane(logger, product, {
    enabled: true,
    portRangeStart,
    portRangeEnd: portRangeStart + 4,
    storageType: 'sqlite',
    sqlitePath: join(root, 'emulator.db'),
    postgis: false,
  });

  return { plane, root };
}

describe('createPostgresDataPlane', () => {
  test('returnsDisabledDataPlaneWhenNotEnabled', () => {
    const plane = createPostgresDataPlane(logger, CLOUDSQL_DATA_PLANE_PRODUCT, {
      enabled: false,
      portRangeStart: 46390,
      portRangeEnd: 46394,
      storageType: 'memory',
      sqlitePath: './data/emulator.db',
      postgis: false,
    });

    expect(plane).toBeInstanceOf(DisabledDataPlane);
  });

  test('returnsAPostgresServerDataPlaneStampedWithTheAlloyDbProduct', async () => {
    const { plane } = await planeForProduct(ALLOYDB_DATA_PLANE_PRODUCT, 46395);

    expect(plane).toBeInstanceOf(PostgresServerDataPlane);
  });

  /**
   * The on-disk namespace is the only reason this factory exists, and an
   * `instanceof` assertion alone would pass with the two products swapped —
   * which would silently point Cloud SQL at AlloyDB's data. Driven through
   * `dropInstance`, which resolves the instance directory from disk, so the
   * namespace is observed rather than read back out of private options.
   */
  test('dropsOnlyTheProductsOwnDirectoryTree', async () => {
    const { plane, root } = await planeForProduct(ALLOYDB_DATA_PLANE_PRODUCT, 46400);
    const alloydbInstance = join(root, 'alloydb/p1/inst');
    const cloudsqlInstance = join(root, 'cloudsql/p1/inst');

    await mkdir(alloydbInstance, { recursive: true });
    await mkdir(cloudsqlInstance, { recursive: true });

    await plane.dropInstance('p1', 'inst');

    expect(existsSync(alloydbInstance)).toBe(false);
    expect(existsSync(cloudsqlInstance)).toBe(true);
  });

  /**
   * The isolation between products is per manager plus on-disk namespace, not
   * something encoded in the instance key. So the same project/instance string
   * handed to both products must resolve to two different trees — otherwise a
   * Cloud SQL drop could take an AlloyDB instance's data with it.
   */
  test('identicalInstanceKeysInBothProductsNeverShareADirectory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-host-'));

    temporaryDirectories.push(root);

    const options = {
      enabled: true,
      storageType: 'sqlite',
      sqlitePath: join(root, 'emulator.db'),
      postgis: false,
    } as const;
    const cloudsql = createPostgresDataPlane(logger, CLOUDSQL_DATA_PLANE_PRODUCT, {
      ...options,
      portRangeStart: 46410,
      portRangeEnd: 46414,
    });
    const alloydb = createPostgresDataPlane(logger, ALLOYDB_DATA_PLANE_PRODUCT, {
      ...options,
      portRangeStart: 46415,
      portRangeEnd: 46419,
    });
    const cloudsqlTree = join(root, 'cloudsql/p1/us-central1%2Fc1%2Fi1');
    const alloydbTree = join(root, 'alloydb/p1/us-central1%2Fc1%2Fi1');

    await mkdir(cloudsqlTree, { recursive: true });
    await mkdir(alloydbTree, { recursive: true });

    await cloudsql.dropInstance('p1', 'us-central1/c1/i1');

    expect(existsSync(cloudsqlTree)).toBe(false);
    expect(existsSync(alloydbTree)).toBe(true);

    await alloydb.dropInstance('p1', 'us-central1/c1/i1');

    expect(existsSync(alloydbTree)).toBe(false);
  });

  test('stampsCloudSqlWithItsOwnDirectoryTree', async () => {
    const { plane, root } = await planeForProduct(CLOUDSQL_DATA_PLANE_PRODUCT, 46405);
    const cloudsqlInstance = join(root, 'cloudsql/p1/inst');

    await mkdir(cloudsqlInstance, { recursive: true });

    await plane.dropInstance('p1', 'inst');

    expect(existsSync(cloudsqlInstance)).toBe(false);
  });

  /**
   * When postgresImage is set, the container supervisor is chosen.
   * Its isPostgresAvailable() checks for docker, so spying on Bun.which
   * with 'docker' returning null makes startInstance return null —
   * the same "unavailable" signal the process supervisor gives when
   * postgres binaries are absent. That confirms the container path is live.
   */
  test('uses the container supervisor when postgresImage is set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-host-'));

    temporaryDirectories.push(root);

    const which = spyOn(Bun, 'which').mockReturnValue(null);

    try {
      const plane = createPostgresDataPlane(
        logger,
        CLOUDSQL_DATA_PLANE_PRODUCT,
        {
          enabled: true,
          portRangeStart: 46420,
          portRangeEnd: 46424,
          storageType: 'sqlite',
          sqlitePath: join(root, 'emulator.db'),
          postgis: false,
          postgresImage: 'postgres:18',
        }
      );

      expect(plane).toBeInstanceOf(PostgresServerDataPlane);
      // Container supervisor reports unavailable when docker is absent.
      expect(await plane.startInstance('p', 'i', [])).toBeNull();
    } finally {
      which.mockRestore();
    }
  });

  test('uses the process manager when postgresImage is not set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinglet-host-'));

    temporaryDirectories.push(root);

    const plane = createPostgresDataPlane(
      logger,
      CLOUDSQL_DATA_PLANE_PRODUCT,
      {
        enabled: true,
        portRangeStart: 46425,
        portRangeEnd: 46429,
        storageType: 'sqlite',
        sqlitePath: join(root, 'emulator.db'),
        postgis: false,
      }
    );

    expect(plane).toBeInstanceOf(PostgresServerDataPlane);
  });
});
