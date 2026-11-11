# ADR-019: Real Postgres Data Plane

## Status

Accepted

## Context

ADR-013 backed Cloud SQL and AlloyDB with PGlite, a WASM Postgres behind a
hand-written wire server. That was the right call when the alternative was
supervising a server binary the image did not ship. It is no longer enough.

PGlite is one single-threaded backend per database. Transactions on one
database serialize. `now()` is millisecond precision. The wire server has no
COPY sub-protocol, and that same protocol code is where the COPY and duplicate
ReadyForQuery bugs come from. `pg_partman` and `pg_stat_statements` are not
available. Users created through the admin API are not Postgres roles: the
session runs as PGlite's `postgres` superuser.

Fixing the wire protocol would not fix concurrency, and concurrency is the
part application code actually depends on.

## Decision

- One real Postgres server per emulated instance, behind the existing
  `PostgresDataPlane` interface. Clients connect to that server directly.
  Kinglet does not sit in the protocol path.
- `pg_hba` allows `trust` only for `kinglet_admin` on the instance's private
  Unix socket. TCP uses `scram-sha-256`. Kinglet issues DDL that mirrors the
  Google control plane, and nothing more. `CREATE/ALTER ROLE ... PASSWORD`
  does not accept a parameter through Bun.SQL, so the password is inlined
  with standard literal quoting and that statement is never logged.
- `google_sql_*` and `google_alloydb_*` Terraform resources produce that DDL
  by calling the admin API. A `postgresql` provider resource connects as a
  normal user of the instance, the same way it would against Cloud SQL.
- The default runtime installs PostgreSQL 18 from the PGDG apt repository
  into the kinglet image, the same way the image already installs
  `valkey-server`. Kinglet finds `postgres` and `initdb` and supervises one
  child process per data directory. This is not a from-source build, and it
  is not a nested container. `initdb` runs once into a template; each new
  instance is a copy of that template plus a postmaster start.
- A nested Postgres container (one container per instance, talking to the
  Docker engine over its socket) is a later opt-in for a caller who names an
  image. It is not the way startup gets faster. Starting a container pays for
  the engine call and the image entrypoint on top of Postgres itself, and the
  official `postgres:18-alpine` image has neither `pg_partman` nor PostGIS.
- `CLOUDSQL_DATA_PLANE=false` and `ALLOYDB_DATA_PLANE=false` stay
  metadata-only. When the binaries are missing, an instance still comes up
  with a null port and Kinglet logs one warning per process, matching
  Memorystore.

## Rationale

A real postmaster is the only way to get concurrent transactions, COPY, a
microsecond `now()`, and the extensions Cloud SQL users already run. Shipping
the binaries in the kinglet image keeps a single `docker run`: no Docker
socket, no second image to pull, no daemon the host has to provide. The
socket mount that a nested container needs is root-equivalent control of the
host's Docker daemon, so it cannot be the default.

The `PostgresDataPlane` interface stays put so AlloyDB can move onto the same
servers later without a second design, and so `*_DATA_PLANE=false` keeps
working.

## Alternatives Considered

### Keep PGlite and fix the protocol layer

**Pros**: No new system dependency, no child processes.
**Cons**: Concurrency is impossible in single-threaded WASM. The protocol
bugs are a consequence of that architecture, not the whole of it.

### A mode switch between PGlite and real Postgres

**Pros**: A host without Postgres binaries could keep today's behavior.
**Cons**: The contract would depend on which engine happened to be running.
Two implementations of sessions, roles, and `now()` is how the wire-server
bugs survive.

### Nested containers as the default

**Pros**: The official image's entrypoint owns `initdb`, users, and
`pg_hba`. Swapping a tag swaps the server.
**Cons**: Slower start than a binary that is already on disk, a Docker
socket that grants control of the host daemon, and the alpine image is
missing the extensions the data plane is supposed to grow. Kept as a later
opt-in, not the default.

## Consequences

### Positive

- Sessions, roles, advisory locks, and COPY behave as they do on Postgres.
- After the template exists, creating an instance is a directory copy and a
  postmaster start. The numbers that motivated this, measured on PG14, were
  about 0.43 s for `initdb`, 0.11 s to start, and 0.04 s to copy the template.
- Authentication is SCRAM over TCP. The cleartext password exchange in the
  PGlite wire server goes away for any product that has moved.

### Negative

- The Postgres binaries are a dependency of the data plane. The image grows
  when the packages land; that size change is recorded with the Dockerfile
  change, not here.
- Each port range holds up to 100 instances, and each instance is a real
  postmaster (on the order of 30 MB RSS) and about 42 MB of disk.
- An empty admin-API password cannot mean "connect with no challenge" under
  scram-only TCP the way the PGlite wire server treated it.
- Both Cloud SQL and AlloyDB instances are real Postgres servers. The image
  installs `postgresql-18`, PostGIS, pgvector, and `pg_partman` from PGDG,
  so a stock `docker run` has a `postgres` binary. Nested containers are not
  that install. The install uses `--no-install-recommends`, about 420 MiB
  uncompressed. `setpriv` is already in the slim base through `util-linux`.

## Follow-ups

Not built here:

- Optional per-instance container mode, off unless an image is configured.
- `databaseFlags` applied to `postgresql.conf` / `ALTER SYSTEM`.
- AlloyDB read pools as streaming replicas. Each READ_POOL instance is
  presently its own independent Postgres server, not a streaming replica.
- Remove the PGlite data plane once nothing calls it.
