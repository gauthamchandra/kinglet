# kinglet

[![CI](https://github.com/gauthamchandra/kinglet/actions/workflows/ci.yml/badge.svg)](https://github.com/gauthamchandra/kinglet/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Container](https://img.shields.io/badge/ghcr.io-kinglet-blue)](https://github.com/gauthamchandra/kinglet/pkgs/container/kinglet)

**kinglet** is a local emulator for [Google Cloud Platform](https://cloud.google.com) services. Built with [Bun](https://bun.sh) and TypeScript, it lets you run GCP APIs on your machine for development and testing — no cloud account required.

Point your `@google-cloud/*` client libraries at `http://localhost:8765` instead of the real GCP endpoint, disable authentication, and your code should behave the same way it would against production.

The project aims for **full REST API compatibility** with each GCP service: if your code works against kinglet, it should work against real GCP. Support is being added incrementally.

## Why "kinglet"?

The project is named after the [golden-crowned kinglet](https://en.wikipedia.org/wiki/Golden-crowned_kinglet) — a small, nimble bird and a favorite of the maintainer. The name fits: kinglet aims to be lightweight, fast, and precise.

## What kinglet does today

- Emulates GCP REST APIs incrementally, service by service.
- Runs as a single HTTP server (default port `8765`) backed by in-memory, SQLite, or hybrid storage.
- Targets **API fidelity**: if your code works against kinglet, it should work against real GCP.

## Quick start

```bash
docker run -d \
  -p 8765:8765 \
  --name kinglet \
  ghcr.io/gauthamchandra/kinglet:latest

curl http://localhost:8765/health
# {"status":"ok"}
```

See [docs/getting-started/quickstart.md](docs/getting-started/quickstart.md) for Docker Compose and more detail.

## Documentation

| Topic | Link |
| --- | --- |
| Quick start (Docker Compose, etc.) | [docs/getting-started/quickstart.md](docs/getting-started/quickstart.md) |
| Client library setup | [docs/getting-started/client-libraries.md](docs/getting-started/client-libraries.md) |
| Compatibility matrix | [docs/compatibility/index.md](docs/compatibility/index.md) |
| Configuration | [docs/reference/configuration.md](docs/reference/configuration.md) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) |

- **Adding a service?** See [docs/adding-a-service.md](docs/adding-a-service.md).
- **Found a security issue?** See [SECURITY.md](SECURITY.md) — please don't open a public issue.

## What kinglet is not

kinglet is a **development and testing tool**. It is not authenticated, not hardened, and not intended for production or for real secrets. See the [threat model](SECURITY.md#threat-model--please-read-before-reporting).

kinglet is not affiliated with, endorsed by, or sponsored by Google LLC. "Google Cloud", "Google Cloud Platform", "GCP", and the service names above are trademarks of Google LLC, used here only to describe which APIs this software emulates.

## Development

```bash
bun install
bun run dev
bun test
bun run lint
```

See [docs/development/setup.md](docs/development/setup.md) for the full development guide.

## License

[Apache License 2.0](LICENSE).
