# ADR-011: Terraform Validation Harness

## Status

Accepted

## Context

Kinglet emulates GCP services that Terraform providers configure via the Google provider.
Regression coverage previously relied on ad hoc shell scripts. As more services gained
fixtures (Pub/Sub, KMS, Workflows, Tasks, Scheduler), we needed a repeatable apply/plan/destroy
loop that:

- Runs one case at a time during TDD (`bun test terraform/terraform.test.ts -t "tasks"`)
- Shares a manifest so CI and local runs exercise the same targets
- Stays out of the fast unit-test job (Terraform binary, Docker kinglet, multi-minute runtime)

## Decision

Introduce a manifest-driven Terraform validation harness under `terraform/`:

1. **`manifest.ts`** declares validation cases (services, Terraform targets, descriptions).
2. **`harness.ts`** starts kinglet (Bun or Docker), runs init/apply/plan/destroy, and cleans up
   temp state plus spawned processes on success, failure, or signals.
3. **`terraform.test.ts`** maps manifest entries to Bun tests with explicit assertions.
4. **CI** runs the suite in a dedicated `terraform-e2e` job with Terraform and Docker available.
5. **Default test discovery** excludes the harness via `bunfig.toml` `include` and scoped
   `test:coverage:check` paths; developers invoke `bun run test:terraform` explicitly.

## Rationale

- Keeps Terraform e2e out of `bun test` / coverage gates while still providing a typed TDD entry
  point co-located with fixtures.
- Manifest-driven cases avoid duplicating service lists between shell scripts and tests.
- A separate CI job mirrors the existing e2e split documented in ADR-002's successor testing
  practice (pure Bun unit tests vs. tooling-heavy suites).

## Alternatives Considered

- **Shell-only harness** — harder to filter single cases, no type checking, weaker assertion story.
- **Include terraform tests in default `bun test`** — fails on machines without Terraform and
  slows every CI unit-test run.
- **GitHub Actions matrix per service** — more YAML duplication than a manifest inside the repo.

## Consequences

- Contributors add fixtures by extending the manifest and `.tf` files, then run a filtered Bun test.
- The harness must clean up kinglet processes, Docker containers, and temp dirs on all exit paths.
- Bun version differences around `pathIgnorePatterns` require keeping terraform out of ignore lists
  that would suppress explicitly requested paths on Bun 1.4+.
