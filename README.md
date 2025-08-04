# GCP Local Emulator

Local emulator for Google Cloud Platform services, implementing GCP REST APIs for development and testing.

## Quick Start

```bash
./gradlew quarkusDev  # Start in development mode
# Access at http://localhost:8080
```

## Service Integration

### Service Enablement Required

All GCP services must be enabled before use via the Service Usage API:

```bash
# Enable Secret Manager
curl -X POST http://localhost:8080/v1/projects/my-project/services/secretmanager.googleapis.com:enable

# Now Secret Manager operations work
curl -X POST http://localhost:8080/v1/projects/my-project/secrets \
  -H "Content-Type: application/json" \
  -d '{"secretId": "my-secret"}'

# List enabled services
curl http://localhost:8080/v1/projects/my-project/services?filter=state:ENABLED
```

### Available Services

| Service | API Name | Status |
|---------|----------|--------|
| Secret Manager | `secretmanager.googleapis.com` | ✅ Implemented |
| Service Usage | `serviceusage.googleapis.com` | ✅ Implemented |
| Cloud Tasks | `cloudtasks.googleapis.com` | 📋 Planned |
| Cloud Scheduler | `cloudscheduler.googleapis.com` | 📋 Planned |

## API Endpoints

### Service Usage API (`/v1`)

```bash
# Single service operations
POST /v1/projects/{project}/services/{service}:enable
POST /v1/projects/{project}/services/{service}:disable

# Batch operations
POST /v1/projects/{project}/services:batchEnable
POST /v1/projects/{project}/services:batchDisable

# List and query
GET /v1/projects/{project}/services[?filter=state:ENABLED|DISABLED]
GET /v1/operations/{operationName}
```

### Secret Manager API (`/v1/projects/{project}/secrets`)

Standard GCP Secret Manager REST API endpoints (requires service enablement).

## Integration Patterns

### Terraform Provider Integration

```hcl
# Enable services first
resource "google_project_service" "secret_manager" {
  project = "my-project"
  service = "secretmanager.googleapis.com"
}

# Then use the service
resource "google_secret_manager_secret" "example" {
  secret_id = "example-secret"
  depends_on = [google_project_service.secret_manager]
}
```

### Client Library Integration

Point GCP client libraries to the emulator:

```bash
export GOOGLE_CLOUD_PROJECT=my-project
export SECRETMANAGER_EMULATOR_HOST=localhost:8080
```

## Development

### Adding New Services

1. **Add service definition** to `ServiceRegistry.initializeDefaultServices()`
2. **Implement service logic** following the Secret Manager pattern
3. **Add service validation** to operations
4. **Update tests** and documentation

### Build Commands

```bash
./gradlew build                    # Full build with tests
./gradlew quarkusDev              # Development mode with hot reload
./gradlew spotlessApply           # Fix code formatting
./gradlew test                    # Run tests only
```

### Docker

```bash
docker build -t gcp-emulator .
docker run -p 8080:8080 gcp-emulator
```

## Architecture

- **ServiceRegistry**: Central service state management
- **ServiceUsageService**: Business logic for service operations
- **ServiceUsageResource**: REST API endpoints
- **Integration**: Services validate enablement before operations

Data stored in-memory with ConcurrentHashMap for development/testing use cases.

## Troubleshooting

**Service not enabled errors**: Enable the service via Service Usage API first
**Port conflicts**: Change port with `-Dquarkus.http.port=8081`
**Native build issues**: Use container build option or check GraalVM compatibility
