# LocalStack GCP Emulator

A local emulation environment for Google Cloud Platform services, built with [Bun](https://bun.sh) and TypeScript. Run GCP services on your machine for development and testing — no cloud account required.

The project aims for **full REST API compatibility** with each GCP service. Support is being added incrementally.

## Quick Start

### Docker

```bash
docker run -d \
  -p 8765:8765 \
  --name localstack-gcp \
  ghcr.io/gauthamchandra/localstack-gcp:latest
```

Verify it's running:

```bash
curl http://localhost:8765/health
# {"status":"ok"}
```

### Docker Compose

```yaml
services:
  localstack-gcp:
    image: ghcr.io/gauthamchandra/localstack-gcp:latest
    ports:
      - "8765:8765"
    volumes:
      - localstack-data:/app/data  # persist state across restarts
    environment:
      LOG_LEVEL: info

volumes:
  localstack-data:
```

## Connecting GCP Client Libraries

The core idea: point your GCP client library at `http://localhost:8765` instead of the real GCP endpoint and disable authentication.

### Node.js

```typescript
import { CloudSchedulerClient } from "@google-cloud/scheduler";
import { CloudTasksClient } from "@google-cloud/tasks";

const scheduler = new CloudSchedulerClient({
  apiEndpoint: "localhost:8765",
  projectId: "test-project",
  // Bypass authentication — the emulator doesn't require credentials
  auth: {
    getClient: () =>
      Promise.resolve({
        fetch: (url: string, opts: RequestInit) => fetch(url, opts),
      }),
    getProjectId: () => Promise.resolve("test-project"),
  } as any,
});

const tasks = new CloudTasksClient({
  apiEndpoint: "localhost:8765",
  projectId: "test-project",
  auth: {
    getClient: () =>
      Promise.resolve({
        fetch: (url: string, opts: RequestInit) => fetch(url, opts),
      }),
    getProjectId: () => Promise.resolve("test-project"),
  } as any,
});
```

### Python

```python
from google.cloud import scheduler_v1, tasks_v2
from google.auth import credentials as ga_credentials
from google.api_core.client_options import ClientOptions

options = ClientOptions(api_endpoint="http://localhost:8765")
creds = ga_credentials.AnonymousCredentials()

scheduler = scheduler_v1.CloudSchedulerClient(
    client_options=options,
    credentials=creds,
    transport="rest",
)

tasks = tasks_v2.CloudTasksClient(
    client_options=options,
    credentials=creds,
    transport="rest",
)
```

### Go

```go
import (
    scheduler "cloud.google.com/go/scheduler/apiv1"
    tasks "cloud.google.com/go/cloudtasks/apiv2"
    "google.golang.org/api/option"
)

schedulerClient, _ := scheduler.NewCloudSchedulerRESTClient(ctx,
    option.WithEndpoint("http://localhost:8765"),
    option.WithoutAuthentication(),
)

tasksClient, _ := tasks.NewRESTClient(ctx,
    option.WithEndpoint("http://localhost:8765"),
    option.WithoutAuthentication(),
)
```

### Plain HTTP

All services expose standard GCP REST endpoints, so plain `curl` or `fetch` works:

```bash
# Create a Cloud Tasks queue
curl -X POST http://localhost:8765/v2/projects/test-project/locations/us-central1/queues \
  -H "Content-Type: application/json" \
  -d '{"name": "projects/test-project/locations/us-central1/queues/my-queue"}'
```

## Supported Services

| Service | Status | API Version | Notes |
|---------|--------|-------------|-------|
| Cloud Scheduler | Implemented | v1 | Job CRUD, pause/resume, cron execution |
| Cloud Tasks | Implemented | v2 | Queue lifecycle, task CRUD, HTTP dispatch |
| Cloud Storage | Experimental | v1 | Bucket CRUD, object upload/download, copy, compose, rewrite |
| Cloud Workflows | Experimental | v1 | Workflow CRUD, revisions, LRO operations |
| Pub/Sub | Planned | — | Not yet implemented |
| Secret Manager | Planned | — | Not yet implemented |

> **Experimental** means the service API is implemented but has not yet been validated against production use cases or official GCP client libraries. Breaking changes may occur.

## Configuration

All configuration is via environment variables. Defaults are shown below.

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` or `HTTP_PORT` | `8765` | HTTP server port |
| `GRPC_PORT` | `8766` | gRPC server port |
| `MAX_CONNECTIONS` | `100` | Maximum concurrent connections |

### Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `STORAGE_TYPE` | `hybrid` | `memory`, `sqlite`, or `hybrid` |
| `SQLITE_PATH` | `./data/emulator.db` | Path to SQLite database file |
| `CACHE_SIZE` | `104857600` | LRU cache size in bytes (100 MB) |

### Services

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVICES` | — | Comma-separated list to enable (e.g., `scheduler,tasks`) |
| `ENABLE_PUBSUB` | `true` | Enable Pub/Sub service |
| `ENABLE_SCHEDULER` | `true` | Enable Cloud Scheduler service |
| `ENABLE_TASKS` | `true` | Enable Cloud Tasks service |
| `ENABLE_SECRETS` | `true` | Enable Secret Manager service |
| `ENABLE_STORAGE` | `true` | Enable Cloud Storage service (experimental) |
| `ENABLE_WORKFLOWS` | `true` | Enable Cloud Workflows service |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `LOG_FORMAT` | `json` | `json` or `pretty` |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_ENABLED` | `false` | Enable authentication |
| `AUTH_MODE` | `bypass` | `bypass`, `mock`, or `validate` |
| `MOCK_PROJECT_ID` | `localstack-project` | Default project ID |

### Example: custom configuration

```bash
docker run -d \
  -p 9000:9000 \
  -e HTTP_PORT=9000 \
  -e STORAGE_TYPE=memory \
  -e LOG_LEVEL=debug \
  -e LOG_FORMAT=pretty \
  -e SERVICES=scheduler,tasks \
  ghcr.io/gauthamchandra/localstack-gcp:latest
```

## API Endpoints

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |

### Cloud Scheduler (v1)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/projects/{project}/locations/{location}/jobs` | List jobs |
| `GET` | `/v1/projects/{project}/locations/{location}/jobs/{jobId}` | Get job |
| `POST` | `/v1/projects/{project}/locations/{location}/jobs` | Create job |
| `PATCH` | `/v1/projects/{project}/locations/{location}/jobs/{jobId}` | Update job |
| `DELETE` | `/v1/projects/{project}/locations/{location}/jobs/{jobId}` | Delete job |
| `POST` | `/v1/projects/{project}/locations/{location}/jobs/{jobId}:pause` | Pause job |
| `POST` | `/v1/projects/{project}/locations/{location}/jobs/{jobId}:resume` | Resume job |
| `POST` | `/v1/projects/{project}/locations/{location}/jobs/{jobId}:run` | Run job immediately |

### Cloud Tasks (v2)

**Queues**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v2/projects/{project}/locations/{location}/queues` | List queues |
| `GET` | `/v2/projects/{project}/locations/{location}/queues/{queueId}` | Get queue |
| `POST` | `/v2/projects/{project}/locations/{location}/queues` | Create queue |
| `PATCH` | `/v2/projects/{project}/locations/{location}/queues/{queueId}` | Update queue |
| `DELETE` | `/v2/projects/{project}/locations/{location}/queues/{queueId}` | Delete queue |
| `POST` | `/v2/projects/{project}/locations/{location}/queues/{queueId}:pause` | Pause queue |
| `POST` | `/v2/projects/{project}/locations/{location}/queues/{queueId}:resume` | Resume queue |
| `POST` | `/v2/projects/{project}/locations/{location}/queues/{queueId}:purge` | Purge queue |

**Tasks**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v2/projects/{project}/locations/{location}/queues/{queueId}/tasks` | List tasks |
| `GET` | `/v2/projects/{project}/locations/{location}/queues/{queueId}/tasks/{taskId}` | Get task |
| `POST` | `/v2/projects/{project}/locations/{location}/queues/{queueId}/tasks` | Create task |
| `DELETE` | `/v2/projects/{project}/locations/{location}/queues/{queueId}/tasks/{taskId}` | Delete task |
| `POST` | `/v2/projects/{project}/locations/{location}/queues/{queueId}/tasks/{taskId}:run` | Run task immediately |

### Cloud Storage (v1) — Experimental

**Buckets**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/storage/v1/b` | Create bucket |
| `GET` | `/storage/v1/b` | List buckets |
| `GET` | `/storage/v1/b/{bucket}` | Get bucket |
| `PATCH` | `/storage/v1/b/{bucket}` | Patch bucket |
| `PUT` | `/storage/v1/b/{bucket}` | Update bucket |
| `DELETE` | `/storage/v1/b/{bucket}` | Delete bucket |

**Objects**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/upload/storage/v1/b/{bucket}/o` | Upload object |
| `GET` | `/storage/v1/b/{bucket}/o` | List objects |
| `GET` | `/storage/v1/b/{bucket}/o/{object}` | Get object (metadata or `alt=media` for data) |
| `PATCH` | `/storage/v1/b/{bucket}/o/{object}` | Patch object metadata |
| `PUT` | `/storage/v1/b/{bucket}/o/{object}` | Update object metadata |
| `DELETE` | `/storage/v1/b/{bucket}/o/{object}` | Delete object |
| `POST` | `/storage/v1/b/{bucket}/o/{object}/compose` | Compose objects |
| `POST` | `/storage/v1/b/{srcBucket}/o/{srcObject}/copyTo/b/{dstBucket}/o/{dstObject}` | Copy object |
| `POST` | `/storage/v1/b/{srcBucket}/o/{srcObject}/rewriteTo/b/{dstBucket}/o/{dstObject}` | Rewrite object |

### Cloud Workflows (v1) — Experimental

**Workflows**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/projects/{project}/locations/{location}/workflows` | List workflows |
| `GET` | `/v1/projects/{project}/locations/{location}/workflows/{workflowId}` | Get workflow |
| `POST` | `/v1/projects/{project}/locations/{location}/workflows` | Create workflow |
| `PATCH` | `/v1/projects/{project}/locations/{location}/workflows/{workflowId}` | Update workflow |
| `DELETE` | `/v1/projects/{project}/locations/{location}/workflows/{workflowId}` | Delete workflow |
| `GET` | `/v1/projects/{project}/locations/{location}/workflows/{workflowId}:listRevisions` | List revisions |

**Operations**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/projects/{project}/locations/{location}/operations` | List operations |
| `GET` | `/v1/projects/{project}/locations/{location}/operations/{operationId}` | Get operation |
| `DELETE` | `/v1/projects/{project}/locations/{location}/operations/{operationId}` | Delete operation |

**Locations**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/projects/{project}/locations` | List locations |
| `GET` | `/v1/projects/{project}/locations/{location}` | Get location |

## Storage

The emulator supports three storage modes via the `STORAGE_TYPE` variable:

- **`memory`** — Fast, ephemeral. Data is lost when the container stops. Good for CI and short-lived tests.
- **`sqlite`** — Persistent. Data stored in a SQLite database at `SQLITE_PATH`. Survives restarts.
- **`hybrid`** (default) — LRU memory cache backed by SQLite. Fast reads with persistence. Best for local development.

To persist data across container restarts, mount the data directory:

```bash
docker run -d -p 8765:8765 -v ./data:/app/data ghcr.io/gauthamchandra/localstack-gcp:latest
```

## Versioning and Releases

This project uses [semantic versioning](https://semver.org/) with automated releases powered by [release-please](https://github.com/googleapis/release-please).

### How it works

1. All commits to `main` must follow [Conventional Commits](https://www.conventionalcommits.org/) format (enforced by commitlint)
2. When commits land on `main`, release-please automatically opens (or updates) a release PR with the proposed version bump and changelog
3. A maintainer reviews and merges the release PR — this is the only manual step
4. Merging the release PR automatically:
   - Creates a git tag (e.g., `v1.2.3`)
   - Publishes a GitHub Release with changelog notes
   - Builds and pushes Docker images with semver tags

### Docker image tags

| Tag | Example | When to use |
|-----|---------|-------------|
| `X.Y.Z` | `1.2.3` | Pin to an exact version for reproducible builds |
| `X.Y` | `1.2` | Track patch releases within a minor version |
| `X` | `1` | Track minor + patch releases within a major version |
| `latest` | — | Always points to the most recent release |
| `sha-<short>` | `sha-abc1234` | Every push to `main`; useful for testing unreleased changes |

```bash
# Pin to exact version (recommended for CI/CD)
docker pull ghcr.io/gauthamchandra/localstack-gcp:1.2.3

# Track latest within major version
docker pull ghcr.io/gauthamchandra/localstack-gcp:1
```

### Commit message format

The version bump is determined by commit prefixes:

| Prefix | Version bump | Example |
|--------|-------------|---------|
| `feat:` | Minor (`1.0.0` -> `1.1.0`) | `feat: add Pub/Sub topic support` |
| `fix:` | Patch (`1.0.0` -> `1.0.1`) | `fix: correct scheduler cron parsing` |
| `feat!:` or `BREAKING CHANGE:` | Major (`1.0.0` -> `2.0.0`) | `feat!: change default storage mode` |
| `chore:`, `docs:`, `ci:`, etc. | No release | `chore: update dependencies` |

### Creating a release (maintainers)

No manual steps are needed beyond merging the release PR that release-please opens. If you need to force a specific version, you can edit the release PR's `version` field in `package.json` before merging.

## Development

### Prerequisites

- [Bun](https://bun.sh) >= 1.1.0

### Setup

```bash
bun install
bun run dev      # start with hot reload
bun test         # run all tests
bun run lint     # typecheck + biome + knip
```

See [CLAUDE.md](CLAUDE.md) for coding conventions and architecture details.
See [docs/adrs/](docs/adrs/) for architectural decision records.

## License

MIT
