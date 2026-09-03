# AGENTS.md

Guidance for AI coding agents working in this repository. `CLAUDE.md` is a symlink to this
file, so Claude Code, Cursor, and any other agent that reads `AGENTS.md` get the same rules.

**Human contributors should read [CONTRIBUTING.md](CONTRIBUTING.md) instead.** It is the
single source of truth for scope, the API-fidelity contract, the quality bar, and the PR
process. This file covers agent-specific mechanics only and defers to CONTRIBUTING.md on
everything it also describes.

Cursor reads this file natively. Cursor Bugbot does **not** — it reads only
`.cursor/BUGBOT.md`, which carries the review-time versions of these rules.

## kinglet

A high-performance local emulation environment for Google Cloud Platform services, built with Bun and TypeScript. This project provides local development and testing capabilities for GCP services including Pub/Sub, Cloud Scheduler, Cloud Tasks, and Secret Manager.

## Commands

### Development
- `bun run dev` - Start development server with watch mode
- `bun run start` - Run the production server
- `bun run build` - Build for production
- `bun run healthcheck` - Run health check script

### Testing
- `bun test` - Run unit and integration tests (not e2e — see Testing Standards below)
- `bun test --watch` - Run tests in watch mode
- `bun test --coverage` - Run tests with coverage report
- `bun run test:coverage:check` - Coverage report plus the 80% aggregate gate CI enforces
- `bun run test:e2e` - Run the end-to-end suite
- `bun run test:terraform` - Run all Terraform validation cases (manifest-driven, one test per service; not part of `bun test`)
- `bun run test:terraform:case -- <id>` - Run a single case, e.g. `bun run test:terraform:case -- tasks` (TDD loop)
- `bun test terraform/terraform.test.ts -t "<id>"` - Same single-case filter without npm script

### Code Quality
- `bun run lint` - Run Biome linter (+ tsc + knip)
- `bun run lint:fix` - Run Biome linter with auto-fix
- `bun run format` - Format code with Biome
- `bun run format:check` - Check formatting without writing
- `bun run docs:generate` - Regenerate all docs (fetches Google discovery documents live)
- `bun run docs:generate:api` - Regenerate API reference route tables only
- `bun run docs:generate:compatibility` - Regenerate compatibility matrix (live discovery fetch)
- `bun run docs:check` - Verify API reference docs match the codebase (runs on pre-push and CI)

## Architecture

The codebase follows a modular service-oriented architecture:

### Core Structure
- `src/index.ts` - Main application entry point with graceful shutdown handling
- `src/core/` - Core framework components (gateway, discovery, storage)
- `src/services/` - GCP service emulations (pubsub, scheduler, tasks, secrets)
- `src/config/` - Configuration management with Zod schema validation
- `src/shared/` - Shared utilities, types, and middleware

### Service Emulations
- **Pub/Sub** (`src/services/pubsub/`) - Message queuing and streaming
- **Cloud Scheduler** (`src/services/scheduler/`) - Cron job scheduling
- **Cloud Tasks** (`src/services/tasks/`) - Asynchronous task execution
- **Secret Manager** (`src/services/secrets/`) - Secret storage and management

### Path Aliases
Use TypeScript path aliases for clean imports:
- `@/*` - src root
- `@/core/*` - core framework components
- `@/services/*` - service implementations
- `@/shared/*` - shared utilities
- `@/config` - configuration module

## Planning

For non-trivial work, do not start implementation until the caller has seen a short plan
and answered any questions it raised. The plan should state what will change, what will
not (known gaps and YAGNI cuts), which tests come first, and any fidelity unknowns.

Non-trivial includes: new or changed emulated endpoints, fidelity fixes that span more
than one layer, a new service, storage/routing/protocol changes, and anything with more
than one reasonable design. Docs, CI, lint/format config, and other infrastructure can
skip this gate.

If the caller already answered the design questions, do not re-ask — proceed.

## Bun Runtime

This project uses Bun as the primary runtime (see docs/adrs/001-bun-runtime-choice.md). Key preferences:

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install`
- Use `bun run <script>` instead of `npm run <script>`
- Bun automatically loads .env files

### Bun APIs
- `Bun.serve()` for HTTP servers (don't use Express)
- `bun:sqlite` for SQLite (don't use better-sqlite3)
- `WebSocket` is built-in (don't use ws)
- `Bun.file` for file operations (prefer over node:fs)

### TypeScript Types
When using TypeScript with Bun runtime, avoid Node.js-specific types:
- Use `ReturnType<typeof setInterval>` or `ReturnType<typeof setTimeout>` for timers (not `NodeJS.Timeout` or `number` with double casts)
- Use standard Web API types (not Node.js equivalents)
- Use `Bun.*` types for Bun-specific APIs
- Prefer global JavaScript types over `NodeJS.*` namespace types
- Use `unknown` instead of `any` type in TypeScript
- Avoid non-null assertions (`!`) - prefer clear type definitions or optional chaining (`?`)

## Testing

**PURE BUN TESTING ONLY** - We use Bun's built-in test runner exclusively (see ADR-002):

```ts
import { test, expect, mock, spyOn } from "bun:test";

test("example test", () => {
  expect(1).toBe(1);
});

// Use mock() instead of jest.fn()
const mockFunction = mock(() => 'mocked result');

// Use spyOn for function spying
const spy = spyOn(object, 'method');
```

### Testing Standards
- **Always use `mock()` instead of `jest.fn()`** - Never import `jest` from `bun:test`
- **Use pure Bun primitives** - `mock()`, `spyOn()`, etc.
- **`bun test` does not run e2e or terraform in CI** - `test:coverage:check` scopes coverage runs to `src/`, `test-utils/`, and `scripts/` because Bun 1.3.4 ignores bunfig `pathIgnorePatterns`. Those suites run via `bun run test:e2e` / `bun run test:terraform` and have their own CI jobs
- **Co-locate tests** with source files for easier discovery
- **Reset mocks properly** - Use `mockFunction.mockReset()` instead of `jest.clearAllMocks()`

### Test-driven development

For non-trivial, non-infrastructure changes, write the tests first:

1. Add the unit and/or e2e tests that describe the new behaviour. Run them and confirm they
   fail for the right reason (missing endpoint, wrong status, unimplemented method) — not
   because of a typo in the test.
2. Implement until those tests pass. Do not expand the change past what the tests require.

Which suite:

- **Unit** (`bun test`, co-located `*.test.ts`) for internal behaviour — repositories,
  services, parsers, error mapping.
- **E2E** (`bun run test:e2e`) when the HTTP/API surface changes — new or changed endpoint,
  status, envelope, or resource name.
- **Both** only when both layers change.

Skip TDD for docs, CI, lint/format config, generated docs, and other infrastructure. A
separate failing-test commit is not required; running red, then implementing, is.

### Test Assertion Guidelines
- **Never use `expect(true).toBe(false)` as an unreachable sentinel.** Use `rejects` for async error testing:
```ts
// BAD - fragile, swallows unexpected errors
try {
  await service.doThing();
  expect(true).toBe(false);
} catch (err) {
  expect(err).toBeInstanceOf(MyError);
  expect((err as MyError).code).toBe('NOT_FOUND');
}

// GOOD - clean, type-safe, fails clearly
const promise = service.doThing();
await expect(promise).rejects.toBeInstanceOf(MyError);
await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
```
- **Prefer specific assertions over vague ones.** Use `toBeTypeOf('string')` instead of `toBeDefined()` when you know the expected type. Use exact value matches (`toBe`, `toEqual`) when the value is deterministic.
- **Every test must have at least one `expect()` call** that validates observable behavior.
- **Do not write comments that restate assertions** (e.g., `// Task should be deleted` right before `expect(task).toBeNull()`). The test name and assertion are self-documenting.
- **Never wrap assertions inside `if` blocks.** Conditional assertions silently pass when the condition is false, making the test unable to catch regressions. Assert the precondition directly instead:
```ts
// BAD - silently skips if status isn't 200
if (resp.status === 200) {
  const data = await resp.json();
  expect(data.field).toBe('value');
}

// GOOD - fails explicitly if precondition isn't met
expect(resp.status).toBe(200);
const data = await resp.json();
expect(data.field).toBe('value');
```

Test environment is configured to use error-level logging and test NODE_ENV.

## Architectural Decision Records

When implementing a feature that introduces a **large-scale architectural change**, document the decision in `docs/adrs/` following the existing ADR format (see ADR-001 through ADR-004 for examples). An ADR is warranted when:

- Adding or replacing a core framework component (storage, routing, protocol support)
- Changing how services are structured, registered, or communicate
- Introducing a new external dependency that affects the runtime or build
- Modifying the persistence, caching, or data model strategy
- Changing deployment, containerization, or CI/CD architecture

Each ADR should include: Status, Context, Decision, Rationale, Alternatives Considered, and Consequences. Number sequentially (e.g., `005-descriptive-name.md`).

## Commit sign-off

This is an open-source project under the DCO. Every commit must be signed off under the identity of the **human who requested the work** — the sign-off certifies that a person reviewed the change and stands behind it.

You may run `git commit -s` on that human's behalf, but only after:

- **Asking them and getting an explicit sign-off.** Do not assume approval — ask the human who requested the work to confirm they have reviewed the change and want their name on it. Their sign-off is the whole point; applying it without asking defeats it.
- **Stamping their identity, not yours.** `git commit -s` derives the `Signed-off-by` name and email straight from git config, so make sure `user.name`/`user.email` are the human's before committing. CI rejects any sign-off carrying a coding-agent identity (Cursor, Claude, Copilot, Devin, …), so signing under your own identity fails the `DCO sign-off` job.

Credit yourself with a `Co-authored-by:` trailer — agent assistance is expected here and that trailer is welcome (it is deliberately not checked).

See CONTRIBUTING.md → Developer Certificate of Origin (DCO) for the full contract.

## YAGNI / over-building

Adapted from [ponytail](https://github.com/DietrichGebert/ponytail) (MIT). Same bar as
`.cursor/BUGBOT.md` (ponytail **full**): stop at the first rung that holds. Be lazy about
the solution, never about fidelity, tests, or required structure.

Do not:

- Add something with no caller, no discovery-document requirement, and no stated gap
  (speculative helpers, config for a value that never changes, scaffolding "for later")
- Reimplement a helper, type, or pattern that already lives in this repo — look in
  `@/shared` and the service under edit first
- Hand-roll what Bun, the Web APIs, or an already-installed dependency already do, or add
  a package for a few lines of existing capability
- Introduce an unrequested abstraction: an interface with one implementation, a factory
  for one product, a wrapper class around a one-liner
- Add an extra layer inside a small service instead of the established
  `types` / `repository` / `service` / `handlers` / `index` split (or, for growth, the
  per-resource triples in `src/services/pubsub/`)

These look like extra code and are required — do not cut them:

- The service file split, the four registration sites, and `stop()` in `shutdown()`
- Discovery-required surface: pagination, the error envelope, resource-name parsers,
  field names and status codes that match real GCP
- Co-located tests, error-path tests, and the coverage bar
- An explicit "not implemented / known gaps" list in the PR or in code
- An ADR when the change actually warrants one

## Prose budget

The diff already shows *what* changed. Do not narrate it. Leave only what a maintainer
cannot infer: why, trade-offs, and known limits.

- PR free prose ("What does this change?", "Why?", "Anything else?") — at most about
  **three paragraphs**. Do not walk the file list, restate template checkboxes, or tour
  the feature.
- A commit body is optional. If you write one, add *why*, a trade-off, or how it was
  verified. Do not repeat the subject or list files.
- Review comments: the finding, or silence. No recap or preamble.

Allowed: up to about three paragraphs on a GCP quirk, a known limit, an honest unknown
("could not determine what real GCP does when X"), or a trade-off the diff cannot show.
Checklists, the discovery-document URL, "not implemented" lists, commands actually run,
DCO sign-off, and AI disclosure are the template, not padding.

## Guidelines

- When implementing a task, be sure to first read through the ADRs that exist in docs/adrs so you understand the historical decisions that have been made.
- **Sign off every commit** with `git commit -s` (DCO is enforced in CI). In a local clone, `git config format.signoff true` adds the sign-off automatically.
- Co-locate tests with source files for easier discovery
- Try to use `bunx` over `npx` wherever possible
- When moving code to a new location in response to feedback from the user, do not leave useless comments such as "// BEGIN is now called explicitly via begin() method".
- Avoid non-null assertions (`!`) - they trigger Biome warnings. Use type guards, optional chaining (`?.`), or refine type definitions instead
- Avoid empty interface definitions - use `Record<never, never>` for truly empty types or union types with specific values instead. Empty interfaces provide no type safety and can be extended unexpectedly
- For readability, when writing Typescript code, add a padding line between key statements to increase legibility. So instead of this:     const listeners = this.eventListeners.get(event);
    if (!listeners) {
      throw new Error('Event listeners set should exist after initialization');
    }
, do this:     const listeners = this.eventListeners.get(event);

    if (!listeners) {
      throw new Error('Event listeners set should exist after initialization');
    }
- When writing typescript code, use substring() instead of the deprecated substr() method.
- When importing types in Typescript, they must be imported using a type-only import. So instead of `import { StorageConfig } from '../types'`, do `import type { StorageConfig } from '../types'`.
- Prefer static imports over dynamic `await import()` for readability. Only use dynamic imports when there is a genuine need (conditional loading, circular dependency breaking, etc.).
- When checking if a numeric variable is present, use `value != null` instead of a truthy check (`value ?` or `if (value)`), since `0` is a valid number but falsy.
