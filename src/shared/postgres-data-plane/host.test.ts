/**
 * Tests for createPostgresDataPlane product wiring
 */

import { describe, expect, test } from 'bun:test';
import { Logger } from '@/shared/utils/logger.ts';
import { DataPlaneManager, DisabledDataPlane } from './data-plane-manager.ts';
import {
  ALLOYDB_DATA_PLANE_PRODUCT,
  CLOUDSQL_DATA_PLANE_PRODUCT,
  createPostgresDataPlane,
} from './host.ts';

const logger = new Logger('PostgresDataPlaneHostTest', 'error');
const anyUser = async () => ({ password: '' });

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

  test('returnsAManagerStampedWithTheAlloyDbProduct', () => {
    const plane = createPostgresDataPlane(
      logger,
      ALLOYDB_DATA_PLANE_PRODUCT,
      {
        enabled: true,
        portRangeStart: 46395,
        portRangeEnd: 46399,
        storageType: 'memory',
        sqlitePath: './data/emulator.db',
        postgis: false,
      },
      anyUser
    );

    expect(plane).toBeInstanceOf(DataPlaneManager);
  });
});
