# ADR-010: SQLite Schema Synchronization

## Status

Accepted

## Context

Kinglet services evolve their persisted record shapes as API fidelity improves. The
SQLite provider creates tables with `CREATE TABLE IF NOT EXISTS`, which leaves
existing on-disk databases on older schemas when new nullable columns are added or
when a previously required column must accept `NULL` (for example, Cloud Scheduler
jobs that target Pub/Sub instead of HTTP).

Without a migration step, hybrid and sqlite deployments fail at runtime when code
writes fields that the existing table never received. Requiring every developer to
delete `./data/emulator.db` on each schema change is brittle and breaks the
persistence story described in ADR-003.

## Decision

The SQLite provider will synchronize declared `TableSchema` metadata on every
`createTable` call:

1. **Add missing columns** with `ALTER TABLE ... ADD COLUMN` when the table already
   exists but the schema declares a new field.
2. **Rebuild the table** when an existing column must become nullable. SQLite cannot
   relax `NOT NULL` in place, so the provider copies rows into a replacement table
   and swaps names.

Memory and hybrid cache layers continue to use the same schema declarations; only
the SQLite backing store performs the migration work.

## Rationale

- Keeps service repositories storage-agnostic — they declare the desired schema
  once and do not embed migration version numbers.
- Matches how kinglet is used locally: long-lived `./data/emulator.db` files should
  survive minor additive schema changes without manual intervention.
- Table rebuilds are rare (only when nullability changes) and acceptable for local
  emulator databases with modest row counts.

## Alternatives Considered

- **Manual migration scripts / version table** — accurate for production databases
  but heavy for a local emulator where schema churn is frequent and data loss on
  rebuild is acceptable.
- **Require deleting the database file** — simple but poor developer experience and
  easy to miss in release notes.
- **Disable persistence for scheduler schema changes** — would hide the problem
  instead of fixing sqlite/hybrid deployments.

## Consequences

- Existing sqlite/hybrid databases pick up new nullable columns automatically.
- Relaxing `NOT NULL` triggers a table rebuild; callers should treat that as a
  lightweight local migration, not a live zero-downtime production operation.
- Services must keep `TableSchema` declarations authoritative; drift between code
  and schema metadata becomes a bug rather than a silent runtime failure.
