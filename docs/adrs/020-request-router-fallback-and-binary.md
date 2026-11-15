# ADR-020: Request Router Fallback Routes and Binary Bodies

## Status

Accepted

## Context

Signed object URLs and media uploads both hit the production router, and both
lose today for reasons that are not the storage handlers.

`RequestRouter.matchPath` counts the leading empty segment and a literal `**`
as static. `GET /:bucket/**` therefore scores about 66.7. Any ordinary route
whose static share is under that loses, including Cloud Tasks queue and task
paths and several KMS gets. Registration order does not save them: score is
compared across every route for the method, and a tie is the only case where
the first route wins. Probes of `/health`, `/storage/v1/b/:bucket`, and
`/v1/projects/:project/topics/:topic` all survive that score, so they are not
a regression test. The registration test skipped Secrets, AlloyDB, Cloud SQL,
and Compute, so those four never entered the table under test.

A static prefix cannot replace the path. The Node client signer sets the
request pathname to `/{bucket}/{file}` (`@google-cloud/storage` `signer.js`,
`getResourcePath`) whatever `apiEndpoint` is.

Separately, `route()` reads the body before `findRoute`. A non-JSON body goes
through `request.text()`, so a `0xFF` byte becomes U+FFFD. `createHttpResponse`
then `JSON.stringify`s any object body, and a `Uint8Array` is an object, so a
media GET becomes a JSON map of bytes. ADR-009 keeps `buildRouter` for suites
that return binary bodies because the production router does not support them.
`e2e/storage-workflow.test.ts` uses `buildRouter`, so `file.save` /
`file.download` there do not protect `bun run start`.

## Decision

### Fallback matching

- `RouteDefinition` gains `fallback?: boolean`.
- `findRoute` scores ordinary routes first. It scores fallback routes only when
  no ordinary route matches. Score is used inside each group, not across them.
  Inside a group, a higher score wins and the first route wins a tie.
- `addRoute` rejects a second fallback for the same method, including when the
  paths differ. One fallback per method is the whole rule.
- The only routes that will set `fallback: true` are storage path-style
  `GET`, `PUT`, and `DELETE` `/:bucket/**`. Nothing else is a fallback.
  Signatures are not checked. Virtual-hosted URLs are out of scope.

The fallback rules above are implemented in this change. The three storage
routes are not registered here. The signed-URL change registers them, and it
extends the full-table regression test rather than replacing it.

### Binary request and response

The production router will do the following. This change does not. A later
change implements it; `parseRequest` and `createHttpResponse` stay as they are
until then.

1. Parse the path and query first, then match the route, then read the body.
2. `metadata.rawBody: true` means the body is a `Uint8Array` from
   `arrayBuffer()`. It is not set unconditionally on
   `POST /upload/storage/v1/b/:bucket/o`. That route is both a media upload
   and a resumable-session start. `handleInsertObject` reads `req.body` as
   `{ name, contentType }` when `uploadType=resumable`. A blanket `Uint8Array`
   makes `name` and `contentType` undefined, and the session is stored under
   an empty name.
3. On that POST, `uploadType=resumable` with `Content-Type: application/json`
   stays `request.json()`. Every other body on that POST (media,
   `multipart/related`) is raw bytes, including `Content-Type: application/json`
   when `uploadType` is not `resumable`. PUT resumable chunks, download,
   `alt=media`, and path-style PUT set `rawBody`.
4. `createHttpResponse` passes `Uint8Array`, `ArrayBuffer`, and
   `ReadableStream` through unchanged and does not force `application/json`
   on them. Other objects stay `JSON.stringify`.

The resumable handler keeps reading `body.name` and `body.contentType` as
strings. Decoding bytes back to JSON inside the handler is not the contract.
`extractBodyBytes` already accepts `Uint8Array`, so multipart parsing does
not have to ship in the same change.

Tests for that contract go through `buildProductionRouter`: a raw media
round-trip of `0xFF 0x00 0x41 0x42` (including once with
`Content-Type: application/json`) whose stored md5 matches those bytes and
whose `GET ?alt=media` returns the same bytes, and a resumable start of
`{"name":"obj","contentType":"text/plain"}` followed by a raw PUT whose
metadata GET has `contentType === "text/plain"`. The `Location` header does
not contain the object name, so that GET is what proves the session kept
`name`. `e2e/storage-workflow.test.ts` then moves onto `buildProductionRouter`.

## Rationale

The catch-all has to lose to every ordinary route that actually matches,
including routes that score under ~67. A flag that skips a group is that
rule. Raising the catch-all's score, or registering it first, still lets
score decide.

Matching before the body is read is what makes `rawBody` a property of the
route rather than of the content type. The shared upload POST is the
exception that has to stay conditional, because one URL is two operations.

## Alternatives Considered

**Give `/:bucket/**` a higher score.** Rejected. `**` already counts as
static, and that is why the catch-all beats real routes. More score makes
the theft worse.

**A static prefix such as `/storage`.** Rejected. The Node signer writes
`/{bucket}/{file}` and does not prepend the API endpoint path.

**Route signed URLs by `Host`.** Rejected for the same reason as ADR-009.
Clients pointed at the emulator send `localhost`.

**Unconditional `rawBody` on the shared upload POST.** Rejected. Resumable
session start is JSON on that URL, and the handler reads `name` off the
parsed object.

**Decode the raw bytes back to JSON in the resumable branch.** Rejected for
the same reason. The router already knows which requests are JSON.

## Consequences

- A second fallback for one method fails at startup, with both route ids named.
- Ordinary routes keep winning after `/:bucket/**` exists, including Cloud
  Tasks and KMS paths that score under the catch-all. The regression test
  builds the `src/index.ts` table (health, locations, composed operations,
  all 12 services) and checks every registered id before and after three
  dummy fallbacks. `GET /my-bucket/nested/object` is unclaimed until those
  fallbacks exist.
- No service other than storage path-style GET, PUT, and DELETE may set
  `fallback`. Those three routes are still unregistered.
- Body parsing and response encoding are unchanged. Until the binary change
  lands, ADR-009's note stands: suites that return binary bodies still use
  `buildRouter`, and the production router still parses the body before
  matching and `JSON.stringify`s object bodies.
- `buildProductionRouter` becomes the router the storage workflow tests use
  once that binary change has landed.
