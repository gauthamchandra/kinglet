# Adding a new GCP service

> **Open a *New service proposal* issue and get it accepted before writing code.** A complete
> unsolicited service PR is the most expensive kind to decline. See
> [CONTRIBUTING.md](../CONTRIBUTING.md#what-we-accept).

---

## How a service plugs in

kinglet is a single HTTP server with a routing gateway in front of pluggable service modules
(see [ADR-004](adrs/004-modular-service-gateway.md)). A service is a class that knows how to
build itself and hand back a list of routes. The gateway does the rest.

```
Bun.serve()  →  RequestRouter  →  route.handler  →  Handlers → Service → Repository → StorageManager
                                                    (HTTP)     (rules)   (queries)    (sqlite/memory/hybrid)
```

The contract every service satisfies:

```ts
class MyService {
  constructor(storage: StorageManager, logger: Logger) {}

  async initialize(): Promise<void>   // build components, create tables
  getRoutes(): RouteDefinition[]      // hand routes to the gateway
  start(): void                       // optional: background work (pollers, engines)
  async stop(): Promise<void>         // graceful shutdown
}
```

There is deliberately no `ServiceModule` interface to implement. Services are structurally
similar rather than nominally typed — `src/index.ts` wires each one explicitly.

---

## The file pattern

Every service lives in `src/services/<name>/` and follows the same layering. Each file has a
**co-located `.test.ts`**.

| File | Responsibility |
|---|---|
| `types.ts` | Record types, table name constant, table schema, name builders/parsers |
| `repository.ts` | Persistence only. Wraps `StorageManager`. No business rules. |
| `service.ts` | Business rules, validation, error types. No HTTP. |
| `handlers.ts` | HTTP only — parse request, call service, format response. Owns `getRoutes()`. |
| `index.ts` | Wires the above together and exposes the service class |

Larger services split by resource rather than adding layers. `src/services/pubsub/` is the
canonical example — it has `topic-`, `subscription-`, `schema-`, and `snapshot-` triples of
`*-repository.ts` / `*-service.ts` / `*-handlers.ts`, plus a `delivery-engine.ts`.

**Model new work on [`src/services/scheduler/`](../src/services/scheduler/)** — 7 source files
and 7 test files, the smallest complete service.

> Do **not** model on `src/services/secrets/`. It is a single file with no tests and is
> genuinely unimplemented — it is a stub, not a pattern.

### Why the layers are separate

The split exists so that `service.ts` can be unit-tested with a mocked repository and no HTTP,
and `handlers.ts` can be tested with a mocked service. If you find yourself doing storage
queries in a handler or formatting JSON responses in a service, the layering has broken and
the tests will get harder to write — that is the signal, not a style preference.

---

## Step by step

### 1. Register the Discovery Document

Add an entry to [`discovery-document-registry.json`](../discovery-document-registry.json):

```json
{
  "name": "cloud-kms",
  "displayName": "Cloud KMS",
  "discoveryUrl": "https://cloudkms.googleapis.com/$discovery/rest?version=v1",
  "version": "v1",
  "implementationPath": "src/services/kms/"
}
```

**Read the discovery document before writing any code.** It is the specification. Every field
name, status code, and resource-name format you implement comes from it. See the
[fidelity contract](../CONTRIBUTING.md#the-fidelity-contract).

```sh
curl -s 'https://cloudkms.googleapis.com/$discovery/rest?version=v1' \
  | jq '.resources.projects.resources.locations.resources.keyRings'
```

Three kinds of thing come out of that read, and only the first is obvious:

**What exists.** The method list, request/response shapes, and resource-name format.

**What deliberately does *not* exist.** Real Cloud KMS has no method to delete a key ring —
not a restricted one, none at all. So kinglet must not offer one either, not even as a
convenience for tests. The moment kinglet supports an operation GCP doesn't, code that works
locally breaks in production, which defeats the point of the tool. Absences in the discovery
document are part of the specification.

**The quirks you would never guess.** `keyRings.create` takes the ID as a *query parameter*
(`?keyRingId=my-ring`), not in the request body — the body is the resource itself. Several
GCP APIs do this. Guessing gets it wrong.

### 2. Define types and the table schema — `types.ts`

```ts
export const KMS_KEYS_TABLE = 'kms_crypto_keys';

export const kmsKeysTableSchema: TableSchema = { /* columns, indexes */ };

export interface CryptoKeyRecord extends BaseRecord {
  name: string;          // projects/{p}/locations/{l}/keyRings/{kr}/cryptoKeys/{k}
  purpose: string;
  // ...
}

export function buildCryptoKeyName(project: string, location: string, /* … */): string {}
export function parseCryptoKeyName(name: string): { project: string; /* … */ } | null {}
```

GCP resource names are hierarchical strings, and every service needs to build and parse them.
Keep that logic here, not scattered across handlers.

### 3. Persistence — `repository.ts`

Wraps `StorageManager`. Create the table in `initialize()`:

```ts
export class CryptoKeyRepository {
  constructor(private storage: StorageManager) {}

  async initialize(): Promise<void> {
    await this.storage.createTable(KMS_KEYS_TABLE, kmsKeysTableSchema);
  }

  async getByName(name: string): Promise<CryptoKeyRecord | null> {
    return this.storage.findFirst<CryptoKeyRecord>(KMS_KEYS_TABLE, {
      filter: { conditions: [{ field: 'name', operator: 'eq', value: name }] },
    });
  }
}
```

`StorageManager` gives you `create`, `createMany`, `findById`, `find`, `findFirst`,
`updateById`, `updateMany`, `deleteById`, `deleteMany`, `exists`, `count`, and
`withTransaction`. See [ADR-003](adrs/003-hybrid-storage-architecture.md) for why storage is
hybrid (SQLite + LRU cache) and what that means for consistency.

**Note the uniqueness caveat.** The memory provider does not enforce unique indexes. Where GCP
would reject a duplicate, guard explicitly in the repository — `scheduler/repository.ts`
does this and comments why.

**Pagination:** GCP uses `pageSize`/`pageToken`/`nextPageToken`. The established approach is an
integer offset encoded as the page token — see `JobRepository.listJobs`.

### 4. Business rules — `service.ts`

Validation, state transitions, and a service-specific error type carrying a GCP status:

```ts
export class KmsError extends Error {
  constructor(message: string, readonly code: number, readonly status: string) {
    super(message);
  }
}
```

The `status` string must be the real GCP status (`ALREADY_EXISTS`, `NOT_FOUND`,
`INVALID_ARGUMENT`, `FAILED_PRECONDITION`), and `code` the matching HTTP status. Getting this
pair wrong is the most common fidelity bug — client libraries branch on it.

### 5. HTTP — `handlers.ts`

Owns `getRoutes()`. Paths use `:param` placeholders and must match GCP's REST paths exactly:

```ts
getRoutes(): RouteDefinition[] {
  return [
    {
      id: 'kms.cryptoKeys.create',
      method: 'POST',
      path: '/v1/projects/:project/locations/:location/keyRings/:keyRing/cryptoKeys',
      handler: (req, ctx) => this.handleCreate(req, ctx),
    },
  ];
}
```

Use `ResponseUtils` / `StandardResponseFormatter` from
`@/core/gateway/response-handlers.ts` so error envelopes match GCP's shape.

Route `id` convention: `<service>.<resource>.<method>`.

### 6. Wire it up — `index.ts`

Export a service class with `initialize` / `getRoutes` / `start` / `stop`. Model it on
[`src/services/scheduler/index.ts`](../src/services/scheduler/index.ts).

### 7. Register in four places

This is the step people miss. All four are required:

1. **`src/services/index.ts`** — add `export * from './kms/index.ts';`
2. **`src/config/schema.ts`** — add to `ServicesConfigSchema`:
   ```ts
   kms: z.object({ enabled: z.boolean().default(true) }),
   ```
3. **`config/default.json`** — add the matching `services.kms.enabled` entry.
4. **`src/index.ts`** — construct, initialize, register routes, start; and add the `stop()`
   call to `shutdown()`. Follow the existing `if (config.services.X.enabled)` blocks.

Forgetting the `shutdown()` half leaks resources on SIGTERM and is easy to miss because no
test catches it.

### 8. Document it

1. Add service metadata to [`docs/service-metadata.json`](../docs/service-metadata.json) (status, data plane, summary).
2. Register the service in `discovery-document-registry.json`.
3. Run `bun run docs:generate:api` and commit the generated API reference under `docs/reference/api/`.
4. Call out unimplemented endpoints explicitly in the PR description. The compatibility matrix is refreshed separately by the scheduled docs sync workflow.

---

## Pre-PR checklist

Copy this into your PR description.

**Fidelity**
- [ ] Discovery document URL cited in the PR
- [ ] Registered in `discovery-document-registry.json`
- [ ] Request/response field names match the discovery doc exactly, including casing
- [ ] HTTP status codes match real GCP, **including error cases**
- [ ] Error envelope is `{ error: { code, message, status, details? } }` with real GCP status strings
- [ ] Resource-name format matches (`projects/{p}/locations/{l}/…`)
- [ ] `pageSize` / `pageToken` / `nextPageToken` implemented where GCP paginates
- [ ] Unimplemented endpoints and fields listed explicitly in the PR and generated compatibility docs

**Structure**
- [ ] Follows the `types` / `repository` / `service` / `handlers` / `index` layering
- [ ] No storage queries in handlers; no HTTP formatting in services
- [ ] Registered in all four places (§7)
- [ ] `stop()` wired into `shutdown()` in `src/index.ts`

**Tests**
- [ ] Co-located `.test.ts` beside every source file
- [ ] `bun test` passes; coverage not lowered
- [ ] Every test has a meaningful `expect()`; no conditional assertions; no `expect(true).toBe(false)`
- [ ] Error paths tested, not just happy paths

**Hygiene**
- [ ] `bun run lint` clean — zero errors, zero warnings
- [ ] No new `knip.json` `ignoreIssues` entries (or justified in the PR)
- [ ] Conventional Commit messages, signed off with `-s`
- [ ] AI assistance disclosed if applicable

---

## Verifying against a real client library

The real test is whether an official client library is satisfied. The repo already has
`@google-cloud/pubsub`, `-scheduler`, `-storage`, `-tasks`, and `-workflows` as devDependencies
for exactly this. Point the client at `http://localhost:8765` via the service's `apiEndpoint`
option and exercise your endpoints — see [`e2e/`](../e2e/) for the established pattern.

If you use Claude Code, the
[compatibility-audit skill](../.claude/skills/compatibility-audit/SKILL.md) diffs an
implementation against its discovery document. It is a useful backstop, not a replacement for
reading the document.
