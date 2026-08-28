# Development setup

## Prerequisites

- [Bun](https://bun.sh) >= 1.1.0 (this repo pins **1.3.4** in `.tool-versions`)

## Setup

```bash
bun install
bun run dev       # start with hot reload
bun test          # unit + integration tests
bun run test:e2e  # end-to-end suite
bun run lint      # typecheck + biome + knip
```

## Documentation

After changing routes, regenerate and commit the API reference:

```bash
bun run docs:generate:api
```

CI and the pre-push hook run `bun run docs:check`, which verifies `docs/reference/api/` matches the codebase.

The compatibility matrix (`docs/compatibility/`) is refreshed by a scheduled workflow that fetches Google discovery documents live and opens its own PR. Regenerate locally with:

```bash
bun run docs:generate:compatibility
```

Use `--use-cache` with either generate command to reuse a local `.discovery-cache/` when offline.

## Where to go next

| I want to… | Read |
| --- | --- |
| Contribute anything | [CONTRIBUTING.md](../../CONTRIBUTING.md) — scope, fidelity contract, quality bar, DCO, AI policy |
| Add a new GCP service | [adding-a-service.md](../adding-a-service.md) |
| Understand why it's built this way | [ADRs](../adrs/) |
| Configure an AI agent | [AGENTS.md](../../AGENTS.md) (`CLAUDE.md` is a symlink to it) |
