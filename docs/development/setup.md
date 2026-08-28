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

Regenerate compatibility and API reference docs after changing routes:

```bash
bun run docs:generate
```

CI enforces that generated docs are up to date. See [compatibility matrix](../compatibility/index.md).

## Where to go next

| I want to… | Read |
| --- | --- |
| Contribute anything | [CONTRIBUTING.md](../../CONTRIBUTING.md) — scope, fidelity contract, quality bar, DCO, AI policy |
| Add a new GCP service | [adding-a-service.md](../adding-a-service.md) |
| Understand why it's built this way | [ADRs](../adrs/) |
| Configure an AI agent | [AGENTS.md](../../AGENTS.md) (`CLAUDE.md` is a symlink to it) |
