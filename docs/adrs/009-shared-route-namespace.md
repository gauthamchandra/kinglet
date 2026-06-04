# ADR-009: Shared Route Namespace Across Services

## Status

Accepted

## Context

Real GCP gives every service its own host — `cloudkms.googleapis.com`,
`workflows.googleapis.com`, `cloudtasks.googleapis.com`. The emulator serves all
of them from a single port, so the host that disambiguates them upstream is gone
and every service's routes land in one flat namespace on one `RequestRouter`.

Two consequences went unnoticed until Cloud KMS was added (ADR-008):

1. **Silent shadowing.** `google.cloud.location.Locations` is mixed into most
   GCP APIs, so Workflows, KMS and Memorystore each registered
   `GET /v1/projects/{project}/locations`, with three byte-identical copies of
   the same region list. `RequestRouter.addRoute` only rejected duplicate route
   *ids*, and `findRoute` keeps the first route on a score tie, so whichever
   service registered last became unreachable dead code. Nothing logged, nothing
   failed.

2. **Resource ids were case-folded.** `normalizePath` lowercased the whole
   request path so that static segments would match case-insensitively. Path
   parameters were lowercased along with them, but GCP resource ids are
   case-sensitive: `keyRingId=MyRing` is legal (`[a-zA-Z0-9_-]{1,63}`) and
   creation read the id from the query string, where case survived. The result
   was a key ring that returned 200 on create and 404 on every subsequent read.

Both were invisible to the test suite. The KMS end-to-end tests ran against
`e2e/e2e-helpers.ts`'s `buildRouter`, a simplified matcher that performs no path
normalization and no match scoring — so the production routing path was never
exercised.

## Decision

### Reject conflicting registrations instead of silently dropping them

`addRoute` now throws when a route's method and path are already claimed:

```
Route 'kms.locations.list' conflicts with 'workflows.locations.list':
GET /v1/projects/:project/locations is already registered
```

The conflict key collapses parameter names (`/topics/:topic` and
`/topics/:topicId` accept identical requests) and case-folds unless the router is
configured case-sensitive. Startup fails loudly rather than shipping an endpoint
that answers from the wrong service.

### One owner for shared GCP surfaces

`src/core/gateway/location-routes.ts` owns the `/v1` locations endpoint, and
`src/index.ts` registers it once alongside the health route. Services no longer
declare it. The location list is the union of what the individual services
previously advertised, `global` included, so KMS key rings resolve.

### Compose, rather than shadow, where two services genuinely share a path

The operations endpoints are the case where two services must both answer on one
path: Workflows and Memorystore each own real LROs, and a caller cannot know
which service minted an operation id. ADR-007 solved this by registering a
composed route set *first* so it won the score tie, leaving each service's own
copy registered but shadowed. That is no longer expressible — `addRoute` now
rejects the duplicate.

So `src/index.ts` drops each service's operations routes when the composed set
is registered, via `isComposedOperationsPath`. The composed handler queries every
store, so behavior is unchanged; what changes is that the losing routes are
never registered rather than registered-and-ignored. Ownership is now stated in
the registration code instead of implied by call order.

### Normalize request paths structurally, not lexically

Path normalization is split in two. Route templates are case-folded at
registration time so that two spellings of one path collide in the conflict
check. Request paths get structural normalization only — duplicate slashes
collapsed, trailing slash dropped — and keep their case. Case-insensitive
matching still works because `pathToRegex` already compiles with the `i` flag.

### Test the production router end-to-end

`buildProductionRouter` in `e2e/e2e-helpers.ts` wires the real `RequestRouter`,
and the KMS e2e suite uses it. `src/services/route-registration.test.ts` assembles
every service's routes the way `src/index.ts` does, which fails if any two
services ever claim the same path again.

## Rationale

A single-port emulator cannot serve two different responses on one path, so the
question was never *whether* to have one owner for `/v1/.../locations` but
*which*. Making it service-neutral keeps the endpoint available regardless of
which services are enabled — the alternative left KMS clients depending on
Workflows being on.

The fidelity cost is real but small: real KMS and real Workflows advertise
different region sets, and the emulator now advertises their union to both.
Region availability is not what anyone tests against an emulator.

Case-folding request paths was always the wrong layer to solve
case-insensitive matching at — the regex flag already did that job, and folding
the path additionally destroyed data the handlers needed.

## Alternatives Considered

**Drop the KMS locations routes and let Workflows serve them.** Smallest diff,
but it makes an unrelated service a hard dependency of KMS: disabling Workflows
would 404 KMS's locations endpoint.

**Warn instead of throwing on a conflict.** Warnings in a startup log are how
this bug survived review in the first place.

**Route by `Host` header.** This is what real GCP does, but client libraries
pointed at the emulator all send `localhost:8765`, so there is nothing to
disambiguate on.

**Make the router case-sensitive.** Would preserve ids, but `/v1/KeyRings` would
stop matching `/v1/keyRings`, which is a stricter contract than the emulator has
promised so far.

## Consequences

- A service that copies a canonical GCP path already owned by another service now
  fails at startup with both route ids named.
- Resource ids keep their case through the router for every service, not just
  KMS — Pub/Sub topics and Cloud Tasks queues also permit uppercase ids.
- Shared GCP surfaces beyond Locations and Operations (IAM policy methods, for
  instance) will need one of the same two treatments as they are implemented: a
  service-neutral owner (`location-routes.ts`) when every service would answer
  identically, or a composed handler (`composable-operations.ts`) when each
  service holds its own state.
- Cloud Tasks keeps its own `/v2` locations routes. They sit on a different API
  version and do not collide.
- `e2e/e2e-helpers.ts` now exposes two routers. `buildProductionRouter` is the
  right default; `buildRouter` remains for suites that return binary bodies,
  which the production router does not yet support.
