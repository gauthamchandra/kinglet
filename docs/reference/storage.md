# Storage modes

The emulator supports three storage modes via the `STORAGE_TYPE` variable:

- **`memory`** — Fast, ephemeral. Data is lost when the container stops. Good for CI and short-lived tests.
- **`sqlite`** — Persistent. Data stored in a SQLite database at `SQLITE_PATH`. Survives restarts.
- **`hybrid`** (default) — Persistent, backed by SQLite at `SQLITE_PATH`. Intended to add an LRU
  memory cache in front of it; that cache is not wired up yet, so today `hybrid` behaves the same
  as `sqlite`.

`hybrid` is the default in every environment, including local development, so state written by
one run is still there on the next. To start from a clean slate, delete the data directory
(`rm -rf data/`) or run with `STORAGE_TYPE=memory`.

To persist data across container restarts, mount the data directory:

```bash
docker run -d -p 8765:8765 -v ./data:/app/data ghcr.io/gauthamchandra/kinglet:latest
```

See [Configuration](configuration.md) for all storage-related environment variables.
