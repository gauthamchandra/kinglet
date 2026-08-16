# ADR-007: Memorystore for Valkey Data Plane

## Status

Accepted

## Context

Every service emulated so far (Pub/Sub, Cloud Tasks, Cloud Scheduler,
Workflows) has only a REST control plane: application code calls the GCP API
to create/describe/delete resources, and the emulator's own storage layer
(ADR-003) is the only thing that needs to persist state.

Memorystore for Valkey is different. A GCP `Instance` exists so that
application code can open a Valkey/RESP connection to it and run real
commands (`SET`, `GET`, `EXPIRE`, ...). Emulating only the control plane would
let a developer *create* an instance but never *use* one, which is most of
the value of running Memorystore locally in the first place. `Instance.discoveryEndpoints[].address:port`
is a real network endpoint in production, and the emulator has to make that
true locally too.

ADR-003 explicitly rejected bundling an external database (Redis, Postgres)
as a persistence backend for the emulator itself, reasoning that it
contradicts the single-`docker run` goal. This ADR carves out a narrow
exception: `valkey-server` is bundled as the **emulated product's own data
plane** — the thing GCP's Memorystore for Valkey wraps — not as a
replacement for the emulator's `StorageManager`. The emulator's own state
(instance metadata, ACL policies, operations, ...) still lives in
`StorageManager` exactly as ADR-003 describes. The single-`docker run`
property is preserved: `valkey-server` ships inside the same image and
starts automatically when the data plane is enabled.

## Decision

- Spawn real `valkey-server` child processes via `Bun.spawn`, one standalone
  process per `Instance`, regardless of the instance's requested
  `shardCount`/`replicaCount` (those fields are echoed back in metadata but
  do not change topology — sharded/replicated Valkey is out of scope).
- The data plane is **on by default**, because an instance a client cannot
  connect to is metadata rather than emulation. Setting
  `MEMORYSTORE_DATA_PLANE=false` (or `services.memorystore.dataPlane.enabled`
  in config) turns it off. With
  it off, `Instance.discoveryEndpoints` still returns a deterministic
  loopback address + derived port so the response shape is identical either
  way — only whether the port is actually reachable differs.
- Spawn eagerly, at `instances.create` time, so the endpoint is already live
  by the time the LRO is reported `done: true` (mirroring the rest of the
  emulator's LRO semantics — see Workflows).
- `valkey-server` is resolved via `Bun.which()`, honoring an explicit
  `binaryPath` override (`MEMORYSTORE_VALKEY_BINARY`). If the data plane is
  enabled but the binary is not found, log the degradation once and fall
  back to metadata-only endpoints rather than failing instance creation —
  a missing binary should degrade gracefully, not break the control plane.
- On restart, re-spawn a process for every persisted `ACTIVE` instance and
  rewrite its `discoveryEndpoints` with the freshly allocated port, since the
  previous process did not survive the restart even though the instance row
  did (under `hybrid`/`sqlite` storage).

## Rationale

- `oven/bun:1.3.4-slim` is Debian trixie, which carries `valkey-server 8.1.1`
  in its main repository — a plain `apt-get install --no-install-recommends
  valkey-server` pulls it in at ~8.7 MB across 6 packages, no third-party
  repository needed.
- `valkey-server 8.1.1` reports `redis_version:7.2.4` compatibility, which
  aligns with GCP's `VALKEY_7_2` engine version — a real, protocol-compatible
  server rather than a hand-rolled RESP command emulator.
- `Bun.RedisClient` is built into Bun 1.3.4, so exercising the data plane
  end-to-end (`PING`/`SET`/`GET`) needs no new runtime dependency.

## Alternatives Considered

### Docker-in-Docker

Spin up a `valkey` container per Instance from inside the emulator
container.

**Pros**: Full isolation per instance; matches how a real k8s-based
Memorystore control plane might work.
**Cons**: Requires the Docker socket mounted into the emulator container (a
significant, surprising security/operational ask for a *local* dev tool),
adds an orchestration layer the emulator doesn't otherwise need, and breaks
the single-`docker run` / single-process story the rest of the emulator
follows.

### SQLite-backed RESP command emulation

Implement the Valkey/RESP wire protocol ourselves, backed by
`StorageManager`, the same way the rest of the emulator emulates GCP REST
APIs.

**Pros**: No new binary dependency; stays entirely within the existing
storage abstraction.
**Cons**: Valkey's command surface (data types, expirations, `MULTI`/`EXEC`,
pub/sub, scripting, ...) is enormous, and a partial reimplementation would
silently diverge from real Valkey behavior in ways that are hard to predict
and easy for application code to trip over. A real `valkey-server` binary is
strictly more faithful for a fraction of the effort.

### Metadata-only (no data plane)

Keep Memorystore control-plane-only, like every other emulated service.

**Pros**: Zero new risk, zero image size cost, matches the existing pattern
exactly.
**Cons**: An emulator a developer cannot actually connect to defeats most of
the point of emulating Memorystore locally — the control plane alone answers
"does my Terraform/deploy script work?" but not "does my application code
work?". This is why the data plane ships on by default rather than being
skipped outright.

## Consequences

### Positive

- Application code can point at the emulator's `discoveryEndpoints` and get
  a real, protocol-compatible Valkey connection.
- Enabling the Memorystore service gives a connectable instance with no extra
  configuration; `MEMORYSTORE_DATA_PLANE=false` restores the metadata-only
  control plane for developers who only need the API surface.
- Graceful degradation (missing binary → metadata-only + one warning) means
  a misconfigured environment never blocks the control plane.

### Negative

- +8.7 MB to the final image, plus an `apt-get` dependency in the
  Dockerfile that must track Debian's `valkey-server` package.
- A new port range (6380-6479 by default) must be published by anyone
  running the emulator in Docker, unless the data plane is disabled, or the
  advertised endpoints will be unreachable from outside the container.
- One standalone `valkey-server` per Instance regardless of `shardCount`/
  `replicaCount` — sharded/replicated topology, cluster-mode Valkey, and
  TLS/`transitEncryptionMode` are metadata-only and do not reflect real
  cluster behavior.
- Each spawned server listens on every interface with protected mode
  disabled, because binding the container's loopback would make the
  published port range unreachable from the host — the one place the data
  plane exists to serve. Combined with `AUTH_DISABLED`, that leaves the data
  plane unauthenticated on whatever interfaces the operator publishes, so
  the port range must only be exposed on a trusted local/CI machine.
- Orphaned processes are possible if the emulator is killed ungracefully
  (`SIGKILL`); port allocation therefore probes for an actually-free port
  rather than trusting in-memory bookkeeping alone.

## Known Limitations

- Token-auth (`TokenAuthUser`/`AuthToken`) and the instance `authorizationMode`
  field are modeled as control-plane metadata for API fidelity only, not as
  real authentication. The CRUD works and rows persist, but nothing is wired
  into the spawned `valkey-server` — the process runs with no `requirepass`, no
  ACL/`--user`, and `--protected-mode no`, and there is no kinglet-side proxy
  that could enforce a token. So a client connects to `discoveryEndpoints`
  fully unauthenticated regardless of any tokens created or the value of
  `authorizationMode` (which defaults to `AUTH_DISABLED`). Enforcing token-auth
  on the data plane is deferred.
- The connection endpoint is advertised on the **deprecated**
  `Instance.discoveryEndpoints` field, not the modern one. In the v1 discovery
  document both `discoveryEndpoints` and `pscAutoConnections` are marked
  deprecated; discovery is meant to move to
  `endpoints[].connections[].pscConnection`/`pscAutoConnection` with
  `connectionType: CONNECTION_TYPE_DISCOVERY`, where the port lives on
  `PscAutoConnection.port`. That entire path is Private Service Connect —
  `serviceAttachment`/`forwardingRule` URIs, a consumer VPC `network`, and an
  `ipAddress` allocated on it — none of which has a local analog.
  `DiscoveryEndpoint` is the only endpoint shape that is a plain
  `{ address, port }`, so it is the only one that maps cleanly to
  `127.0.0.1:<port>`, and the discovery document itself says
  `discoveryEndpoints` is still populated for non-PSC instances (which a local
  emulator always is). We therefore treat `discoveryEndpoints` as the source of
  truth.
  - So a client that reads the connection **only** from the modern
    `endpoints[].connections[]...` path still resolves a port, the response
    mirrors the same `address:port` onto a minimal
    `endpoints[].connections[].pscAutoConnection` (`ipAddress`, `port`,
    `connectionType: CONNECTION_TYPE_DISCOVERY`) via
    `synthesizeDiscoveryPscEndpoints` in `types.ts`. The rest of the PSC model
    (service attachments, forwarding rules, consumer VPC networks) is still
    unmodeled, and a client-supplied `endpoints` value set via PATCH is left
    untouched rather than overwritten by the mirror.
- On-demand backups (`instances.backup`) accept a `ttl` but do not honor it:
  `expireTime` is always persisted as `null`, so backups are retained
  indefinitely rather than expiring as they would on real Memorystore. Backup
  expiry is not yet modeled.

## Implementation Notes

- `src/services/memorystore/valkey-process-manager.ts` owns spawn, readiness
  polling (TCP connect, bounded timeout), and teardown.
- `MemorystoreService.stop()` calls `stopAllServers()` as part of the
  emulator's normal shutdown sequence.
- `scripts/setup-valkey.ts` runs from `postinstall` so a contributor's `bun
  install` leaves them able to run the data-plane suites. Valkey ships no
  prebuilt binaries, so installing means a system package manager, and on Linux
  that needs root — the hook therefore installs only where it can do so without
  prompting and otherwise just prints the command, rather than escalating
  privileges during a dependency install.
- CI installs `valkey-server` in both the unit-test and E2E jobs. The suites
  that spawn a real server skip themselves when the binary is absent, so
  without that install they would skip on every run and report green while
  covering nothing; `test-utils/valkey.ts` turns a missing binary into a hard
  error whenever `CI` is set, so the install cannot regress silently.

## References

- [ADR-001: Bun Runtime Choice](001-bun-runtime-choice.md)
- [ADR-003: Hybrid Storage Architecture](003-hybrid-storage-architecture.md)
- [Valkey ACL rule syntax](https://valkey.io/topics/acl/)
