# What is kinglet?

**kinglet** is a local emulator for [Google Cloud Platform](https://cloud.google.com) services. Built with [Bun](https://bun.sh) and TypeScript, it lets you run GCP APIs on your machine for development and testing — no cloud account required.

Point your `@google-cloud/*` client libraries at `http://localhost:8765` instead of the real GCP endpoint, disable authentication, and your code should behave the same way it would against production.

## Why "kinglet"?

The project is named after the [golden-crowned kinglet](https://en.wikipedia.org/wiki/Golden-crowned_kinglet) — a small, nimble bird and a favorite of the maintainer. The name fits: kinglet aims to be lightweight, fast, and precise.

## What kinglet does today

- Emulates GCP REST APIs incrementally, service by service.
- Runs as a single HTTP server (default port `8765`) backed by in-memory, SQLite, or hybrid storage.
- Targets **API fidelity**: if your code works against kinglet, it should work against real GCP.

## What kinglet is not

kinglet is a **development and testing tool**. It is not authenticated, not hardened, and not intended for production or for real secrets. See the [threat model](../SECURITY.md#threat-model--please-read-before-reporting).

kinglet is not affiliated with, endorsed by, or sponsored by Google LLC.

## Where to go next

| I want to… | Read |
| --- | --- |
| Try it locally | [Quick start](getting-started/quickstart.md) |
| Connect client libraries | [Client libraries](getting-started/client-libraries.md) |
| See what's supported | [Compatibility matrix](compatibility/index.md) |
| Configure the server | [Configuration](reference/configuration.md) |
| Contribute | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| See what changed | [CHANGELOG.md](../CHANGELOG.md) |
