/**
 * Tests for createPostgresDataPlane product wiring
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@/shared/utils/logger.ts';
import { DataPlaneManager, DisabledDataPlane } from './data-plane-manager.ts';
import {
  ALLOYDB_DATA_PLANE_PRODUCT,
  CLOUDSQL_DATA_PLANE_PRODUCT,
  createPostgresDataPlane,
  type PostgresDataPlaneProduct,
} from './host.ts';

const logger = new Logger('PostgresDataPlaneHostTest', 'error');
const anyUser = async () => ({ password: '' });

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

  const plane = createPostgresDataPlane(
    logger,
    product,
    {
      enabled: true,
      portRangeStart,
      portRangeEnd: portRangeStart + 4,
      storageType: 'sqlite',
      sqlitePath: join(root, 'emulator.db'),
      postgis: false,
    },
    anyUser
  );

  return { plane, root };
}

describe('createPostgresDataPlane', () => {
  test('returnsDisabledDataPlaneWhenNotEnabled', () => {
    const plane = createPostgresDataPlane(
      logger,
      CLOUDSQL_DATA_PLANE_PRODUCT,
      {
        enabled: false,
        portRangeStart: 46390,
        portRangeEnd: 46394,
        storageType: 'memory',
        sqlitePath: './data/emulator.db',
        postgis: false,
      },
      anyUser
    );

    expect(plane).toBeInstanceOf(DisabledDataPlane);
  });

  test('returnsAManagerStampedWithTheAlloyDbProduct', async () => {
    const { plane } = await planeForProduct(ALLOYDB_DATA_PLANE_PRODUCT, 46395);

    expect(plane).toBeInstanceOf(DataPlaneManager);
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

  test('stampsCloudSqlWithItsOwnDirectoryTree', async () => {
    const { plane, root } = await planeForProduct(CLOUDSQL_DATA_PLANE_PRODUCT, 46405);
    const cloudsqlInstance = join(root, 'cloudsql/p1/inst');

    await mkdir(cloudsqlInstance, { recursive: true });

    await plane.dropInstance('p1', 'inst');

    expect(existsSync(cloudsqlInstance)).toBe(false);
  });
});
