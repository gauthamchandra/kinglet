# kinglet

[![CI](https://github.com/gauthamchandra/kinglet/actions/workflows/ci.yml/badge.svg)](https://github.com/gauthamchandra/kinglet/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Container](https://img.shields.io/badge/ghcr.io-kinglet-blue)](https://github.com/gauthamchandra/kinglet/pkgs/container/kinglet)

**A local emulator for Google Cloud Platform services.** Built with [Bun](https://bun.sh) and TypeScript. Run GCP services on your machine for development and testing — no cloud account required.

The project aims for **full REST API compatibility** with each GCP service: if your code works against kinglet, it should work against real GCP. Support is being added incrementally.

## Quick start

```bash
docker run -d \
  -p 8765:8765 \
  --name kinglet \
  ghcr.io/gauthamchandra/kinglet:latest

curl http://localhost:8765/health
# {"status":"ok"}
```

## Documentation

| Topic | Link |
| --- | --- |
| What is kinglet? | [docs/index.md](docs/index.md) |
| Quick start (Docker Compose, etc.) | [docs/getting-started/quickstart.md](docs/getting-started/quickstart.md) |
| Client library setup | [docs/getting-started/client-libraries.md](docs/getting-started/client-libraries.md) |
| Compatibility matrix | [docs/compatibility/index.md](docs/compatibility/index.md) |
| Configuration | [docs/reference/configuration.md](docs/reference/configuration.md) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) |

- **Adding a service?** See [docs/adding-a-service.md](docs/adding-a-service.md).
- **Found a security issue?** See [SECURITY.md](SECURITY.md) — please don't open a public issue.

> kinglet is a development and testing tool. It is not authenticated, not hardened, and not intended for production or for real secrets. See the [threat model](SECURITY.md#threat-model--please-read-before-reporting).

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

kinglet is not affiliated with, endorsed by, or sponsored by Google LLC. "Google Cloud", "Google Cloud Platform", "GCP", and the service names above are trademarks of Google LLC, used here only to describe which APIs this software emulates.
