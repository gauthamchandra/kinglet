# ADR-004: Modular Service Gateway Pattern

## Status

Accepted

## Context

The emulator needs to host multiple GCP service emulations (Cloud Scheduler,
Cloud Tasks, Pub/Sub, Secret Manager, and future services) behind a single HTTP
endpoint. Each GCP service has its own REST API with paths following the
convention:

```
/{version}/projects/{project}/locations/{location}/{resource}
```

We need an approach that:

1. Allows services to be developed and tested independently
2. Allows services to be enabled or disabled at runtime
3. Routes incoming requests to the correct service handler
4. Matches GCP's actual REST API paths exactly so that official client libraries
   work without modification

## Decision

We will use a **central `RequestRouter`** with **per-service route registration**.

Each GCP service module implements a handler class that exposes a `getRoutes()`
method returning an array of `RouteDefinition` objects. At startup, the
application iterates over enabled services and registers their routes with the
shared router. The router handles path matching with parameter extraction
(`:project`, `:location`, `:jobId`, etc.) and GCP action suffixes (`:pause`,
`:resume`, `:run`).

```
┌──────────────┐    RouteDefinition[]     ┌───────────────┐
│  Scheduler   │ ──────────────────────── │               │
│  Handlers    │                          │               │
├──────────────┤    RouteDefinition[]     │  Request      │     HTTP
│  Tasks       │ ──────────────────────── │  Router       │ ◄────────
│  Handlers    │                          │               │
├──────────────┤    RouteDefinition[]     │               │
│  Future      │ ──────────────────────── │               │
│  Service     │                          └───────────────┘
└──────────────┘
```

Services are enabled or disabled via configuration (`ENABLE_SCHEDULER=true`,
`ENABLE_TASKS=false`, etc.) — disabled services simply don't register routes.

## Rationale

### Why per-service route registration

- **Isolation**: Each service owns its routes, handlers, and business logic.
  Adding a new service requires no changes to the core gateway.
- **Testability**: Services can be tested in isolation by exercising their
  `RouteDefinition[]` directly, without spinning up the full HTTP server.
- **Selective enablement**: Users who only need Cloud Tasks can disable Scheduler
  to reduce memory usage and log noise.

### Why a single HTTP entrypoint

- GCP client libraries expect a single `apiEndpoint`. Hosting all services on one
  port means users set the endpoint once and all services work.
- Simpler Docker setup — one port mapping covers everything.

### Why GCP path conventions matter

- By matching `/{version}/projects/{project}/locations/{location}/...` exactly,
  the official `@google-cloud/*` client libraries work with only an endpoint
  override — no request interceptors or custom transports needed.

## Alternatives Considered

### One port per service

**Pros**: Clean separation, no routing conflicts.
**Cons**: Multiple port mappings, users must configure each client separately,
harder Docker Compose setup.

### Express/Hono framework

**Pros**: Mature routing, middleware ecosystem.
**Cons**: Adds a dependency when Bun's native `Bun.serve()` + a lightweight
custom router is sufficient. Express specifically conflicts with the Bun-native
approach (see ADR-001).

## Consequences

### Positive

- Adding a new GCP service is formulaic: implement handlers, return
  `RouteDefinition[]`, register in `src/index.ts`
- Client libraries work with a single endpoint override
- Services can be developed in parallel by different contributors without merge
  conflicts in routing code
- Route definitions serve as self-documenting API surface

### Negative

- All services share one port, so a crash in one service's handler can return
  errors for that route without affecting others (but a process crash affects all)
- The custom router is simpler than production frameworks — no built-in
  middleware chain or content negotiation (acceptable for an emulator)

## Implementation Notes

- `RequestRouter` lives in `src/core/gateway/request-router.ts`
- Route matching supports parameterized segments (`:param`) and GCP action
  suffixes (`:pause`, `:resume`, `:run`, `:purge`)
- Each `RouteDefinition` specifies `id`, `method`, `path`, and `handler`
- Service registration happens in `src/index.ts` — the main entrypoint checks
  each service's `enabled` flag before calling `getRoutes()`

## References

- [Google Cloud REST API Design Guide](https://cloud.google.com/apis/design)
- [ADR-001: Bun Runtime Choice](001-bun-runtime-choice.md)
