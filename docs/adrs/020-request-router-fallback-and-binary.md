# ADR-020: Request Router Fallback Routes and Binary Bodies

## Status

Accepted

## Context

Kinglet serves every emulated service on one host. GCP does not.

Cloud Tasks lives at `cloudtasks.googleapis.com`. Storage's JSON API lives at
`storage.googleapis.com`. A signed URL is
`storage.googleapis.com/{bucket}/{object}`. The hostname already picks the
service, so GCP never has to decide whether a path belongs to Tasks or to
Storage. Those paths are never scored against each other.

Kinglet has one port and no such hostname. A signed URL arrives as
`/{bucket}/{object}`. The Node client sets that path to `/{bucket}/{file}`
(`@google-cloud/storage` `signer.js`, `getResourcePath`) no matter what API
endpoint is configured, so a prefix such as `/storage` is not available to
hang the route on.

That shape matches almost any other path: one segment, then everything else.
If the router treats it as just another pattern and picks the one that looks
most specific, the signed-URL route steals real API calls.

This request is a Cloud Tasks queue:

```
GET /v2/projects/my-project/locations/us-central1/queues/email
```

The pattern `/:bucket/**` also matches it. The bucket is `v2` and the object
is `projects/my-project/locations/us-central1/queues/email`. The router prefers
the catch-all, so the queue request is handled as a storage object and the
Tasks handler never runs. The same thing happens to KMS and Secrets.

The score is a short note on why, not the rule. The router ranks a pattern by
how much of it is fixed text. `/:bucket/**` splits into an empty piece before
the first slash, `:bucket`, and `**`. The empty piece and `**` both count as
fixed, so the pattern scores about 67. The Tasks path has more named pieces
and scores lower. The higher score wins. Registering the catch-all first does
not help: order matters only when the scores are equal.

A test that only probes `/health`, `/storage/v1/b/:bucket`, and a Pub/Sub
topic path misses this. Those three score high enough to survive. The
registration test also skipped Secrets, AlloyDB, Cloud SQL, and Compute, so
those four were never in the table under test.

Media bytes have a separate problem, and it is not fixed here. The production
router reads the body before it has chosen a route. A non-JSON body is read
as text, so the byte `0xFF` becomes the replacement character U+FFFD. On the
way out, any object body is `JSON.stringify`'d, and a `Uint8Array` is an
object, so a media download becomes a JSON map of byte indexes. ADR-009 left
`buildRouter` in place for tests that return raw bytes, because the production
router cannot. `e2e/storage-workflow.test.ts` uses that test router, so
`file.save` and `file.download` there do not show what `bun run start` does.

## Decision

### Fallback matching

Ordinary routes are tried first. A fallback is used only when no ordinary
route matches.

`/{bucket}/{object}` is the only fallback. Nothing else is. It will be the
storage path-style `GET`, `PUT`, and `DELETE` on `/:bucket/**`. This change
does not register those storage handlers. The signed-URL change does, and it
extends the full-table regression test rather than replacing it. Signatures
are not checked. Virtual-hosted URLs (`bucket.storage.googleapis.com`) are
out of scope.

In the router that is:

- `RouteDefinition` gains `fallback?: boolean`.
- Ordinary routes are scored on their own. Fallback routes are scored only
  after every ordinary route has missed. Score is never compared across the
  two groups. Inside a group, a higher score wins and the first route wins a
  tie.
- `addRoute` rejects a second fallback for the same method, even when the
  paths differ. One fallback per method.

### Binary request and response

The production router will do the following. This change does not.
`parseRequest` and `createHttpResponse` stay as they are until a later change.

1. Read the path and query first, then choose the route, then read the body.
2. `metadata.rawBody: true` means the body is the raw bytes (`Uint8Array`
   from `arrayBuffer()`). It is not set on every
   `POST /upload/storage/v1/b/:bucket/o`. That one URL is both a media upload
   and the start of a resumable upload. The resumable start sends JSON
   `{"name","contentType"}`, and the handler reads those fields off the
   parsed object. If that body were always raw bytes, `name` would be missing
   and the upload would be stored under an empty name.
3. On that POST, `uploadType=resumable` with `Content-Type: application/json`
   stays JSON. Every other body on that POST (a media upload, a
   `multipart/related` upload) is raw bytes, including
   `Content-Type: application/json` when `uploadType` is not `resumable`.
   Resumable chunk PUTs, downloads, `alt=media`, and path-style PUT set
   `rawBody`.
4. A response body that is already bytes (`Uint8Array`, `ArrayBuffer`) or a
   `ReadableStream` is sent unchanged, and is not labeled `application/json`.
   Any other object is still `JSON.stringify`'d.

The resumable handler keeps reading `body.name` and `body.contentType` as
strings. It does not decode raw bytes back into JSON. `extractBodyBytes`
already accepts `Uint8Array`, so parsing a multipart body can be a separate
change.

The tests for this contract go through `buildProductionRouter`. One stores
the four bytes `0xFF 0x00 0x41 0x42` (once with
`Content-Type: application/json`) and checks that the saved md5 is those
bytes and that `GET ?alt=media` returns them, not a JSON map. The other
starts a resumable upload with
`{"name":"obj","contentType":"text/plain"}`, PUTs the raw chunk, and checks
that a metadata GET still has `contentType === "text/plain"`. The `Location`
header does not contain the object name, so that GET is what shows the
session kept `name`. `e2e/storage-workflow.test.ts` then moves onto
`buildProductionRouter`.

## Rationale

GCP does not need a clever matcher here. The hostname already separated
Tasks from Storage before the path was looked at. Kinglet cannot do that:
clients pointed at the emulator send `localhost`, and the signer will not
add a path prefix.

So the catch-all has to wait. Every ordinary route is given a chance to
match. Only a path that none of them claim, such as
`GET /my-bucket/nested/object`, falls through to `/{bucket}/{object}`.

Raising the catch-all's score, or registering it first, still lets the score
pick the winner. The Tasks queue above would still lose.

Reading the body after the route is chosen is what lets one route be raw
bytes and another be JSON. The shared upload URL has to stay conditional,
because that one URL really is two operations.

## Alternatives Considered

**Give `/:bucket/**` a higher score.** Rejected. The catch-all already
outranks the Tasks queue because `**` counts as fixed text. More score makes
that worse.

**Put signed URLs under a static prefix such as `/storage`.** Rejected. The
Node signer writes `/{bucket}/{file}` and does not prepend the API path.

**Dispatch on the `Host` header, the way GCP does.** Rejected for the same
reason as ADR-009. An emulator client sends `localhost`.

**Always read the shared upload POST as raw bytes.** Rejected. Starting a
resumable upload on that URL is JSON, and the handler needs `name`.

**Decode those raw bytes back to JSON inside the resumable handler.**
Rejected for the same reason. The router can already tell the two requests
apart.

## Consequences

- A second fallback for one method fails at startup, and the error names both
  route ids.
- Once `/{bucket}/{object}` exists, a Cloud Tasks queue, a KMS get, and a
  Secrets get still reach their own handlers. The regression test builds the
  `src/index.ts` table (health, locations, composed operations, all 12
  services) and checks every registered route before and after three dummy
  fallbacks. `GET /my-bucket/nested/object` matches nothing until those
  fallbacks exist.
- No route except storage path-style GET, PUT, and DELETE may set `fallback`.
  Those three are still unregistered.
- Body parsing and response encoding are unchanged. Until the binary change
  lands, ADR-009 still holds: tests that return raw bytes use `buildRouter`,
  and the production router still reads the body before matching and
  `JSON.stringify`s object bodies.
- After that binary change, `e2e/storage-workflow.test.ts` uses
  `buildProductionRouter`.
