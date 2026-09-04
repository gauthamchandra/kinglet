# Architectural Decision Records

Each ADR records one significant decision: the context that forced it, what was decided, what
was rejected, and what it cost. They are written once and then left alone. When a decision is
overturned, the old ADR is marked **Superseded** and a new one is written — the original text
is not edited, because the reasoning that was true at the time is the whole point of the record.

| ADR | Title | Status |
|---|---|---|
| [001](001-bun-runtime-choice.md) | Choice of Bun Runtime | Accepted |
| [002](002-dual-testing-framework-approach.md) | Pure Bun Testing Framework Approach | Superseded |
| [003](003-hybrid-storage-architecture.md) | Hybrid Storage Architecture | Accepted |
| [004](004-modular-service-gateway.md) | Modular Service Gateway Pattern | Accepted |
| [005](005-pubsub-message-fanout-delivery.md) | Pub/Sub Message Fan-Out and Delivery | Accepted |
| [006](006-open-source-licensing-and-governance.md) | Open-Source Licensing and Governance | Accepted |
| [007](007-memorystore-valkey-data-plane.md) | Memorystore for Valkey Data Plane | Accepted |
| [008](008-kms-crypto-emulation.md) | Cloud KMS Crypto Emulation | Accepted |
| [009](009-shared-route-namespace.md) | Shared Route Namespace Across Services | Accepted |
| [010](010-sqlite-schema-synchronization.md) | SQLite Schema Synchronization | Accepted |
| [011](011-terraform-validation-harness.md) | Terraform Validation Harness | Accepted |
| [012](012-cloud-armor-emulation.md) | Cloud Armor Security Policy Emulation | Proposed |
| [013](013-cloudsql-pglite-data-plane.md) | Cloud SQL Data Plane on PGlite | Accepted |

## A note on the project's former name

ADRs 001–005 were written while this project was called **"LocalStack GCP Emulator"** and refer
to it by that name throughout. The project was renamed to **kinglet** before it was open-sourced,
because the original name collided with [LocalStack](https://localstack.cloud), an unrelated
commercial product and trademark held by LocalStack GmbH. This project has never been affiliated
with, endorsed by, or derived from LocalStack.

The ADR bodies were deliberately left unedited. Read "LocalStack GCP Emulator" in ADRs 001–005
as "kinglet". See [ADR-006](006-open-source-licensing-and-governance.md) for the rename and
licensing rationale.

## When to write a new ADR

Write one when a change is **large-scale and architectural** — see
[CONTRIBUTING.md](../../CONTRIBUTING.md) for the full trigger list. In short:

- Adding or replacing a core framework component (storage, routing, protocol support)
- Changing how services are structured, registered, or communicate
- Introducing a dependency that affects the runtime or build
- Changing the persistence, caching, or data-model strategy
- Changing deployment, containerization, or CI/CD architecture

Adding a new GCP service emulation does **not** warrant an ADR — that is routine work the
existing architecture already anticipates. See
[docs/adding-a-service.md](../adding-a-service.md).

Number sequentially and include: Status, Context, Decision, Rationale, Alternatives Considered,
Consequences.
