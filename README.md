# kinglet

[![CI](https://github.com/gauthamchandra/kinglet/actions/workflows/ci.yml/badge.svg)](https://github.com/gauthamchandra/kinglet/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Container](https://img.shields.io/badge/ghcr.io-kinglet-blue)](https://github.com/gauthamchandra/kinglet/pkgs/container/kinglet)

**A local emulator for Google Cloud Platform services.** Built with [Bun](https://bun.sh) and TypeScript. Run GCP services on your machine for development and testing — no cloud account required.

The project aims for **full REST API compatibility** with each GCP service: if your code works against kinglet, it should work against real GCP. Support is being added incrementally.

- **Contributing?** Start with [CONTRIBUTING.md](CONTRIBUTING.md) — especially the [API fidelity contract](CONTRIBUTING.md#the-fidelity-contract).
- **Adding a service?** See [docs/adding-a-service.md](docs/adding-a-service.md).
- **Found a security issue?** See [SECURITY.md](SECURITY.md) — please don't open a public issue.

> kinglet is a development and testing tool. It is not authenticated, not hardened, and not intended for production or for real secrets. See the [threat model](SECURITY.md#threat-model--please-read-before-reporting).

## Quick Start

### Docker

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

### Docker Compose

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
    volumes:
      - kinglet-data:/app/data  # persist state across restarts
    environment:
      LOG_LEVEL: info

volumes:
  kinglet-data:
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
| Cloud Pub/Sub | Implemented | v1 | Topics, subscriptions, publish/pull, ack, snapshots, schemas, seek |
| Cloud Storage | Experimental | v1 | Bucket CRUD, object upload/download, copy, compose, rewrite |
| Cloud Workflows | Experimental | v1 | Workflow CRUD, revisions, LRO operations |
| Cloud KMS | Implemented | v1 | Key rings, crypto keys/versions, symmetric encrypt/decrypt, asymmetric sign/decrypt, MAC, random bytes (IAM & importJobs deferred) |
| Memorystore for Valkey | Experimental | v1 | Instance/ACL/backup/token-auth CRUD, real `valkey-server` data plane on by default (token-auth is metadata only — the data plane is unauthenticated) |
| AlloyDB for PostgreSQL | Experimental | v1 | Cluster/instance/user CRUD and LRO operations — **control plane only**, nothing listens on a PostgreSQL port. See the endpoint list for what is not implemented |
| Cloud SQL | Implemented | v1 | Admin API control plane only — instance/database/user/operation CRUD; no connectable data plane (instances are records, not real Postgres servers) |
| Secret Manager | Planned | — | Not yet implemented — the config flag exists but the service is a stub |

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
| `MOCK_PROJECT_ID` | `kinglet-project` | Default project ID |

### Example: custom configuration

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

### Cloud Pub/Sub (v1)

**Topics**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/projects/{project}/topics` | List topics |
| `GET` | `/v1/projects/{project}/topics/{topic}` | Get topic |
| `PUT` | `/v1/projects/{project}/topics/{topic}` | Create topic |
| `PATCH` | `/v1/projects/{project}/topics/{topic}` | Update topic |
| `DELETE` | `/v1/projects/{project}/topics/{topic}` | Delete topic |
| `POST` | `/v1/projects/{project}/topics/{topic}:publish` | Publish messages |
| `GET` | `/v1/projects/{project}/topics/{topic}/subscriptions` | List a topic's subscriptions |
| `GET` | `/v1/projects/{project}/topics/{topic}/snapshots` | List a topic's snapshots |

**Subscriptions**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/projects/{project}/subscriptions` | List subscriptions |
| `GET` | `/v1/projects/{project}/subscriptions/{subscription}` | Get subscription |
| `PUT` | `/v1/projects/{project}/subscriptions/{subscription}` | Create subscription |
| `PATCH` | `/v1/projects/{project}/subscriptions/{subscription}` | Update subscription |
| `DELETE` | `/v1/projects/{project}/subscriptions/{subscription}` | Delete subscription |
| `POST` | `/v1/projects/{project}/subscriptions/{subscription}:pull` | Pull messages |
| `POST` | `/v1/projects/{project}/subscriptions/{subscription}:acknowledge` | Acknowledge messages |
| `POST` | `/v1/projects/{project}/subscriptions/{subscription}:modifyAckDeadline` | Modify ack deadline |
| `POST` | `/v1/projects/{project}/subscriptions/{subscription}:modifyPushConfig` | Modify push config |
| `POST` | `/v1/projects/{project}/subscriptions/{subscription}:seek` | Seek to time or snapshot |
| `POST` | `/v1/projects/{project}/subscriptions/{subscription}:detach` | Detach subscription |

**Snapshots**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/projects/{project}/snapshots` | List snapshots |
| `GET` | `/v1/projects/{project}/snapshots/{snapshot}` | Get snapshot |
| `PUT` | `/v1/projects/{project}/snapshots/{snapshot}` | Create snapshot |
| `PATCH` | `/v1/projects/{project}/snapshots/{snapshot}` | Update snapshot |
| `DELETE` | `/v1/projects/{project}/snapshots/{snapshot}` | Delete snapshot |

**Schemas**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/projects/{project}/schemas` | List schemas |
| `GET` | `/v1/projects/{project}/schemas/{schema}` | Get schema |
| `POST` | `/v1/projects/{project}/schemas` | Create schema |
| `DELETE` | `/v1/projects/{project}/schemas/{schema}` | Delete schema |
| `POST` | `/v1/projects/{project}/schemas/{schema}:commit` | Commit a schema revision |
| `GET` | `/v1/projects/{project}/schemas/{schema}:listRevisions` | List schema revisions |
| `POST` | `/v1/projects/{project}/schemas/{schema}:rollback` | Roll back to a revision |
| `DELETE` | `/v1/projects/{project}/schemas/{schema}:deleteRevision` | Delete a schema revision |
| `POST` | `/v1/projects/{project}/schemas:validate` | Validate a schema |
| `POST` | `/v1/projects/{project}/schemas:validateMessage` | Validate a message against a schema |

> **Not implemented:** streaming pull (the gRPC `StreamingPull` API) and the IAM policy methods (`setIamPolicy`, `getIamPolicy`, `testIamPermissions`).
>
> Pull delivery, push subscriptions, message ordering (`orderingKey` / `enableMessageOrdering`), and dead-letter forwarding all work.

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

### Cloud KMS (v1)

**Key Rings**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/projects/{project}/locations/{location}/keyRings?keyRingId=` | Create key ring |
| `GET` | `/v1/projects/{project}/locations/{location}/keyRings` | List key rings |
| `GET` | `/v1/projects/{project}/locations/{location}/keyRings/{keyRing}` | Get key ring |

**Crypto Keys**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `.../keyRings/{keyRing}/cryptoKeys?cryptoKeyId=` | Create crypto key (auto-creates version 1) |
| `GET` | `.../keyRings/{keyRing}/cryptoKeys` | List crypto keys |
| `GET` | `.../cryptoKeys/{cryptoKey}` | Get crypto key |
| `PATCH` | `.../cryptoKeys/{cryptoKey}` | Update crypto key (labels, rotation, versionTemplate) |
| `POST` | `.../cryptoKeys/{cryptoKey}:updatePrimaryVersion` | Set primary version |
| `POST` | `.../cryptoKeys/{cryptoKey}:encrypt` | Encrypt (symmetric) |
| `POST` | `.../cryptoKeys/{cryptoKey}:decrypt` | Decrypt (symmetric) |

**Crypto Key Versions**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `.../cryptoKeys/{cryptoKey}/cryptoKeyVersions` | Create version (rotate) |
| `GET` | `.../cryptoKeys/{cryptoKey}/cryptoKeyVersions` | List versions |
| `GET` | `.../cryptoKeyVersions/{version}` | Get version |
| `PATCH` | `.../cryptoKeyVersions/{version}` | Enable/disable version |
| `POST` | `.../cryptoKeyVersions/{version}:destroy` | Schedule destruction |
| `POST` | `.../cryptoKeyVersions/{version}:restore` | Restore a scheduled-destroy version |
| `GET` | `.../cryptoKeyVersions/{version}/publicKey` | Get public key (asymmetric) |
| `POST` | `.../cryptoKeyVersions/{version}:asymmetricSign` | Asymmetric sign |
| `POST` | `.../cryptoKeyVersions/{version}:asymmetricDecrypt` | Asymmetric decrypt |
| `POST` | `.../cryptoKeyVersions/{version}:macSign` | MAC sign |
| `POST` | `.../cryptoKeyVersions/{version}:macVerify` | MAC verify |

**Random**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/projects/{project}/locations/{location}:generateRandomBytes` | Generate random bytes |

> IAM policy methods, `importJobs`, `rawEncrypt`/`rawDecrypt`, and precomputed-digest signing for EC keys are not yet implemented. All operations use the `SOFTWARE` protection level. See [ADR-008](docs/adrs/008-kms-crypto-emulation.md).

### Locations (v1)

Served for every v1 service, independently of which services are enabled. Cloud Tasks
has its own `/v2` locations routes.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/projects/{project}/locations` | List locations |
| `GET` | `/v1/projects/{project}/locations/{location}` | Get location |

### Memorystore for Valkey (v1) — Experimental

Each instance is backed by a real `valkey-server` process, so
`discoveryEndpoints` is something a Valkey client can actually connect to. Set
`MEMORYSTORE_DATA_PLANE=false` for metadata-only endpoints. If the
`valkey-server` binary is not on `PATH`, instances degrade to metadata-only
automatically — see [ADR-007](docs/adrs/007-memorystore-valkey-data-plane.md).

**Instances**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/projects/{project}/locations/{location}/instances` | Create instance |
| `GET` | `/v1/projects/{project}/locations/{location}/instances` | List instances |
| `GET` | `/v1/projects/{project}/locations/{location}/instances/{instance}` | Get instance |
| `PATCH` | `/v1/projects/{project}/locations/{location}/instances/{instance}` | Update instance |
| `DELETE` | `/v1/projects/{project}/locations/{location}/instances/{instance}` | Delete instance |
| `GET` | `/v1/projects/{project}/locations/{location}/instances/{instance}/certificateAuthority` | Get certificate authority |
| `POST` | `/v1/projects/{project}/locations/{location}/instances/{instance}:backup` | Backup instance |
| `POST` | `/v1/projects/{project}/locations/{location}/instances/{instance}:startMigration` | Start migration |
| `POST` | `/v1/projects/{project}/locations/{location}/instances/{instance}:finishMigration` | Finish migration |
| `POST` | `/v1/projects/{project}/locations/{location}/instances/{instance}:rescheduleMaintenance` | Reschedule maintenance |
| `POST` | `/v1/projects/{project}/locations/{location}/instances/{instance}:addTokenAuthUser` | Add token auth user |

**Token auth**

> These endpoints manage metadata only. Tokens are stored but not enforced on
> the Valkey connection today — the data plane is unauthenticated regardless of
> tokens created or an instance's `authorizationMode`. See ADR-007.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/projects/{project}/locations/{location}/instances/{instance}/tokenAuthUsers` | List token auth users |
| `GET` | `/v1/projects/{project}/locations/{location}/instances/{instance}/tokenAuthUsers/{tokenAuthUser}` | Get token auth user |
| `DELETE` | `/v1/projects/{project}/locations/{location}/instances/{instance}/tokenAuthUsers/{tokenAuthUser}` | Delete token auth user |
| `POST` | `/v1/projects/{project}/locations/{location}/instances/{instance}/tokenAuthUsers/{tokenAuthUser}:addAuthToken` | Add auth token |
| `GET` | `/v1/projects/{project}/locations/{location}/instances/{instance}/tokenAuthUsers/{tokenAuthUser}/authTokens` | List auth tokens |
| `GET` | `/v1/projects/{project}/locations/{location}/instances/{instance}/tokenAuthUsers/{tokenAuthUser}/authTokens/{authToken}` | Get auth token |
| `DELETE` | `/v1/projects/{project}/locations/{location}/instances/{instance}/tokenAuthUsers/{tokenAuthUser}/authTokens/{authToken}` | Delete auth token |

**Backups**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/projects/{project}/locations/{location}/backupCollections` | List backup collections |
| `GET` | `/v1/projects/{project}/locations/{location}/backupCollections/{backupCollection}` | Get backup collection |
| `GET` | `/v1/projects/{project}/locations/{location}/backupCollections/{backupCollection}/backups` | List backups |
| `GET` | `/v1/projects/{project}/locations/{location}/backupCollections/{backupCollection}/backups/{backup}` | Get backup |
| `DELETE` | `/v1/projects/{project}/locations/{location}/backupCollections/{backupCollection}/backups/{backup}` | Delete backup |
| `POST` | `/v1/projects/{project}/locations/{location}/backupCollections/{backupCollection}/backups/{backup}:export` | Export backup |

**ACL policies**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/projects/{project}/locations/{location}/aclPolicies` | Create ACL policy |
| `GET` | `/v1/projects/{project}/locations/{location}/aclPolicies` | List ACL policies |
| `GET` | `/v1/projects/{project}/locations/{location}/aclPolicies/{aclPolicy}` | Get ACL policy |
| `PATCH` | `/v1/projects/{project}/locations/{location}/aclPolicies/{aclPolicy}` | Update ACL policy |
| `DELETE` | `/v1/projects/{project}/locations/{location}/aclPolicies/{aclPolicy}` | Delete ACL policy |
| `GET` | `/v1/projects/{project}/locations/{location}/aclPolicies/{aclPolicy}/revisions` | List ACL policy revisions |
| `GET` | `/v1/projects/{project}/locations/{location}/aclPolicies/{aclPolicy}/revisions/{revision}` | Get ACL policy revision |

**Operations**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/projects/{project}/locations/{location}/operations` | List operations |
| `GET` | `/v1/projects/{project}/locations/{location}/operations/{operation}` | Get operation |
| `DELETE` | `/v1/projects/{project}/locations/{location}/operations/{operation}` | Delete operation |
| `POST` | `/v1/projects/{project}/locations/{location}/operations/{operation}:cancel` | Cancel operation |

**Locations**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/projects/{project}/locations` | List locations |
| `GET` | `/v1/projects/{project}/locations/{location}` | Get location |
| `GET` | `/v1/projects/{project}/locations/{location}/sharedRegionalCertificateAuthority` | Get shared regional certificate authority |

### AlloyDB for PostgreSQL (v1) — Experimental

Emulates the **control plane only**: 23 of the API's 40 v1 methods. Specification:
`https://alloydb.googleapis.com/$discovery/rest?version=v1`.

> **IMPORTANT:** there is no data plane. No PostgreSQL server is started, so
> `Instance.ipAddress` and `ConnectionInfo.ipAddress` always report `127.0.0.1` as a
> placeholder to keep the response shape correct. You cannot connect a `psql` or `pg`
> client to an emulated instance.

Every cluster and instance mutation returns a `google.longrunning.Operation` that is
already `done` — the emulator applies mutations synchronously, so a client that polls
until `done` terminates on its first read. **User mutations are the exception:** per the
discovery document they return the `User` resource directly (and `Empty` for delete),
not an Operation.

**Clusters**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/projects/{project}/locations/{location}/clusters?clusterId={id}` | Create cluster (id is a **query** parameter; `initialUser` is required) |
| `GET` | `/v1/projects/{project}/locations/{location}/clusters` | List clusters |
| `GET` | `/v1/projects/{project}/locations/{location}/clusters/{cluster}` | Get cluster |
| `PATCH` | `/v1/projects/{project}/locations/{location}/clusters/{cluster}` | Update cluster (`updateMask`, `allowMissing`) |
| `DELETE` | `/v1/projects/{project}/locations/{location}/clusters/{cluster}` | Delete cluster (`force=true` to cascade to child instances) |

**Instances**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/projects/{project}/locations/{location}/clusters/{cluster}/instances?instanceId={id}` | Create instance |
| `GET` | `/v1/projects/{project}/locations/{location}/clusters/{cluster}/instances` | List instances |
| `GET` | `/v1/projects/{project}/locations/{location}/clusters/{cluster}/instances/{instance}` | Get instance |
| `PATCH` | `/v1/projects/{project}/locations/{location}/clusters/{cluster}/instances/{instance}` | Update instance |
| `DELETE` | `/v1/projects/{project}/locations/{location}/clusters/{cluster}/instances/{instance}` | Delete instance |
| `GET` | `/v1/projects/{project}/locations/{location}/clusters/{cluster}/instances/{instance}/connectionInfo` | Get connection info |

**Users** — synchronous; these return `User`, not an Operation

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/projects/{project}/locations/{location}/clusters/{cluster}/users?userId={id}` | Create user |
| `GET` | `/v1/projects/{project}/locations/{location}/clusters/{cluster}/users` | List users |
| `GET` | `/v1/projects/{project}/locations/{location}/clusters/{cluster}/users/{user}` | Get user |
| `PATCH` | `/v1/projects/{project}/locations/{location}/clusters/{cluster}/users/{user}` | Update user |
| `DELETE` | `/v1/projects/{project}/locations/{location}/clusters/{cluster}/users/{user}` | Delete user (returns `{}`) |

**Operations, locations and flags**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/projects/{project}/locations/{location}/operations` | List operations |
| `GET` | `/v1/projects/{project}/locations/{location}/operations/{operation}` | Get operation |
| `DELETE` | `/v1/projects/{project}/locations/{location}/operations/{operation}` | Delete operation |
| `POST` | `/v1/projects/{project}/locations/{location}/operations/{operation}:cancel` | Cancel operation |
| `GET` | `/v1/projects/{project}/locations` | List locations |
| `GET` | `/v1/projects/{project}/locations/{location}` | Get location |
| `GET` | `/v1/projects/{project}/locations/{location}/supportedDatabaseFlags` | List supported database flags |

#### Not implemented

Absent rather than stubbed, so a call fails locally instead of appearing to work:

- **Backups** — all of `backups.create`, `.get`, `.list`, `.patch`, `.delete`
- **Cluster verbs** — `createsecondary`, `promote`, `switchover`, `restore`,
  `restoreFromCloudSQL`, `export`, `import`, `upgrade`
- **Instance verbs** — `createsecondary`, `failover`, `injectFault`, `restart`

#### Accepted but ignored

- `requestId` — no idempotency de-duplication; a retried request creates a second resource
- `etag` — no optimistic concurrency checking
- `filter` and `orderBy` on list methods — `pageSize`/`pageToken`/`nextPageToken` *are* honoured,
  including on `locations.list` and `supportedDatabaseFlags.list`
- `view` on `clusters.get` and `instances.get` — a `CLUSTER_VIEW_BASIC` request still receives the
  full resource, so a test that passes here could mask a real under-fetch
- `scope` on `supportedDatabaseFlags.list`, and `extraLocationTypes` / `returnPartialSuccess`
  on `locations.list`
- `Cluster.initialUser` — both `user` and `password` are required on create, as in real
  AlloyDB; the username is retained, the password is validated then discarded (no data plane
  to create a role in), and neither is ever returned

#### Other known limitations

- `supportedDatabaseFlags` returns a small representative subset; real AlloyDB returns hundreds.
  The discovery document describes the shape but carries no flag data.
- Locations are the same generic GCP region list the other services use, not AlloyDB's real
  regional availability, which is not published in the discovery document.
- Top-level enum fields are normalized whether sent as a name (`"PRIMARY"`) or as a proto wire
  number (`1`, which is what the official client's REST fallback sends). Enums **nested inside
  sub-messages** are round-tripped verbatim, so a numeric one is read back as a number.
- `Cluster.databaseVersion` defaults to `POSTGRES_15` when unspecified; the discovery document
  does not state the real default.
- Listing instances or users under a cluster that does not exist returns `404 NOT_FOUND`. The
  discovery document does not specify whether real AlloyDB 404s or returns an empty page.
- Cluster creation requires networking in one of the three legitimate shapes —
  `networkConfig.network`, the deprecated `network` field, or `pscConfig` for a PSC-only cluster.
  `Cluster.network` is documented "Required… Deprecated, use network_config.network instead", so
  requiring the deprecated field alone would reject valid modern requests, while accepting a
  cluster with no networking at all would accept what production rejects.
- `Instance.nodes` and `Instance.writableNode` are never populated — they describe real compute
  VMs. A `readPoolConfig.nodeCount` is echoed back, but no corresponding `nodes` array appears.
- Instance creation and any type-changing `PATCH` enforce AlloyDB's placement rules so a shape
  production rejects fails locally too: a cluster may hold at most one `PRIMARY` and a `READ_POOL`
  requires an existing primary (both `FAILED_PRECONDITION`), and a `SECONDARY` cannot be created
  through the normal path (`INVALID_ARGUMENT`) since `instances.createsecondary` is not
  implemented. Because a demotion of the sole primary would leave the cluster with none,
  `instanceType` is in practice only reassignable to itself — matching real AlloyDB, where it is
  fixed at creation. The discovery document describes the enum but not these preconditions, so the
  error codes are inferred.

### Cloud SQL (v1)

Control-plane emulation of the sqladmin v1 API: instances, databases, users,
and operations are stored as records, but there is no connectable database
behind an instance (a PGlite-backed data plane is planned as a follow-up).
PostgreSQL is the only supported engine — `MYSQL_*` and `SQLSERVER_*`
`databaseVersion` values are rejected with 400 `INVALID_ARGUMENT`.

**Instances**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/projects/{project}/instances` | Create instance |
| `GET` | `/v1/projects/{project}/instances/{instance}` | Get instance |
| `GET` | `/v1/projects/{project}/instances` | List instances |
| `DELETE` | `/v1/projects/{project}/instances/{instance}` | Delete instance |
| `PATCH` | `/v1/projects/{project}/instances/{instance}` | Patch instance |
| `PUT` | `/v1/projects/{project}/instances/{instance}` | Update instance |
| `POST` | `/v1/projects/{project}/instances/{instance}/restart` | Restart instance |

**Databases**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/projects/{project}/instances/{instance}/databases` | Create database |
| `GET` | `/v1/projects/{project}/instances/{instance}/databases/{database}` | Get database |
| `GET` | `/v1/projects/{project}/instances/{instance}/databases` | List databases |
| `PATCH` | `/v1/projects/{project}/instances/{instance}/databases/{database}` | Patch database |
| `PUT` | `/v1/projects/{project}/instances/{instance}/databases/{database}` | Update database |
| `DELETE` | `/v1/projects/{project}/instances/{instance}/databases/{database}` | Delete database |

**Users**

> `users.update` and `users.delete` identify the target user via `?name=` and
> `?host=` query parameters rather than a path segment, matching the sqladmin
> v1 discovery document.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/projects/{project}/instances/{instance}/users` | Create user |
| `GET` | `/v1/projects/{project}/instances/{instance}/users/{name}` | Get user |
| `GET` | `/v1/projects/{project}/instances/{instance}/users` | List users |
| `PUT` | `/v1/projects/{project}/instances/{instance}/users` | Update user |
| `DELETE` | `/v1/projects/{project}/instances/{instance}/users` | Delete user |

**Operations**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/projects/{project}/operations/{operation}` | Get operation |
| `GET` | `/v1/projects/{project}/operations` | List operations |

> `operations.list` supports filtering by instance via `?instance=`.

> **Limitations:**
>
> - Control-plane emulation only — instances are records, not connectable
>   databases (a PGlite-backed data plane is planned as a follow-up).
> - PostgreSQL only — `MYSQL_*` / `SQLSERVER_*` `databaseVersion` values are
>   rejected with 400 `INVALID_ARGUMENT`.
> - Optional parameters accepted but silently ignored: `instances.list`'s
>   `filter`; `instances.delete`'s `enableFinalBackup`, `finalBackupTtlDays`,
>   `finalBackupExpiryTime`, `finalBackupDescription`; `instances.patch`'s
>   `reconcilePscNetworking`, `reconcilePscNetworkingForce`; `users.update`'s
>   `databaseRoles`, `serverRoles`, `revokeExistingRoles`,
>   `revokeExistingServerRoles`; and `operations.get`'s / `operations.list`'s
>   `location`.
> - Operations complete synchronously (`status: "DONE"` immediately on
>   return) but remain pollable via `operations.get` for API compatibility.
>
> **Not implemented:** the remaining 28 `instances` methods (`clone`,
> `failover`, `import`, `export`, read replicas, SSL certificate management,
> `executeSql`, …), `backupRuns`, `Backups`, `sslCerts`, `connect`, `flags`,
> `tiers`, `projects.instances.*`, and `operations.cancel`.

## Storage

The emulator supports three storage modes via the `STORAGE_TYPE` variable:

- **`memory`** — Fast, ephemeral. Data is lost when the container stops. Good for CI and short-lived tests.
- **`sqlite`** — Persistent. Data stored in a SQLite database at `SQLITE_PATH`. Survives restarts.
- **`hybrid`** (default) — LRU memory cache backed by SQLite. Fast reads with persistence. Best for local development.

To persist data across container restarts, mount the data directory:

```bash
docker run -d -p 8765:8765 -v ./data:/app/data ghcr.io/gauthamchandra/kinglet:latest
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
docker pull ghcr.io/gauthamchandra/kinglet:1.2.3

# Track latest within major version
docker pull ghcr.io/gauthamchandra/kinglet:1
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

- [Bun](https://bun.sh) >= 1.1.0 (this repo pins **1.3.4** in `.tool-versions`)

### Setup

```bash
bun install
bun run dev       # start with hot reload
bun test          # unit + integration tests
bun run test:e2e  # end-to-end suite
bun run lint      # typecheck + biome + knip
```

### Where to go next

| I want to… | Read |
|---|---|
| Contribute anything | **[CONTRIBUTING.md](CONTRIBUTING.md)** — scope, fidelity contract, quality bar, DCO, AI policy |
| Add a new GCP service | [docs/adding-a-service.md](docs/adding-a-service.md) |
| Understand why it's built this way | [docs/adrs/](docs/adrs/) |
| Configure an AI agent | [AGENTS.md](AGENTS.md) (`CLAUDE.md` is a symlink to it) |

## Contributing

Contributions are welcome — new service emulations, missing endpoints, fidelity fixes, and docs.

**Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.** Two things to know up front:

1. **New services and API gaps need an accepted issue before you write code.** Declining a finished PR is expensive for you, and the issue takes five minutes.
2. **kinglet only emulates what real GCP actually does.** Every emulated endpoint is checked against the official [Google Discovery Document](discovery-document-registry.json) for that API.

kinglet has one maintainer and no response-time commitment — see [support expectations](CONTRIBUTING.md#support-expectations).

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[Apache License 2.0](LICENSE).

kinglet is not affiliated with, endorsed by, or sponsored by Google LLC. "Google Cloud", "Google Cloud Platform", "GCP", and the service names above are trademarks of Google LLC, used here only to describe which APIs this software emulates.
