import { PostgresProcessManager } from '@/shared/postgres-data-plane/postgres-process-manager.ts';
import { Logger } from '@/shared/utils/logger.ts';

const available = new PostgresProcessManager(
  new Logger('postgres-availability')
).isPostgresAvailable();

if (!available && process.env.CI) {
  throw new Error(
    'Postgres binaries are missing but CI=true. Install PostgreSQL in the workflow; ' +
      'otherwise real Postgres data-plane tests would silently skip.'
  );
}

export const isRealPostgresAvailable = available;
