# Discovery document cache

This directory contains cached copies of Google REST discovery documents used by `scripts/generate-docs.ts` to compute endpoint coverage.

## Updating the cache

Refresh public discovery documents from the network:

```bash
bun run docs:generate -- --update-discovery
```

## Memorystore

The Memorystore discovery document is not publicly accessible without credentials. To enable coverage reporting for Memorystore, add a vendored copy at:

```
discovery-documents/memorystore.json
```

Until that file exists, the compatibility matrix reports Memorystore route coverage as "Discovery doc unavailable" while still listing implemented kinglet routes.

## CI

CI does not fetch discovery documents at runtime. It regenerates docs from this committed cache and fails if the output does not match what is checked in.
