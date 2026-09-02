# Quick start

## Docker

```bash
docker run -d \
  -p 8765:8765 \
  --name kinglet \
  ghcr.io/gauthamchandra/kinglet:latest
```

Verify it's running:

```bash
curl http://localhost:8765/health
# {"status":"ok"}
```

## Docker Compose

```yaml
services:
  kinglet:
    image: ghcr.io/gauthamchandra/kinglet:latest
    ports:
      - "8765:8765"
      # Memorystore data plane (on by default; omit if MEMORYSTORE_DATA_PLANE=false).
      # Each instance's `valkey-server` listens on every interface with
      # protected mode off, so these published ports are reachable from the
      # host and the data plane is unauthenticated. Publish this range only
      # on a trusted local/CI machine, never from a container reachable from
      # the internet.
      - "6380-6479:6380-6479"
      # Cloud SQL data plane (on by default; omit if CLOUDSQL_DATA_PLANE=false).
      # Each instance's Postgres endpoint listens on every interface and
      # authenticates in cleartext, with no TLS, so publish this range only on
      # a trusted local/CI machine. The first instance lands on 5432, so a
      # local Postgres already using it will push the emulator to 5433.
      - "5432-5531:5432-5531"
    volumes:
      - kinglet-data:/app/data  # persist state across restarts
    environment:
      LOG_LEVEL: info

volumes:
  kinglet-data:
```

## Next steps

- [Connect GCP client libraries](client-libraries.md)
- [Compatibility matrix](../compatibility/index.md) — see which services are supported
- [Configuration](../reference/configuration.md) — environment variables and service toggles
