# Bugbot rules — GCP service emulations (`src/services/`)

These apply on top of the root rules. Reference: [docs/adding-a-service.md](../../../docs/adding-a-service.md).

---

## 1. API fidelity — the highest-priority check

Every emulated endpoint must match the real Google API. The specification is that service's
official Discovery Document, registered in
[`discovery-document-registry.json`](../../../discovery-document-registry.json).

**Flag as high severity:**

- **Field names that don't match the discovery document**, including casing. GCP REST is
  `camelCase`. A misspelled or snake_cased field means no real client library can parse the
  response.
- **HTTP status codes that don't match real GCP, especially on error paths.** This is the most
  common fidelity bug and it is invisible on the happy path. The status code and the GCP
  status string must be a correct pair:

  | Situation | HTTP | Status string |
  |---|---|---|
  | Resource already exists | **409** | `ALREADY_EXISTS` |
  | Resource not found | **404** | `NOT_FOUND` |
  | Malformed request / bad field | **400** | `INVALID_ARGUMENT` |
  | Wrong state for the operation | **400** | `FAILED_PRECONDITION` |

  Returning 400 where GCP returns 409 is a real bug: client libraries branch on this, and the
  wrong code makes them give up instead of surfacing a retryable conflict.
- **Error responses not shaped as** `{ error: { code, message, status, details? } }`. Don't
  hand-roll the envelope — use `ResponseUtils` / `StandardResponseFormatter` from
  `@/core/gateway/response-handlers.ts`.
- **Resource names that don't follow GCP's hierarchical format**
  (`projects/{p}/locations/{l}/…`). Name building and parsing belongs in `types.ts`, not
  inlined in handlers.
- **List endpoints missing pagination** (`pageSize` / `pageToken` / `nextPageToken`) where the
  real API paginates.
- **Endpoints the real API does not have.** If GCP has no way to do it, kinglet must not offer
  it — not for convenience, not for tests, not behind a flag. Absences in the discovery
  document are part of the specification. (Real Cloud KMS has no delete for key rings; adding
  one would be a bug, not a feature.)
- **A PR adding or changing an endpoint without citing its discovery document.** Ask for it.

Name-parsing regexes deserve a close look: an unanchored pattern will happily parse a child
resource's name as its parent's, which surfaces much later as a confusing 404.

## 2. Layering

Every service lives in `src/services/<name>/` and follows the same layering. Each file has a
co-located `.test.ts`.

| File | Responsibility |
|---|---|
| `types.ts` | Record types, table name constant, table schema, name builders/parsers |
| `repository.ts` | Persistence only. Wraps `StorageManager`. **No business rules.** |
| `service.ts` | Business rules, validation, error types. **No HTTP.** |
| `handlers.ts` | HTTP only — parse request, call service, format response. Owns `getRoutes()`. |
| `index.ts` | Wires the above together and exposes the service class |

**Flag:**

- **Storage queries in a handler**, or direct `StorageManager` use outside a repository.
- **HTTP concerns in a service** — `Request`/`Response` objects, status codes, header
  manipulation, JSON envelope formatting.
- **Business rules in a repository** — validation, state-transition checks, authorization.
- Larger services adding *layers* instead of splitting by resource. The established pattern
  for growth is `<resource>-repository.ts` / `-service.ts` / `-handlers.ts` triples, as in
  `src/services/pubsub/`.

The split exists so `service.ts` is unit-testable with a mocked repository and no HTTP, and
`handlers.ts` with a mocked service. When a PR mixes the layers, the tests get harder to
write — that is the signal, and it's worth saying so in the review rather than treating it as
style preference.

New code modelled on `src/services/secrets/` is a red flag: that directory is a single file
with no tests and is genuinely unimplemented. It is a stub, not a pattern. The reference
implementation is `src/services/scheduler/` (smallest complete service);
`src/services/pubsub/` shows the multi-resource shape.

## 3. Registration completeness

A new service must be registered in **four** places. Missing any one leaves it silently
inert, and only the last is caught by running the server:

1. `src/services/index.ts` — barrel export
2. `src/config/schema.ts` — `ServicesConfigSchema` entry
3. `config/default.json` — matching `services.<name>.enabled`
4. `src/index.ts` — construct, `initialize()`, register routes, `start()` if applicable

**Also flag a missing `stop()` call in `shutdown()` in `src/index.ts`.** This is the one that
gets forgotten most often: it leaks resources on SIGTERM and no test catches it.

## 4. Storage

- The **memory provider does not enforce unique indexes.** Where real GCP rejects a duplicate,
  the repository must guard explicitly — relying on a unique constraint alone will pass in
  SQLite and silently allow duplicates in memory mode.
- Multi-record writes that must be atomic should use `storage.withTransaction(...)`.
- Table creation belongs in the repository's `initialize()`, using the schema from `types.ts`.
