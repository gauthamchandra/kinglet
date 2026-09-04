# ADR-013: Cloud SQL Data Plane on PGlite

## Status

Accepted

## Context

Cloud SQL shipped as a control plane only: `DatabaseInstance`, `Database`,
`User` and `Operation` are rows in `StorageManager`, and `ipAddresses`
advertises `127.0.0.1` with nothing listening on it. A developer could create
an instance but never connect to one, which is most of the point of running
Cloud SQL locally.

This is the same gap ADR-007 closed for Memorystore, and the same reasoning
applies: `DatabaseInstance.ipAddresses[].ipAddress` is a real endpoint in
production, and the emulator has to make that true locally. The difference is
what sits behind the endpoint. Memorystore could spawn a real `valkey-server`
because Debian packages one; Postgres is a heavier proposition — a server
binary, a data directory to `initdb`, a `postgres` user, and a package that
does not install without root.

ADR-003 rejected bundling an external database as the **emulator's own**
persistence backend. As with ADR-007, this ADR carves out the same narrow
exception in the other direction: Postgres here is the **emulated product's
data plane** — the thing Cloud SQL wraps — not a replacement for
`StorageManager`. Cloud SQL's own metadata still lives in `StorageManager`
exactly as ADR-003 describes.

## Decision

- Back the data plane with **PGlite** (`@electric-sql/pglite`), a WASM build of
  Postgres 18 that runs in-process under Bun. No server binary, no `initdb`, no
  root, no separate process to supervise.
- **One PGlite instance per `Database` resource.** PGlite has no
  `CREATE DATABASE` — one PGlite is one database — so the admin API's
  `Database` list is the unit of mapping.
- **One TCP port per `DatabaseInstance`**, allocated sequentially from 5432, so
  the common single-instance case is reachable at plain `localhost:5432`.
  A hand-rolled Postgres wire-protocol front end
  (`postgres-wire-server.ts`) accepts connections on that port and routes each
  one to a database by the `database` parameter of its startup message.
- **The API response stays byte-faithful.** sqladmin has nowhere to report a
  kinglet-only port, so nothing is added to the response; the port is logged at
  create time and exposed in-process via `CloudSqlService.getDataPlanePort()`.
- **Authentication is enforced.** The connecting user must exist on the
  instance; if its row carries a non-empty password the client must supply it
  via cleartext password authentication. Users are read live from the
  repository, so a `users.update` takes effect on the next connection.
- **Persistence follows kinglet's own storage mode.** `STORAGE_TYPE=memory`
  gives `memory://` PGlite instances; otherwise each database gets a directory
  beside kinglet's SQLite file, so deleting that directory really is a reset.
  Under the default `hybrid` storage an instance and its data survive a
  restart: the control-plane rows come back from SQLite and the data plane
  re-opens their PGlite directories. That depends on kinglet's own storage
  actually persisting, which it did not until the storage fix in this same
  change — every storage type had been running in-memory.
- **Extensions are fixed at build time.** PGlite links each extension's wasm
  when the database is created, so every database is built with all 26 contrib
  extensions PGlite ships plus pgvector and PostGIS. That is what lets
  `CREATE EXTENSION pg_trgm` work later without rebuilding the database under a
  live connection. pgvector and PostGIS are separate packages, peer-pinned to
  the same PGlite version, so all three move together.
- The data plane is **on by default**, for ADR-007's reason: an instance a
  client cannot connect to is metadata, not emulation. `CLOUDSQL_DATA_PLANE=false`
  turns it off. Unlike Memorystore there is no external binary to be missing, so
  the default cannot fail on a host that simply lacks Postgres.
- **Start eagerly**, at `instances.create`, so the endpoint is live before the
  DONE operation is returned. If the data plane fails to start, the
  control-plane rows are deleted and the create fails: an instance whose rows
  exist but whose endpoint never came up would advertise an address nothing
  answers on, and no later call would retry the start.
- On restart, re-open every persisted instance and its databases, since the
  listeners did not survive even though the rows did.

## Rationale

- PGlite is a real Postgres (18.3), not a reimplementation, so the emulated
  data plane inherits actual Postgres semantics — transactions, extended query
  protocol, `COPY`, types, planner behavior — rather than approximating them.
- It is a plain npm dependency (~25 MB unpacked, wasm loaded from
  `node_modules` at runtime). The Dockerfile runs from source rather than
  `bun build --compile`, so the known `$bunfs` bundling issue does not apply,
  and no `postinstall` step is needed — a contrast with Valkey, which needs a
  system package manager and root.
- Bun is a supported PGlite runtime, and `Bun.SQL` is a built-in Postgres
  client, so exercising the data plane end-to-end needs no new dependency.
- Sequential allocation from 5432 (rather than Memorystore's hash-derived port)
  is what makes the single-instance case land on the port every Postgres client
  and connection string already defaults to.

## Alternatives Considered

### Spawn a real `postgres` server per instance

Mirror ADR-007 exactly: `apt-get install postgresql`, `initdb` a cluster per
instance, `Bun.spawn` a server.

**Pros**: The most faithful option; full Postgres including SSL, SCRAM, and
`CREATE DATABASE`.
**Cons**: Postgres refuses to run as root, so the image would need a dedicated
user and ownership juggling; each instance needs an `initdb`'d data directory
(slow, and hundreds of MB across several instances); the package is an order of
magnitude larger than Valkey's; and supervising N server processes brings back
the orphaned-process problem ADR-007 already has to work around. PGlite gets
most of the fidelity for none of that.

### `@electric-sql/pglite-socket`

Use the published socket server rather than writing wire-protocol code.

**Pros**: Maintained by the PGlite authors; already solves connection
multiplexing over a single backend.
**Cons**: It serves exactly one PGlite on one port, with no hook for
authentication and no way to route by database name — the two things this data
plane exists to do. Its `QueryQueueManager` is private and unexported, so the
multiplexing cannot be reused around those hooks either. Its ~100-line
approach (`runExclusive` + `execProtocolRawStream`, with transaction affinity
from `isInTransaction()`) is reimplemented in-repo instead, in
`pglite-session-queue.ts`.

### `pg-gateway`

A Postgres protocol front end with authentication hooks.

**Pros**: Would supply the startup/auth handling.
**Cons**: Pre-1.0, and has no multiplexer — the queueing work would still have
to be written. That is a dependency for roughly 150 lines of protocol code that
is fully covered by tests here.

### Metadata-only (no data plane)

Leave Cloud SQL control-plane-only.

**Pros**: Zero new dependency or risk.
**Cons**: Same as ADR-007's version of this argument — the control plane alone
answers "does my Terraform work?" but not "does my application code work?".

## Consequences

### Positive

- Application code, `psql`, and Terraform's Postgres provider can connect to an
  emulated instance and use it as a real Postgres.
- No binary, no root, no `postinstall`, no supervised child processes; the data
  plane starts and stops with the emulator process.
- Everything under `src/services/cloudsql/data-plane/` is deliberately
  Cloud-SQL-agnostic so AlloyDB can reuse it unchanged.

### Negative

- +~25 MB of `node_modules` and a wasm Postgres boot (~0.7 s) per database.
- A new port range (5432-5531 by default) must be published by anyone running
  the emulator in Docker, or the advertised endpoint is unreachable from
  outside the container.
- The listener binds every interface (as ADR-007's does, and for the same
  reason: the container's loopback is unreachable through a published port
  mapping), so the range must only be exposed on a trusted machine — the more
  so because the password exchange is cleartext.
- Connections to one database are serialised: PGlite is a single backend, so
  two clients cannot execute concurrently against the same database, and one
  holding a transaction open blocks the others until it commits.

## Known Limitations

- **No SSL.** `SSLRequest` is refused, so clients must use `sslmode=disable`
  (or `tls: false`). `settings.ipConfiguration.requireSsl` is metadata only.
- **Cleartext password authentication only.** SCRAM and MD5 both need a stored
  verifier, and the admin API stores whatever password the caller supplied.
- **Databases must be created through the admin API**, not `CREATE DATABASE` —
  one PGlite is one database, and PGlite has no `CREATE DATABASE`.
- **The engine is Postgres 18 whatever `databaseVersion` says.** A
  `POSTGRES_14` instance still answers `SELECT version()` with 18.
- **Extensions cost boot time.** All 26 contrib extensions PGlite ships are
  available, plus pgvector and PostGIS. PostGIS is the expensive one: ~19 MB of
  wasm, and it takes a database's boot from roughly 0.7 s to 1.3 s. That is
  paid per database, since one PGlite is one database.
- `settings.ipConfiguration` and `authorizedNetworks` are metadata only —
  nothing restricts who may connect beyond user and password.
- `User.type` values other than `BUILT_IN` behave like `BUILT_IN`.
- **Connections to one database share a Postgres session.** One PGlite is one
  backend, so there is one session behind every connection to a database.
  Prepared statements and portals are namespaced per connection on the way
  through (see `extended-protocol.ts`), and a connection's extended-query
  sequence reaches the backend as one unit, so ordinary pooled clients work.
  What cannot be separated is the rest of the session: `SET`, `search_path`,
  temporary tables, sequence `currval`, and advisory locks are visible to every
  connection to that database. Code that relies on session isolation between
  connections will not behave as it does against a real instance.
- **Emulated users gate the connection but are not Postgres roles.** A `User`
  created through the admin API decides whether a connection is accepted, and
  its password is checked, but the session behind it runs as PGlite's own
  `postgres` superuser. `current_user` and `session_user` therefore always
  report `postgres`, only `postgres` appears in `pg_roles`, and per-user
  `GRANT`s have nothing to apply to. Code that authenticates as a specific user
  works; code that depends on per-user privileges does not.
- Query cancellation is not supported: a `CancelRequest` is accepted and
  dropped, because there is no way to interrupt a running call into the single
  wasm backend.

## Implementation Notes

- `src/services/cloudsql/data-plane/` holds the whole thing:
  `data-plane-manager.ts` (the facade the admin service talks to, plus a
  `DisabledDataPlane`), `postgres-wire-server.ts` (one listener per instance),
  `pglite-database-manager.ts` (PGlite lifecycle and data directories),
  `pglite-session-queue.ts` (per-database serialisation and transaction
  affinity), `port-allocator.ts`, and `extensions.ts`.
- `@electric-sql/pglite` and `@electric-sql/pglite-pgvector` are pinned to
  exact versions: pgvector 0.0.9 peer-pins PGlite to exactly 0.5.8, so the two
  have to move together.
- `CloudSqlService.stop()` closes every PGlite and stops every listener as part
  of the emulator's normal shutdown.
