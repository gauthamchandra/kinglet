# ADR-018: Native gRPC Server for Cloud Tasks

## Status

Accepted

## Context

kinglet serves GCP client libraries over HTTP/REST using a custom router. Client libraries
for Cloud Tasks (and eventually Pub/Sub, Scheduler, etc.) prefer gRPC; the `fallback: 'rest'`
option the existing e2e tests used bypasses client library gRPC behaviour and makes routing
opaque. A native gRPC server lets the actual generated stubs connect as they do against
real GCP.

An earlier approach (`GrpcRestBridge`) attempted to translate gRPC calls back into HTTP
requests and reuse the REST handler layer. That added a second protocol boundary on top of
the existing REST implementation without providing the fidelity benefit of speaking gRPC
natively.

## Decision

- Start a second TCP port (default 8766, `grpcPort` in config) serving raw gRPC using
  `@grpc/grpc-js` and `@grpc/proto-loader`.
- Load Cloud Tasks v2 protos from `google-proto-files`, which is a direct dependency that
  tracks the canonical googleapis proto repository.
- Each emulated service that has a gRPC surface exposes `getGrpcServices()` returning
  `GrpcServiceDefinition[]`. `src/index.ts` collects those definitions and registers them
  on one shared `GrpcServer`.
- Services must not receive a `GrpcServer` in `initialize()`; the wiring is owned by
  `src/index.ts`, mirroring how REST routes are collected today.
- gRPC handlers delegate directly to the existing `QueueService` / `TaskService` business
  logic. No new storage layer or domain logic is introduced.
- `GrpcRestBridge` (`src/core/gateway/grpc-rest-bridge.ts`) is deleted. It was the
  transcoding paradigm we are not using.
- Cloud Tasks unary RPCs are implemented first. Pub/Sub gRPC is a follow-up.
- IAM methods (`GetIamPolicy`, `SetIamPolicy`, `TestIamPermissions`) are registered as
  `UNIMPLEMENTED` stubs because they are part of the `google.cloud.tasks.v2.CloudTasks`
  service proto and client libraries may call them.
- No TLS. Insecure credentials, localhost only.

## Rationale

- **Direct proto loading** keeps the implementation close to what real GCP serves and
  avoids maintaining a hand-rolled descriptor.
- **`google-proto-files`** is the single canonical source for Google API protos in the
  Node.js ecosystem; pointing at internal build artefacts of `@google-cloud/tasks` would
  couple us to that package's build layout.
- **Second port** is the simplest approach to coexist with the existing HTTP server without
  HTTP/2 negotiation complexity.
- **`getGrpcServices()` pattern** mirrors `getRoutes()` and keeps each service self-contained
  without inventing a new framework layer.

## Alternatives Considered

- **gRPC-REST transcoding via `GrpcRestBridge`**: Tested and removed. The extra translation
  layer obscured errors and did not produce the correct wire-format responses expected by
  `google-gax`.
- **Single port with HTTP/2 + content-type routing**: Bun's `serve()` does not expose the
  HTTP/2 framing needed for gRPC, so a second port via `@grpc/grpc-js` is required.
- **`grpc-gateway` or Envoy sidecar**: Adds infrastructure complexity inappropriate for a
  local dev emulator.

## Consequences

- A second port is opened when the emulator starts. Users who firewall loopback ports need
  to allow 8766 (or whatever `grpcPort` is configured to).
- Cloud Tasks client library tests can run without `fallback: 'rest'`, exercising the real
  gRPC code path.
- Pub/Sub, Scheduler, and other services that want a gRPC surface must add
  `getGrpcServices()` in a follow-up PR.
- `GrpcServer` stays and gains production use. `GrpcRestBridge` is gone.
