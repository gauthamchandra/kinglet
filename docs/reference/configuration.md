# Configuration

All configuration is via environment variables. Defaults are shown below.

## Server

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` or `HTTP_PORT` | `8765` | HTTP server port |
| `GRPC_PORT` | `8766` | gRPC server port |
| `MAX_CONNECTIONS` | `100` | Maximum concurrent connections |

## Storage

| Variable | Default | Description |
| --- | --- | --- |
| `STORAGE_TYPE` | `hybrid` | `memory`, `sqlite`, or `hybrid` |
| `SQLITE_PATH` | `./data/emulator.db` | Path to SQLite database file |
| `CACHE_SIZE` | `104857600` | LRU cache size in bytes (100 MB) |

See [Storage modes](storage.md) for details on each storage type.

## Services

| Variable | Default | Description |
| --- | --- | --- |
| `SERVICES` | — | Comma-separated list to enable (e.g., `scheduler,tasks`) |
| `ENABLE_ALLOYDB` | `true` | Enable AlloyDB for PostgreSQL service |
| `ENABLE_PUBSUB` | `true` | Enable Pub/Sub service |
| `ENABLE_SCHEDULER` | `true` | Enable Cloud Scheduler service |
| `ENABLE_TASKS` | `true` | Enable Cloud Tasks service |
| `ENABLE_SECRETS` | `true` | Enable Secret Manager service |
| `ENABLE_STORAGE` | `true` | Enable Cloud Storage service (experimental) |
| `ENABLE_WORKFLOWS` | `true` | Enable Cloud Workflows service |
| `ENABLE_KMS` | `true` | Enable Cloud KMS service |
| `ENABLE_MEMORYSTORE` | `true` | Enable Memorystore for Valkey service |
| `ENABLE_CLOUDSQL` | `true` | Enable Cloud SQL service |
| `MEMORYSTORE_DATA_PLANE` | `true` | Spawn a real `valkey-server` per instance; `false` for metadata-only endpoints |
| `MEMORYSTORE_VALKEY_BINARY` | — | Override the resolved `valkey-server` binary path |
| `MEMORYSTORE_PORT_RANGE_START` | `6380` | First port available for data-plane instances |
| `MEMORYSTORE_PORT_RANGE_END` | `6479` | Last port available for data-plane instances |
| `CLOUDSQL_DATA_PLANE` | `true` | Serve a real Postgres endpoint per instance (PGlite); `false` for a control plane only |
| `CLOUDSQL_PORT_RANGE_START` | `5432` | First port available for Cloud SQL instance endpoints |
| `CLOUDSQL_PORT_RANGE_END` | `5531` | Last port available for Cloud SQL instance endpoints |
| `ENABLE_COMPUTE` | `true` | Enable Compute Engine (Cloud Armor) service |
| `COMPUTE_LISTENER_PORT` | `8787` | Cloud Armor evaluation listener port |
| `COMPUTE_ARMOR_DEFAULT_POLICY` | — | Policy to evaluate when more than one security policy exists |

## Logging

| Variable | Default | Description |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `LOG_FORMAT` | `json` | `json` or `pretty` |

## Authentication

| Variable | Default | Description |
| --- | --- | --- |
| `AUTH_ENABLED` | `false` | Enable authentication |
| `AUTH_MODE` | `bypass` | `bypass`, `mock`, or `validate` |
| `MOCK_PROJECT_ID` | `kinglet-project` | Default project ID |

## Example: custom configuration

```bash
docker run -d \
  -p 9000:9000 \
  -e HTTP_PORT=9000 \
  -e STORAGE_TYPE=memory \
  -e LOG_LEVEL=debug \
  -e LOG_FORMAT=pretty \
  -e SERVICES=scheduler,tasks \
  ghcr.io/gauthamchandra/kinglet:latest
```
