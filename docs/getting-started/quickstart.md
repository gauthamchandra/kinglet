# Quick start

## Docker

```bash
docker run -d \
  -p 8765:8765 \
  -p 8787:8787 \
  --name kinglet \
  ghcr.io/gauthamchandra/kinglet:latest
```

Verify it's running:

```bash
curl http://localhost:8765/health
# {"status":"ok","kingletCloudArmorEvaluationServer":{"started":true,"port":8787,"bind":"0.0.0.0"}}
```

Port `8787` is the Cloud Armor evaluation server (unauthenticated). See
[Testing Cloud Armor policies](cloud-armor.md). Omit `-p 8787:8787` if you only
need the control plane.

## Docker Compose

```yaml
services:
  kinglet:
    image: ghcr.io/gauthamchandra/kinglet:latest
    ports:
      - "8765:8765"
      # Cloud Armor evaluation server (on with ENABLE_COMPUTE, default true).
      # Unauthenticated. The image binds 0.0.0.0:8787 so this publish reaches it.
      # Omit if you only need the control plane.
      - "8787:8787"
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
- [Test Cloud Armor policies](cloud-armor.md)
- [Compatibility matrix](../compatibility/index.md) — see which services are supported
- [Configuration](../reference/configuration.md) — environment variables and service toggles
