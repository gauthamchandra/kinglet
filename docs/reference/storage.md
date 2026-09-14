# Storage modes

The emulator supports two storage modes via the `STORAGE_TYPE` variable:

- **`memory`** — Fast, ephemeral. Data is lost when the container stops. Good for CI and short-lived tests.
- **`sqlite`** (default) — Persistent. Data stored in a SQLite database at `SQLITE_PATH`. Survives restarts.

`sqlite` is the default in every environment, including local development, so state written by
one run is still there on the next. To start from a clean slate, delete the data directory
(`rm -rf data/`) or run with `STORAGE_TYPE=memory`.

To persist data across container restarts, mount the data directory:

```bash
docker run -d -p 8765:8765 -v ./data:/app/data ghcr.io/gauthamchandra/kinglet:latest
```

## Migrating from `hybrid`

`STORAGE_TYPE=hybrid` and `CACHE_SIZE` were removed in v3.0.0. Set `STORAGE_TYPE=sqlite`
(or drop the variable, since sqlite is the default). Existing database files are unaffected;
hybrid always wrote to the same SQLite file. Starting with `hybrid` still set now fails
validation with an error pointing here.

See [Configuration](configuration.md) for all storage-related environment variables.
See [ADR-016](../adrs/016-memory-and-sqlite-storage.md) for why there is no hybrid mode.
