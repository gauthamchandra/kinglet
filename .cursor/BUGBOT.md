# Bugbot review rules — kinglet

kinglet emulates Google Cloud Platform APIs for local development and testing. The whole
value of the project is that code written against kinglet behaves the same way against real
GCP. Review with that in mind: an endpoint that *looks* right but doesn't match the real API
is worse than a missing one, because it fails silently in someone else's integration tests
months later.

Full context: [CONTRIBUTING.md](../CONTRIBUTING.md), [AGENTS.md](../AGENTS.md), and
[docs/adding-a-service.md](../docs/adding-a-service.md). Service-specific rules live in
`src/services/.cursor/BUGBOT.md`.

---

## Flag these

### Runtime — Bun, not Node

This project is Bun-first ([ADR-001](../docs/adrs/001-bun-runtime-choice.md)). Anything that
reintroduces the Node toolchain is a finding.

| Don't | Use |
|---|---|
| `node script.ts`, `ts-node` | `bun script.ts` |
| `npm` / `pnpm` / `yarn` install | `bun install` |
| `npm run <script>` | `bun run <script>` |
| `npx` | `bunx` |
| `jest` / `vitest` | `bun test` |
| `webpack` / `esbuild` / `vite` | `bun build` |
| Express | `Bun.serve()` |
| `better-sqlite3` | `bun:sqlite` |
| `ws` | the built-in global `WebSocket` |
| `node:fs` | `Bun.file` |
| `dotenv` | nothing — Bun loads `.env` automatically |

Also flag `NodeJS.*` namespace types. Use `ReturnType<typeof setTimeout>` /
`ReturnType<typeof setInterval>` for timer handles (not `NodeJS.Timeout`, and not `number`
via a double cast), `Bun.*` types for Bun APIs, and standard Web API types everywhere else.

### Imports

- **Relative paths crossing module boundaries** (`../../core/storage/manager.ts`). Use the
  configured aliases: `@/*` (src root), `@/core/*`, `@/services/*`, `@/shared/*`, `@/config`.
  Relative imports *within* a service directory (`./types.ts`) are correct and expected.
- **Type imports that aren't type-only**: `import type { StorageConfig } from './types.ts'`.
- **Dynamic `await import()`** without a genuine reason — conditional loading or breaking a
  cycle. Prefer static imports.

### Type safety

- **`any` anywhere.** Use `unknown` and narrow, or write a concrete type.
- **Non-null assertions (`!`).** Use a type guard, optional chaining, or fix the type. These
  also trip Biome warnings.
- Empty interfaces. Use `Record<never, never>` or a union of specific values — an empty
  interface provides no type safety and can be extended unexpectedly.
- `substr()` — deprecated, use `substring()`.
- Truthiness checks on numbers (`if (count)`). `0` is valid and falsy; use `count != null`.

### Tests

Tests are the main defence against silently-wrong emulation, so weak tests are a substantive
finding, not a nitpick ([ADR-002](../docs/adrs/002-dual-testing-framework-approach.md)).

- **`jest` imported from `bun:test`**, or `jest.fn()` / `jest.clearAllMocks()`. Use `mock()`
  and `mockFn.mockReset()`.
- **A test with no `expect()`**, or one that only asserts a mock was called without checking
  observable behaviour.
- **`expect(true).toBe(false)` as an unreachable sentinel.** Use
  `await expect(promise).rejects.toBeInstanceOf(...)` and
  `await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND')`.
- **Assertions inside `if` blocks.** These silently pass when the condition is false, so they
  cannot catch the regression they were written for. Assert the precondition directly:
  `expect(resp.status).toBe(200)` and *then* the body.
- Vague assertions (`toBeDefined()`) where the expected type or exact value is known — prefer
  `toBeTypeOf('string')`, `toBe`, `toEqual`.
- New source files without a co-located `*.test.ts`. Tests sit next to their source, not in a
  separate `__tests__/` tree.
- Error paths left untested — only happy paths covered.
- New tests added under `e2e/` without awareness that `bun test` does **not** run them:
  `bunfig.toml`'s `include` limits it to `src/**` and `test-utils/**`. The e2e suite runs via
  `bun run test:e2e` in its own CI job.

### Architectural decisions

An ADR in `docs/adrs/` is expected when a PR adds or replaces a core framework component
(storage, routing, protocol support), changes how services are structured or communicate,
introduces a dependency affecting the runtime or build, changes the persistence/caching/data
model, or changes deployment or CI/CD architecture. Flag such a PR if no ADR accompanies it.

Adding a new GCP service emulation does **not** need an ADR — that is routine work the
existing architecture anticipates.

### Readability

- **No blank line between logically distinct statements.** This codebase is deliberately
  airy — a guard clause should be separated from the assignment above it:

  ```ts
  const listeners = this.eventListeners.get(event);

  if (!listeners) {
    throw new Error('Event listeners set should exist after initialization');
  }
  ```

- Comments that restate the code, section dividers (`// --- Helpers ---`), or migration
  breadcrumbs (`// BEGIN is now called explicitly via begin()`, `// fix for #123`). That
  context belongs in the commit message — comments rot when code moves, history doesn't.
- Comments restating an assertion (`// task should be deleted` above `expect(task).toBeNull()`).

### Hygiene

- New entries in `knip.json`'s `ignoreIssues` without justification in the PR. That list is
  accepted debt, not a pressure valve for making the build pass.
- `TODO` / `FIXME` / `HACK` without a tracking issue reference (`// TODO(#42): …`).
- Secrets, credentials, tokens, or absolute paths containing a username.
- Logging of request or response bodies that could carry user data.

---

## Don't flag

Noise here costs more than a missed nitpick — these are all deliberate:

- **Missing license headers.** Apache-2.0, and this project deliberately does not use per-file
  headers.
- **Absence of authentication, rate limiting, or encryption at rest.** kinglet is a dev tool
  and explicitly not a security boundary — see [SECURITY.md](../SECURITY.md).
- **Formatting.** Biome owns it and CI enforces it.
- **ADRs 001–005 using the project's former name.** Deliberate; see
  [docs/adrs/README.md](../docs/adrs/README.md).
- **`src/services/secrets/` being a bare stub.** Known and documented as unimplemented.
- **Hardcoded `kinglet-project` / `kinglet@kinglet-project.iam.gserviceaccount.com`.** These
  are intentional mock defaults, not credentials.
