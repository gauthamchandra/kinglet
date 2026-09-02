/**
 * The fixed extension set every emulated Cloud SQL database is built with.
 *
 * <p>Cloud SQL lets a user `CREATE EXTENSION` any name on its supported list
 * at any time, but PGlite has to be handed its extensions at build time — the
 * wasm bundle for each one is linked when the database is created. Loading the
 * whole set up front is what makes `CREATE EXTENSION pg_trgm` work later
 * without the emulator having to rebuild the database underneath a live
 * connection.
 *
 * <p>This is every contrib extension `@electric-sql/pglite` ships plus
 * pgvector, which is a separate package because of its size. PostGIS is the
 * notable omission: it is a third-party build that is not wired up here yet.
 *
 * <p>Nothing in this module is Cloud-SQL-specific, so AlloyDB can reuse it.
 */

import { amcheck } from '@electric-sql/pglite/contrib/amcheck';
import { auto_explain } from '@electric-sql/pglite/contrib/auto_explain';
import { bloom } from '@electric-sql/pglite/contrib/bloom';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { cube } from '@electric-sql/pglite/contrib/cube';
import { dict_int } from '@electric-sql/pglite/contrib/dict_int';
import { dict_xsyn } from '@electric-sql/pglite/contrib/dict_xsyn';
import { earthdistance } from '@electric-sql/pglite/contrib/earthdistance';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { hstore } from '@electric-sql/pglite/contrib/hstore';
import { intarray } from '@electric-sql/pglite/contrib/intarray';
import { isn } from '@electric-sql/pglite/contrib/isn';
import { lo } from '@electric-sql/pglite/contrib/lo';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { moddatetime } from '@electric-sql/pglite/contrib/moddatetime';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { seg } from '@electric-sql/pglite/contrib/seg';
import { tablefunc } from '@electric-sql/pglite/contrib/tablefunc';
import { tcn } from '@electric-sql/pglite/contrib/tcn';
import { tsm_system_rows } from '@electric-sql/pglite/contrib/tsm_system_rows';
import { tsm_system_time } from '@electric-sql/pglite/contrib/tsm_system_time';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { vector } from '@electric-sql/pglite-pgvector';

export const DATA_PLANE_EXTENSIONS = {
  amcheck,
  auto_explain,
  bloom,
  btree_gin,
  btree_gist,
  citext,
  cube,
  dict_int,
  dict_xsyn,
  earthdistance,
  fuzzystrmatch,
  hstore,
  intarray,
  isn,
  lo,
  ltree,
  moddatetime,
  pg_trgm,
  pgcrypto,
  seg,
  tablefunc,
  tcn,
  tsm_system_rows,
  tsm_system_time,
  unaccent,
  uuid_ossp,
  vector,
} as const;
