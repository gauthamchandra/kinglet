# ADR-003: Hybrid Storage Architecture

## Status

Accepted

## Context

The LocalStack GCP Emulator needs a storage layer that serves two different usage
patterns:

1. **Local development** — developers run the emulator for hours or days and
   expect state (queues, jobs, tasks) to survive container restarts.
2. **CI / ephemeral testing** — tests spin up the emulator, run assertions, and
   tear it down. Persistence is unnecessary and in-memory speed is preferred.

A single storage strategy cannot satisfy both. We also want to avoid requiring
external infrastructure (Redis, Postgres) since the emulator should start with a
single `docker run` command.

## Decision

We will support three storage modes, selectable via the `STORAGE_TYPE`
environment variable:

- **`memory`** — Pure in-memory storage. Fast, no disk I/O, data lost on
  shutdown. Ideal for CI pipelines and short-lived test runs.
- **`sqlite`** — Persistent storage using Bun's built-in `bun:sqlite` module.
  Data written to a SQLite database file at `SQLITE_PATH`
  (default: `./data/emulator.db`).
- **`hybrid`** (default) — An LRU memory cache backed by SQLite. Reads are
  served from cache when available; writes go to both cache and disk. Combines
  fast reads with persistence.

All three modes implement a common `StorageProvider` interface so that service
code is storage-agnostic.

## Rationale

### Why SQLite over other embedded databases

- Bun ships with a native SQLite binding (`bun:sqlite`) that is approximately 3x
  faster than Node.js SQLite alternatives like `better-sqlite3`.
- SQLite is battle-tested, single-file, and requires zero configuration.
- No external process or network dependency — the emulator remains self-contained.

### Why a hybrid default

- Most developers want persistence without thinking about it.
- The LRU cache eliminates repeated disk reads for hot data (e.g., queue
  metadata that is read on every task dispatch).
- The cache size is configurable via `CACHE_SIZE` (default: 100 MB).

### Why memory mode exists

- Integration tests benefit from isolation — each test run starts from a clean
  state without needing to truncate tables.
- Memory mode avoids SQLite file locking issues when running many parallel test
  processes.

## Alternatives Considered

### Single SQLite mode only

**Pros**: Simplest implementation, always persistent.
**Cons**: Slower for CI workloads, no way to opt into ephemeral behavior without
deleting the database file manually.

### External database (Redis, Postgres)

**Pros**: Production-grade, supports clustering.
**Cons**: Adds infrastructure requirements, contradicts the "single `docker run`"
goal, overkill for a local emulator.

## Consequences

### Positive

- Developers get persistence by default with no extra configuration
- CI pipelines can use `STORAGE_TYPE=memory` for faster, isolated test runs
- Data survives container restarts when the `/app/data` directory is
  volume-mounted
- Service code uses the same interface regardless of storage mode

### Negative

- Three code paths to test and maintain
- Hybrid mode has slightly more complexity than either pure mode
- SQLite file must be volume-mounted for Docker persistence (not automatic)

## Implementation Notes

- `StorageManager` in `src/core/storage/manager.ts` handles provider selection
  and initialization
- Each service stores data in its own SQLite tables via the shared manager
- Transaction support with rollback is available on the SQLite and hybrid
  providers

## References

- [Bun SQLite Documentation](https://bun.sh/docs/api/sqlite)
- [ADR-001: Bun Runtime Choice](001-bun-runtime-choice.md)
