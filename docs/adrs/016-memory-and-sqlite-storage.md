# ADR-016: Memory and SQLite Storage Modes

## Status

Accepted

## Context

[ADR-003](003-hybrid-storage-architecture.md) introduced three storage modes —
`memory`, `sqlite`, and `hybrid` (an LRU cache in front of SQLite) — with
`hybrid` as the default. The useful product split was always ephemeral vs
durable: CI wants a clean slate; local development wants state across restarts.

`hybrid` never earned that third mode. On main it behaved identically to
`sqlite` for a long time (the cache was never attached). Wiring the cache added
correctness surface — invalidation across transactions, write-shape drift,
rollback cleanup — without a measured hotspot that bun:sqlite and the OS page
cache were not already serving. Emulator control-plane CRUD is not a
high-QPS cache problem.

## Decision

Support exactly two storage modes via `STORAGE_TYPE`:

- **`memory`** — Pure in-memory storage. Fast, ephemeral. Prefer for CI and
  short-lived tests.
- **`sqlite`** (default) — Persistent storage via Bun's `bun:sqlite` at
  `SQLITE_PATH` (default `./data/emulator.db`). Prefer for local development.

Remove `hybrid` and the user-facing `CACHE_SIZE` setting. Existing deployments
that set `STORAGE_TYPE=hybrid` must switch to `sqlite` (behavior was already
sqlite-equivalent for durability).

## Rationale

- Persistence and ephemerality are the only modes users need to choose.
- bun:sqlite is fast enough for kinglet workloads without an app-level LRU.
- Fewer modes means fewer code paths, fewer consistency bugs, and clearer docs.
- Defaulting to `sqlite` keeps the previous default's durability promise
  (hybrid was durable SQLite underneath).

## Alternatives Considered

### Keep hybrid, finish wiring the cache

**Pros**: Honors ADR-003 as written.
**Cons**: Ongoing correctness cost for an unproven win; the mode was already a
lie for most of its life.

### Default to memory

**Pros**: Fastest local startup, no leftover DB files.
**Cons**: Breaks the expectation that local state survives a restart unless
you opt into sqlite; sqlite was what hybrid already provided.

## Consequences

### Positive

- One durable path (`sqlite`) and one ephemeral path (`memory`)
- Config and docs match what the code actually does
- No more dead `CACHE_SIZE` / hybrid knobs

### Negative

- `STORAGE_TYPE=hybrid` becomes invalid; callers must migrate to `sqlite`
- App-level LRU helpers in the storage layer remain as unused internals until
  a follow-up cleanup

## References

- [ADR-003: Hybrid Storage Architecture](003-hybrid-storage-architecture.md) (superseded)
- [Storage modes](../reference/storage.md)
