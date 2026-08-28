# Connecting GCP client libraries

The core idea: point your GCP client library at `http://localhost:8765` instead of the real GCP endpoint and disable authentication.

## Node.js

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

## Python

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

## Go

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

## Plain HTTP

All services expose standard GCP REST endpoints, so plain `curl` or `fetch` works:

```bash
# Create a Cloud Tasks queue
curl -X POST http://localhost:8765/v2/projects/test-project/locations/us-central1/queues \
  -H "Content-Type: application/json" \
  -d '{"name": "projects/test-project/locations/us-central1/queues/my-queue"}'
```

## API reference

Per-service route tables are generated from the kinglet codebase. See [API reference](../reference/api/index.md).
