# Contributing to kinglet

Thanks for considering a contribution. This document is the single source of truth for what
this project accepts and what "done" looks like. `AGENTS.md` (and its `CLAUDE.md` symlink)
defer to this file on anything they both describe.

Please read [What we accept](#what-we-accept) before writing code. It is short, and it is the
difference between a merged PR and a closed one.

---

## Support expectations

**kinglet has one maintainer, and this is a nights-and-weekends project.** There is no
response-time commitment — not for issues, not for pull requests, not for security reports.

That is not an invitation to expect nothing. It is a statement so you can decide up front
whether that trade is acceptable to you. Concretely:

- A PR may sit for weeks before anyone looks at it.
- A well-scoped PR that follows this document will be reviewed far sooner than a large one
  that does not, because it costs less to review.
- **Opening an issue before writing code is the single best way to avoid wasted work.** If
  your change is one this project won't take, it is much cheaper to learn that in an issue.

If you need guaranteed turnaround, fork it. Apache-2.0 explicitly permits that, and no
hard feelings.

---

## What we accept

kinglet emulates Google Cloud Platform APIs for local development and testing. Contributions
that make the emulation more complete or more faithful are welcome.

### Welcome

| Type | Issue first? |
|---|---|
| **New GCP service emulations** (KMS, BigQuery, Firestore, …) | **Yes — required.** Open a *New service proposal*. |
| **Filling API gaps** — endpoints missing from an existing service | **Yes — required.** Open an *API gap* issue. |
| **Bug fixes and fidelity fixes** — behaviour that differs from real GCP | Not required for small fixes. Welcome for large ones. |
| **Docs, examples, client-library integration guides** | Not required. |

### Not accepted

These will be closed, and it is nothing personal — they are outside what this project is for:

- **Features real GCP does not have.** kinglet reproduces Google's API surface. If GCP
  doesn't do it, kinglet doesn't do it. A convenience endpoint that no `@google-cloud/*`
  client would ever call is out of scope regardless of how useful it seems.
- **Emulation of non-GCP services.** AWS, Azure, and everything else are out of scope.
- **Production use-cases.** kinglet is a development and testing tool. It is not hardened,
  not authenticated, and not intended to hold real data. Contributions premised on
  production deployment will be declined.
- **Swapping out core dependencies or the runtime.** Bun, SQLite, Biome, and the gateway
  architecture are settled decisions with recorded rationale in
  [`docs/adrs/`](docs/adrs/). Reopening one requires a new ADR arguing against the existing
  reasoning, not a PR that swaps the dependency.
- **Broad reformatting, renaming, or "cleanup" sweeps.** These produce enormous diffs, carry
  real regression risk, and are almost impossible to review. Biome already governs
  formatting.
- **Dependency bumps by hand.** Renovate handles these.

---

## The fidelity contract

**This is the most important rule in this document.**

kinglet exists so that code written against `@google-cloud/*` client libraries behaves the
same way locally as it does against real GCP. An endpoint that *looks* right but returns a
misspelled field, the wrong HTTP status, or a response envelope no real client accepts is
worse than no endpoint at all — it fails silently, in someone else's integration tests,
months later.

So emulated behaviour is not a judgement call. It is a lookup.

### What is required

Every PR that adds or changes an emulated endpoint must:

1. **Cite the official Google Discovery Document** for that API in the PR description.
   The registry of documents this project tracks is
   [`discovery-document-registry.json`](discovery-document-registry.json) — for example,
   Cloud Scheduler is
   `https://cloudscheduler.googleapis.com/$discovery/rest?version=v1`.
2. **Match the real API exactly** on:
   - Request and response **field names** (including casing — GCP is `camelCase` on REST)
   - **HTTP status codes**, including error cases
   - **Error response shape** — `{ error: { code, message, status, details? } }`
   - **Resource name formats** — e.g. `projects/{project}/locations/{location}/jobs/{job}`
   - **Pagination** semantics (`pageSize`, `pageToken`, `nextPageToken`)
3. **State explicitly what is not implemented.** Partial support is fine and often correct —
   silently partial support is not. Say so in the PR and in code.

### When the real API's behaviour is unclear

Discovery Documents describe shapes, not always semantics. When behaviour is genuinely
ambiguous:

- Say so in the PR. An honest "I could not determine what real GCP does when X" is a
  perfectly good contribution and is far more useful than a confident guess.
- Prefer the behaviour the official client library expects — it is the actual consumer.
- Do not invent an error code. If you don't know, return the closest documented one and flag it.

### Tooling

The repo ships a [compatibility-audit skill](.claude/skills/compatibility-audit/SKILL.md)
that diffs an implementation against its official discovery document. If you use Claude Code,
run it on your service before opening the PR. It is not a substitute for reading the
discovery document yourself.

---

## AI-assisted contributions

**AI-assisted contributions are welcome and must be disclosed.**

This project ships an `AGENTS.md` and a tuned `gcp-specialist` subagent. Using agents here is
expected, not frowned upon. What matters is not how code was produced — it is whether a human
understood it before submitting it.

### The rules

1. **Disclose it.** The PR template has a checkbox. Tick it if an AI tool wrote or
   substantially shaped any part of the change. "Substantially shaped" includes: generated the
   implementation, generated the tests, or generated the PR description.
2. **You own every line.** Your DCO sign-off (below) is an assertion that you have *read* and
   *understood* the code you are submitting and that you stand behind it — regardless of what
   produced it. Sign-off is not a formality here; it is the whole point.
3. **You must be able to explain it.** If a reviewer asks why a function does what it does and
   the honest answer is "the model wrote it," the PR will be closed. This is the actual bar.

### Pre-approved permissions

If you use Claude Code, the repo ships a shared allowlist at
[`.claude/settings.json`](.claude/settings.json) so you aren't prompted for every routine
command. It covers `bun install` / `test` / the `package.json` scripts, `bunx` for
biome/tsc/knip/commitlint, read-only git plus `add`/`commit`, and `WebFetch` restricted to
`googleapis.com` (for pulling discovery documents).

It deliberately does **not** blanket-approve `Bash(bun:*)`. That would cover `bun -e '<any
JavaScript>'`, which is arbitrary code execution — a reasonable thing to grant yourself, but
not something a shared file should grant every contributor by default. The same goes for
`git push`: it's the one git operation that leaves your machine, so it stays a prompt.

Anything else you want auto-approved goes in `.claude/settings.local.json`, which is
gitignored and personal to you. Please don't commit it — it accumulates machine-specific
paths and one-off debugging commands.

### What gets closed quickly

- Undisclosed generated code that fails review.
- PRs whose description does not match what the diff does.
- Tests that assert nothing meaningful (see [Quality bar](#quality-bar)) — the most common
  failure mode of generated test suites.
- Endpoints that were never checked against a discovery document.

Disclosing AI assistance will **never** count against a PR. Failing to disclose it will.

---

## Developer Certificate of Origin (DCO)

Every commit must be signed off. This project uses the
[DCO](https://developercertificate.org/) rather than a CLA — there is no copyright
assignment, and you keep ownership of your work.

```sh
git commit -s -m "feat(kms): add CryptoKey create and get endpoints"
```

That appends a line to your commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

By signing off, you certify the [DCO](https://developercertificate.org/) — that you wrote the
code or otherwise have the right to submit it under Apache-2.0 — **and**, for this project
specifically, that you have read and stand behind every line of it.

Forgot to sign off? Amend the last commit:

```sh
git commit --amend -s --no-edit
```

Or, for a whole branch:

```sh
git rebase --signoff main
```

The **DCO sign-off** job in CI checks every commit in the PR and names the exact command to
run if one is missing. Commits authored by bots (release-please, the weekly compatibility-docs
sync) are skipped — an app cannot certify the DCO on anyone's behalf.

**The sign-off must carry a human's identity.** For the same reason a bot can't certify the
DCO, a coding agent can't certify it under its own name — the sign-off asserts that a person
reviewed the code and stands behind it. CI rejects any `Signed-off-by` line carrying a known
agent identity (Cursor, Claude, Copilot, Devin, …). An agent *may* run `git commit -s` on your
behalf, but only after you have reviewed the change and given it your sign-off — and with git
configured to your name and email, so the trailer derives straight from your git config and is
genuinely yours. Crediting the agent is still welcome — put it in a `Co-authored-by` trailer,
which is *not* checked. Using agents here is expected (see [AI-assisted
contributions](#ai-assisted-contributions)); putting a sign-off on code no human reviewed is
the line.

---

## Quality bar

CI enforces most of this. It is written down so you find out before you push, not after.

### Tests

Tests are not optional, and coverage is currently **94% functions / 96% lines**. New code is
expected to hold that line; CI fails below **80%**.

- **Co-locate tests** — `foo.test.ts` next to `foo.ts`. Not a separate `__tests__/` tree.
- **Pure Bun test runner only** — `import { test, expect, mock, spyOn } from 'bun:test'`.
  Never import `jest`. Use `mock()`, not `jest.fn()`. Use `mockFn.mockReset()`, not
  `jest.clearAllMocks()`. See [ADR-002](docs/adrs/002-dual-testing-framework-approach.md).
- **Every test needs at least one `expect()`** that validates observable behaviour.
- **Never use `expect(true).toBe(false)` as an unreachable sentinel.** Use `rejects`:

  ```ts
  // BAD — fragile, swallows unexpected errors
  try {
    await service.doThing();
    expect(true).toBe(false);
  } catch (err) {
    expect(err).toBeInstanceOf(MyError);
  }

  // GOOD — clean, type-safe, fails clearly
  const promise = service.doThing();
  await expect(promise).rejects.toBeInstanceOf(MyError);
  await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  ```

- **Never wrap assertions in `if` blocks.** A conditional assertion silently passes when the
  condition is false, which means it cannot catch the regression it was written for. Assert
  the precondition directly:

  ```ts
  // BAD — silently skips if the status isn't 200
  if (resp.status === 200) {
    expect((await resp.json()).field).toBe('value');
  }

  // GOOD — fails explicitly
  expect(resp.status).toBe(200);
  expect((await resp.json()).field).toBe('value');
  ```

- **Prefer specific assertions.** `toBeTypeOf('string')` over `toBeDefined()`. Exact
  `toBe`/`toEqual` when the value is deterministic.
- **Don't write comments that restate assertions.** `// task should be deleted` above
  `expect(task).toBeNull()` adds nothing.

### TypeScript

- **No `any`.** Use `unknown` for genuinely untyped data, then narrow.
- **No non-null assertions (`!`).** Use type guards, optional chaining, or fix the type.
- **Type-only imports for types**: `import type { StorageConfig } from '../types.ts'`.
- **Prefer static imports.** Use `await import()` only for genuine conditional loading or to
  break a cycle.
- **`value != null`, not truthiness, for numbers** — `0` is valid and falsy.
- **`substring()`, never the deprecated `substr()`.**
- **No empty interfaces.** Use `Record<never, never>` or a union of specific values.
- **Use `ReturnType<typeof setInterval>`** for timer handles, not `NodeJS.Timeout`.
- **Add a blank line between logically distinct statements.** This codebase is deliberately
  airy; match it.

### Bun, not Node

See [ADR-001](docs/adrs/001-bun-runtime-choice.md). Use `Bun.serve()` (not Express),
`bun:sqlite` (not better-sqlite3), the built-in `WebSocket` (not `ws`), and `Bun.file` over
`node:fs`. Prefer `bunx` to `npx`.

### Lint must be clean

`bun run lint` runs three tools — `tsc --noEmit`, `biome check .`, and `knip`. All three
must pass with zero errors *and* zero warnings. Biome covers the whole repo, not just `src/`,
so `e2e/`, `scripts/` and `test-utils/` are held to the same bar.

Import order is enforced repo-wide by Biome's `organizeImports` assist, so it is deterministic
rather than a matter of taste — `bun run lint:fix` rewrites it for you.

**Do not add entries to `knip.json`'s `ignoreIssues` to make the build pass.** That list is a
record of accepted debt, not a pressure valve. If your change requires a new suppression, say
why in the PR and expect to discuss it.

### Comments

Default to **no comment**. Comments are for context that is *not derivable from the code*:

- A vendor quirk — "GCP returns 409 here, not 400, even though the request is malformed"
- An intentionally-absent case, and why
- A cross-cutting contract a future reader would otherwise break

Do **not** write comments that restate the next line, section dividers (`// --- Helpers ---`),
or changelog comments (`// fix for #123`). That last one belongs in the commit message —
comments rot when code moves; git history doesn't.

`TODO`/`FIXME`/`HACK` are allowed only with a tracking issue: `// TODO(#42): …`.

---

## Local development

Requires [Bun](https://bun.sh) ≥ 1.1 (this repo pins **1.3.4** in `.tool-versions`).

```sh
bun install                   # install dependencies
bun run dev                   # dev server, watch mode
bun test                      # unit + integration tests (~10s)
bun test --watch              # tests in watch mode
bun test --coverage           # with coverage report
bun run test:coverage:check   # coverage report + the 80% gate CI enforces
bun run test:e2e              # end-to-end suite (runs separately, see e2e/)
bun run lint                  # tsc + biome + knip — must be clean
bun run lint:fix              # auto-fix what Biome can
bun run format                # format everything
bun run build                 # production build
bun run setup:valkey          # install valkey-server (see below)
```

### Valkey, for the Memorystore data-plane tests

Memorystore spawns a real `valkey-server`, and the suites that exercise it **skip themselves**
when that binary is missing — so without it you get a green run that silently covered less than
you think. CI installs it explicitly, and [`test-utils/valkey.ts`](test-utils/valkey.ts) turns a
missing binary into a hard error whenever `CI` is set, so the gap cannot reopen there.

`bun install` tries to sort this out for you. Valkey publishes no prebuilt binaries — every
release is source-only — so installing means going through a system package manager, and on
Linux that needs root. The `postinstall` hook therefore installs **only when it can do so
without prompting** (Homebrew on macOS, or an already-root shell); anywhere else it prints the
exact command and exits successfully. It never fails `bun install`.

To install it yourself at any point:

```sh
bun run setup:valkey          # picks the right package manager, may use sudo on Linux
```

Set `KINGLET_SKIP_VALKEY_SETUP=1` to opt out of the hook entirely. Valkey has no native Windows
build — use WSL, or run kinglet via Docker (the image ships `valkey-server`).

> **macOS: valkey conflicts with redis.** Homebrew's valkey formula declares
> `conflicts_with "redis"` because both install the `redis-*` binaries. If redis holds those
> names, `brew install valkey` unpacks the keg and then *fails to link it* — so `valkey-server`
> never reaches your `PATH` and the tests keep skipping even though the install looked fine.
> The setup script detects this, runs `brew unlink redis`, and tells you it did. redis stays
> installed and `brew link redis` puts it back (which unlinks valkey again); in the meantime
> valkey's own keg provides `redis-server` and `redis-cli`, so those commands keep working.
> If the valkey install then fails anyway, the script relinks redis itself rather than leaving
> you with neither on your `PATH`.

> **On coverage:** `bunfig.toml` deliberately sets no `coverageThreshold`, because Bun applies
> that value *per file* rather than to the aggregate — at any meaningful setting it fails on
> individual low-function-count files (like `src/config/schema.ts`, which is mostly Zod schema
> declarations) even when the project is above 94% overall. The **80% aggregate** gate lives in
> [`scripts/check-coverage.ts`](scripts/check-coverage.ts) and reads the lcov report. Run
> `bun run test:coverage:check` to see exactly what CI will see.

Git hooks are installed automatically by `bun install` (husky). `pre-commit` runs format +
lint; `commit-msg` runs commitlint. **CI enforces all of this independently**, so bypassing
hooks with `--no-verify` only delays the failure.

> **Windows note:** `CLAUDE.md` is a symlink to `AGENTS.md`. Git on Windows checks symlinks
> out as plain text files unless `core.symlinks=true` is set (or Developer Mode is enabled).
> If your `CLAUDE.md` contains the literal text `AGENTS.md`, read `AGENTS.md` directly — the
> repo is fine.

---

## Adding a new GCP service

This has its own documentation, because it is the largest kind of contribution:

- **[docs/adding-a-service.md](docs/adding-a-service.md)** — architecture, the file pattern
  every service follows, how to read a discovery document, registration, and the pre-PR
  checklist.

**Open a *New service proposal* issue and get it accepted before writing the code.** A
complete, unsolicited service PR is the most expensive thing to decline, for both of us.

---

## Commit conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/). Release
automation ([release-please](https://github.com/googleapis/release-please)) derives version
bumps and the changelog directly from commit messages, so a malformed message breaks the
release, not just the aesthetics.

```
feat(pubsub): add snapshot seek by timestamp

fix(scheduler): return 409 instead of 400 on duplicate job name

Real Cloud Scheduler returns ALREADY_EXISTS (409) when creating a job
whose name is taken. We returned 400, which caused the client library's
retry logic to give up instead of surfacing the conflict.

Verified against the v1 discovery document.
```

**Allowed types:** `feat`, `fix`, `perf`, `deps`, `revert`, `docs`, `style`, `chore`,
`refactor`, `test`, `build`, `ci`.

**Rules** (enforced by commitlint, locally *and* in CI):

- Subject ≤ 100 characters, lowercase start, no trailing period.
- Body and footer lines wrap at 100 characters.
- Scope is optional but encouraged — usually the service name.

**The body should answer *why*, not *what*.** The diff already shows what changed. For a
fidelity fix, state the real GCP behaviour, what we did instead, and how you verified it.

---

## Pull requests

1. **Fork and branch.** Branch from `main`.
2. **Fill in the PR template.** It is short, and every box maps to something above.
3. **Keep it focused.** One logical change. A PR that fixes a bug *and* reformats a file is
   two PRs.
4. **Make sure CI is green** — lint, tests, coverage, e2e, commitlint, and DCO.
5. **Expect review latency.** See [Support expectations](#support-expectations).

### What review looks like

The maintainer reviews and merges everything. A review will check, roughly in this order:

1. Is it in scope? (If not, nothing else matters — so please open an issue first.)
2. Does the emulated behaviour match the discovery document?
3. Do the tests actually test something?
4. Is it the simplest thing that works?

Review comments are about the code, never about you. If something reads as blunt, it is
brevity, not hostility — see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), which binds the
maintainer too.

---

## Security

**Do not report vulnerabilities in a public issue.** See [SECURITY.md](SECURITY.md).

---

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), and you certify the DCO as described above.
