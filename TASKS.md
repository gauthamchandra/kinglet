# Implementation Tasks - LocalStack GCP Emulator

## Executive Summary

This document provides a comprehensive task breakdown for implementing the
LocalStack GCP emulator based on the approved REQUIREMENTS.md and DESIGN.md
documents. The implementation is organized into 5 phases with discrete, testable
tasks that build incrementally toward a fully functional system.

## Implementation Phases

### Phase Overview

1. **Foundation (Week 1)**: Core infrastructure, tooling, and project setup
2. **Test Migration (Week 1.5)**: Transition to co-located testing structure
3. **Core Framework (Week 2)**: API Gateway, Discovery API, Storage Layer
4. **Service Implementation (Weeks 3-6)**: Individual GCP service emulation (Pub/Sub, Scheduler, Tasks, Secrets, Cloud Storage)
5. **Integration & Testing (Week 7)**: End-to-end testing, client library
   validation
6. **Deployment & Documentation (Week 8)**: Containerization, deployment,
   documentation

## Phase 1: Foundation Setup

### 1. Project Infrastructure

- [x] **1.1 Initialize Bun TypeScript Project**
  - Create project directory structure
  - Initialize package.json with Bun
  - Configure TypeScript with tsconfig.json
  - Set up path aliases for clean imports
  - **Deliverable**: Working Bun project with TypeScript support
  - **Success Criteria**: `bun run --version` works, TypeScript compiles

- [x] **1.2 Configure Development Tooling**
  - Set up asdf with .tool-versions file
  - Configure ESLint for TypeScript/Bun
  - Set up Prettier with project conventions
  - Configure husky for pre-commit hooks
  - Add commitlint for conventional commits
  - **Deliverable**: Consistent development environment
  - **Success Criteria**: Linting and formatting work on commit

- [x] **1.3 Establish Project Structure**
  - Create src/core directory for framework
  - Create src/services directory for GCP services
  - Create src/shared directory for utilities
  - Create tests directory with unit/integration/e2e subdirectories
  - Set up configuration directory
  - **Deliverable**: Organized project structure
  - **Success Criteria**: Clear separation of concerns

- [x] **1.4 Set Up Testing Framework**
  - Configure Bun test runner
  - Set up test utilities and helpers
  - Create test database fixtures
  - Configure coverage reporting
  - **Deliverable**: Working test suite
  - **Success Criteria**: `bun test` runs successfully

- [x] **1.5 Initialize Git Repository**
  - Create .gitignore for Bun/TypeScript
  - Set up branch protection rules
  - Configure GitHub Actions workflow
  - Create initial ADR (Architecture Decision Record)
  - **Deliverable**: Version-controlled project
  - **Success Criteria**: CI/CD pipeline runs on push

### 2. Core Dependencies Installation

- [x] **2.1 Install Runtime Dependencies**
  - Add @grpc/grpc-js for gRPC support
  - Add @grpc/proto-loader for protobuf
  - Add zod for validation
  - Add pino for logging
  - Add cron-parser for scheduler
  - **Deliverable**: Installed core dependencies
  - **Success Criteria**: All imports resolve correctly

- [x] **2.2 Install Development Dependencies**
  - Add @types/bun
  - Add typescript
  - Add @types/node for compatibility
  - ~~Add vitest for additional testing~~ (not used; Bun's built-in test runner is used exclusively per ADR-002)
  - Add docker for container building
  - **Deliverable**: Complete dev environment
  - **Success Criteria**: TypeScript types work correctly

### 3. Configuration System

- [x] **3.1 Create Configuration Schema**
  - Define Config interface with Zod
  - Create environment variable mapping
  - Implement configuration validation
  - **Deliverable**: Type-safe configuration
  - **Success Criteria**: Config validates at runtime
  - **Status**: ✅ Complete - Comprehensive Zod schema implemented with full TypeScript support
  - **Implementation**: src/config/schema.ts with ConfigSchema, EnvConfigSchema, and validation functions
  - **Tests**: tests/unit/config-schema.test.ts (100% passing)

- [x] **3.2 Implement Configuration Loader**
  - Load from environment variables
  - Load from config files
  - Merge configurations with precedence
  - Validate final configuration
  - **Deliverable**: Flexible configuration system
  - **Success Criteria**: Multiple config sources work
  - **Status**: ✅ Complete - Multi-source configuration loader with intelligent merging and caching
  - **Implementation**: src/config/loader.ts with ConfigLoader, JsonConfigSource, EnvConfigSource classes
  - **Features**: Environment variables, JSON files, precedence system, caching, error handling
  - **Tests**: tests/unit/config-loader.test.ts (100% passing)

## Phase 1.5: Test Structure Migration

### Test Organization Transition

- [x] **1.5.1 Update Test Configuration for Co-located Structure**
  - Update package.json test scripts to support co-located test discovery
  - Configure Bun test runner to find *.test.ts files throughout src/
  - Update test coverage configuration to exclude test files from coverage reports
  - Set up test watch mode patterns for co-located tests
  - **Deliverable**: Updated test configuration supporting co-located structure
  - **Success Criteria**: `bun test` discovers all tests in both old and new locations
  - **Status**: ✅ Complete - Updated bunfig.toml with streamlined *.test.ts naming convention
  - **Implementation**: bunfig.toml configured to discover co-located *.test.ts files and exclude test files from coverage

- [x] **1.5.2 Create Shared Test Utilities Structure**
  - ~~Create src/shared/test-utils/ directory for common test helpers~~
  - ~~Move tests/helpers.ts to src/shared/test-utils/helpers.ts~~
  - ~~Move tests/fixtures.ts to src/shared/test-utils/fixtures.ts~~
  - Create test database utilities in test-utils/database.ts
  - ~~Update import paths in existing tests to use new shared utilities~~
  - **Deliverable**: Centralized test utilities accessible to all co-located tests
  - **Success Criteria**: All shared test utilities work from new locations
  - **Status**: ✅ Complete - Kept existing test-utils/ structure (better than src/shared/test-utils/)
  - **Implementation**: Created test-utils/database.ts for shared database utilities; existing helpers.ts and fixtures.ts already in optimal location
  - **Design Decision**: test-utils/ at project root is preferable to src/shared/test-utils/ since test utilities should not be in production code directory

- [x] **1.5.3 Migrate Foundation Tests to Co-located Structure**
  - ~~Move tests/unit/dependencies.test.ts to src/shared/test-utils/dependencies.test.ts~~
  - ~~Move tests/unit/dev-dependencies.test.ts to src/shared/test-utils/dev-dependencies.test.ts~~
  - ~~Update import paths in migrated test files~~
  - Verify all foundation tests still pass in new locations
  - **Deliverable**: Foundation tests co-located with appropriate modules
  - **Success Criteria**: All foundation tests pass in new locations
  - **Status**: ✅ Complete - Foundation tests already in optimal location
  - **Implementation**: Dependencies tests already located in test-utils/ directory and working properly
  - **Design Decision**: Foundation tests belong in test-utils/ (project-wide scope) rather than src/shared/test-utils/

- [x] **1.5.4 Create E2E Test Directory Structure**
  - Create e2e/ directory for end-to-end tests (separate from co-located tests)
  - Set up e2e test configuration separate from unit/integration tests
  - Create e2e/setup.ts for end-to-end test initialization
  - Configure e2e tests to run independently of co-located tests
  - **Deliverable**: Dedicated e2e test infrastructure
  - **Success Criteria**: E2E tests can run independently and don't interfere with co-located tests
  - **Status**: ✅ Complete - Full E2E test infrastructure with independent configuration
  - **Implementation**: Created e2e/ directory with bunfig.toml, setup.ts, and sample test; added `bun run test:e2e` script
  - **Features**: Independent test configuration, separate port allocation (19000/19001), sample workflow test structure

## Phase 2: Core Framework

### 4. Storage Layer

- [x] **4.1 Create Storage Abstraction Interface**
  - Define StorageProvider interface
  - Define query interfaces
  - Define transaction interfaces
  - Create type definitions
  - **Deliverable**: Storage abstraction layer
  - **Success Criteria**: Clean separation from implementation

- [x] **4.2 Implement SQLite Storage**
  - Initialize Bun SQLite database
  - Create connection pool wrapper
  - Implement CRUD operations
  - Add transaction support
  - Create migration system
  - **Deliverable**: Working SQLite backend
  - **Success Criteria**: All CRUD operations work

- [x] **4.3 Implement In-Memory Cache**
  - Create LRU cache implementation
  - Add TTL support
  - Implement cache invalidation
  - Add cache statistics
  - **Deliverable**: High-performance cache layer
  - **Success Criteria**: Sub-millisecond access times

- [x] **4.4 Create Hybrid Storage Manager**
  - Implement cache-through logic
  - Add write-behind support
  - Create eviction policies
  - Add persistence strategies
  - **Deliverable**: Unified storage interface
  - **Success Criteria**: Transparent caching works

### 5. HTTP Server

- [x] **5.1 Set Up Bun HTTP Server**
  - Initialize Bun.serve on port 8765
  - Configure request routing
  - Add middleware support
  - Implement error handling
  - **Deliverable**: Basic HTTP server
  - **Success Criteria**: Server responds to requests
  - **Status**: ✅ Complete - High-performance HTTP server with routing and middleware support
  - **Implementation**: src/core/gateway/http-server.ts with comprehensive request handling and graceful shutdown
  - **Tests**: src/core/gateway/http-server.test.ts (100% passing)

- [x] **5.2 Implement Request Pipeline**
  - Add request logging middleware
  - Add CORS middleware
  - Add compression middleware
  - Add security headers
  - Create request context
  - **Deliverable**: Complete request pipeline
  - **Success Criteria**: All middleware functions work
  - **Status**: ✅ Complete - Full middleware pipeline with logging, CORS, security headers, and rate limiting
  - **Implementation**: src/core/gateway/middleware.ts with comprehensive request processing and error handling
  - **Tests**: src/core/gateway/middleware.test.ts (100% passing)

- [x] **5.3 Create Response Handlers**
  - Implement JSON response formatter
  - Add error response formatting
  - Create streaming response support
  - Add response compression
  - **Deliverable**: Consistent response handling
  - **Success Criteria**: Proper content types and formats
  - **Status**: ✅ Complete - Standardized response formatting with GCP-style error responses and streaming support
  - **Implementation**: src/core/gateway/response-handlers.ts with JSON formatting, pagination, and error handling
  - **Tests**: src/core/gateway/response-handlers.test.ts (100% passing)

### 6. gRPC Server

- [x] **6.1 Initialize gRPC Server**
  - Set up gRPC server on port 8766
  - Configure service registration
  - Add reflection support
  - Implement health check service
  - **Deliverable**: Working gRPC server
  - **Success Criteria**: gRPC reflection works
  - **Status**: ✅ Complete - Full gRPC server with service registration, health checks, and streaming support
  - **Implementation**: src/core/gateway/grpc-server.ts with comprehensive gRPC service management
  - **Tests**: src/core/gateway/grpc-server.test.ts (100% passing)

- [x] **6.2 Create Protocol Buffer Definitions**
  - Define common message types
  - Create service definitions
  - Generate TypeScript types
  - Set up proto compilation
  - **Deliverable**: Proto definitions and types
  - **Success Criteria**: Types match GCP exactly
  - **Status**: ✅ Complete - Comprehensive TypeScript type definitions for all GCP services with conversion utilities
  - **Implementation**: src/core/gateway/proto-types.ts with full Pub/Sub, Scheduler, Tasks, and Secret Manager types
  - **Tests**: src/core/gateway/proto-types.test.ts (100% passing)

- [x] **6.3 Implement gRPC-REST Bridge**
  - Create transcoding logic
  - Map gRPC methods to REST
  - Handle streaming responses
  - Add protocol detection
  - **Deliverable**: Unified API surface
  - **Success Criteria**: Both protocols work identically
  - **Status**: ✅ Complete - Advanced transcoding system enabling dual gRPC/REST protocol support
  - **Implementation**: src/core/gateway/grpc-rest-bridge.ts with intelligent protocol detection and transcoding
  - **Tests**: src/core/gateway/grpc-rest-bridge.test.ts (100% passing)

### 7. Discovery API

- [x] **7.1 Create Discovery Document Generator**
  - Define Discovery Document schema
  - Create resource builders
  - Add method definitions
  - Generate parameter schemas
  - **Deliverable**: Discovery document generator
  - **Success Criteria**: Valid Discovery documents
  - **Status**: ✅ Complete - Google API Discovery document generation for service introspection
  - **Implementation**: src/core/discovery/discovery-document-generator.ts with complete API documentation generation
  - **Tests**: src/core/discovery/discovery-document-generator.test.ts (100% passing)

- [x] **7.2 Implement Service Registry**
  - Create service registration interface
  - Add version management
  - Implement service discovery
  - Add health checking
  - **Deliverable**: Dynamic service registry
  - **Success Criteria**: Services auto-register
  - **Status**: ✅ Complete - Service registry with comprehensive health checking and version management
  - **Implementation**: src/core/discovery/service-registry.ts with event-driven architecture and circuit breaker patterns
  - **Tests**: src/core/discovery/service-registry.test.ts (97.78% function coverage)

- [x] **7.3 Build Discovery API Endpoints**
  - Implement /\$discovery/rest endpoint
  - Add API listing endpoint
  - Create version negotiation
  - Add schema validation
  - **Deliverable**: Complete Discovery API
  - **Success Criteria**: Client libraries recognize API
  - **Status**: ✅ Complete - Full Google API Discovery format compliance with caching and field selection
  - **Implementation**: src/core/discovery/discovery-endpoints.ts with JSONP support and multiple response formats
  - **Tests**: src/core/discovery/discovery-endpoints.test.ts (comprehensive endpoint testing)

### 8. API Gateway

- [x] **8.1 Create Request Router**
  - Implement path matching
  - Add parameter extraction
  - Create method routing
  - Handle wildcards
  - **Deliverable**: Intelligent request router
  - **Success Criteria**: All paths route correctly
  - **Status**: ✅ Complete - Advanced path matching with parameter patterns and efficient trie-based lookups
  - **Implementation**: src/core/gateway/request-router.ts with middleware chain execution and route validation
  - **Tests**: src/core/gateway/request-router.test.ts (comprehensive routing logic testing)

- [x] **8.2 Implement Service Dispatcher**
  - Create service lookup
  - Add load balancing
  - Implement circuit breaker
  - Add retry logic
  - **Deliverable**: Reliable service dispatch
  - **Success Criteria**: Requests reach correct service
  - **Status**: ✅ Complete - Multi-strategy load balancing with circuit breaker and exponential backoff retry
  - **Implementation**: src/core/gateway/service-dispatcher.ts with sticky sessions and comprehensive metrics
  - **Tests**: src/core/gateway/service-dispatcher.test.ts (reliability patterns and load balancing tested)

- [x] **8.3 Build Validation Layer**
  - Integrate Zod validation
  - Create custom validators
  - Add request sanitization
  - Implement quota checking
  - **Deliverable**: Request validation
  - **Success Criteria**: Invalid requests rejected
  - **Status**: ✅ Complete - Deep Zod integration with comprehensive sanitization and quota management
  - **Implementation**: src/core/gateway/validation-layer.ts with GCP-specific validators and multiple quota storage backends
  - **Tests**: src/core/gateway/validation-layer.test.ts (93.06% coverage with quota and sanitization testing)

## Phase 3: Service Implementation

### 9. Pub/Sub Service

- [ ] **9.1 Create Pub/Sub Data Models**
  - Define Topic interface
  - Define Subscription interface
  - Define Message interface
  - Create database schema
  - **Deliverable**: Pub/Sub data layer
  - **Success Criteria**: Models match GCP spec

- [ ] **9.2 Implement Topic Management**
  - Create topic CRUD operations
  - Add topic validation
  - Implement topic listing
  - Add label support
  - Write comprehensive unit tests co-located with topic implementation
  - **Deliverable**: Topic management API with co-located tests
  - **Success Criteria**: All topic operations work and tests pass

- [ ] **9.3 Build Subscription System**
  - Create subscription CRUD
  - Implement pull subscriptions
  - Add push subscription support
  - Create filter expressions
  - Add dead letter support
  - Write comprehensive unit tests co-located with subscription implementation
  - **Deliverable**: Subscription management with co-located tests
  - **Success Criteria**: Subscriptions receive messages and all tests pass

- [ ] **9.4 Implement Message Broker**
  - Create message publishing
  - Add message ordering
  - Implement acknowledgment
  - Add retry logic
  - Create delivery tracking
  - Write integration tests co-located with message broker implementation
  - **Deliverable**: Complete message flow with co-located tests
  - **Success Criteria**: End-to-end messaging works and all tests pass

- [ ] **9.5 Add Pub/Sub Discovery Document**
  - Generate Discovery Document
  - Register with Discovery API
  - Validate against GCP spec
  - Test with client library
  - **Deliverable**: Pub/Sub Discovery integration
  - **Success Criteria**: Client library connects

### 10. Cloud Scheduler Service

- [x] **10.1 Create Scheduler Data Models**
  - Define Job interface
  - Create schedule representation
  - Add retry configuration
  - Create database schema
  - **Deliverable**: Scheduler data layer
  - **Success Criteria**: Models match GCP spec
  - **Status**: ✅ Complete - Full job data models with DB schema and conversion utilities
  - **Implementation**: src/services/scheduler/types.ts with JobRecord, HttpTarget, RetryConfig interfaces
  - **Tests**: src/services/scheduler/types.test.ts (100% passing)

- [x] **10.2 Implement Job Management**
  - Create job CRUD operations
  - Add job validation
  - Implement job listing
  - Add state management
  - Write comprehensive unit tests co-located with job implementation
  - **Deliverable**: Job management API with co-located tests
  - **Success Criteria**: Jobs can be created/modified and all tests pass
  - **Status**: ✅ Complete - Full CRUD with pagination, state management, and duplicate detection
  - **Implementation**: src/services/scheduler/repository.ts, service.ts, handlers.ts
  - **Tests**: repository.test.ts, service.test.ts, handlers.test.ts (all passing)

- [x] **10.3 Build Cron Engine**
  - Integrate cron-parser
  - Create schedule calculator
  - Add timezone support
  - Implement next-run computation
  - Write comprehensive unit tests co-located with cron engine implementation
  - **Deliverable**: Cron scheduling engine with co-located tests
  - **Success Criteria**: Accurate schedule calculation and all tests pass
  - **Status**: ✅ Complete - cron-parser integration with timezone support and next-run computation
  - **Implementation**: src/services/scheduler/cron-engine.ts
  - **Tests**: src/services/scheduler/cron-engine.test.ts (100% passing)

- [x] **10.4 Create Execution Engine**
  - Build job queue processor
  - Implement HTTP target invocation
  - ~~Add Pub/Sub target support~~ (deferred until Pub/Sub service is implemented)
  - Create retry mechanism
  - Add execution logging
  - Write integration tests co-located with execution engine implementation
  - **Deliverable**: Job execution system with co-located tests
  - **Success Criteria**: Jobs execute on schedule and all tests pass
  - **Status**: ✅ Complete - Timer-based execution with HTTP targets, exponential backoff retry
  - **Implementation**: src/services/scheduler/execution-engine.ts
  - **Tests**: src/services/scheduler/execution-engine.test.ts (100% passing)
  - **Note**: Pub/Sub and App Engine target support deferred (TODO in code)

- [ ] **10.5 Add Scheduler Discovery Document**
  - Generate Discovery Document
  - Register with Discovery API
  - Validate against GCP spec
  - Test with client library
  - **Deliverable**: Scheduler Discovery integration
  - **Success Criteria**: Client library connects

### 11. Cloud Tasks Service

- [x] **11.1 Create Tasks Data Models**
  - Define Queue interface
  - Define Task interface
  - Add rate limit configuration
  - Create database schema
  - **Deliverable**: Tasks data layer
  - **Success Criteria**: Models match GCP spec
  - **Status**: ✅ Complete - Full Queue/Task interfaces, state enums, DB schema, conversion utilities
  - **Implementation**: src/services/tasks/types.ts with QueueRecord, TaskRecord, rate limit configs
  - **Tests**: src/services/tasks/types.test.ts (100% passing)

- [x] **11.2 Implement Queue Management**
  - Create queue CRUD operations
  - Add queue state control
  - Implement rate limiting
  - Add statistics tracking
  - Write comprehensive unit tests co-located with queue implementation
  - **Deliverable**: Queue management API with co-located tests
  - **Success Criteria**: Queues can be managed and all tests pass
  - **Status**: ✅ Complete - Full CRUD with state control, rate limiting, purge support
  - **Implementation**: src/services/tasks/queue-repository.ts, queue-service.ts, queue-handlers.ts
  - **Tests**: queue-repository.test.ts, queue-service.test.ts, queue-handlers.test.ts (all passing)

- [x] **11.3 Build Task Management**
  - Create task creation API
  - Add task scheduling
  - Implement deduplication
  - Add task deletion
  - Write comprehensive unit tests co-located with task implementation
  - **Deliverable**: Task management system with co-located tests
  - **Success Criteria**: Tasks can be created/scheduled and all tests pass
  - **Status**: ✅ Complete - Full task CRUD with scheduling, dedup, bulk operations
  - **Implementation**: src/services/tasks/task-repository.ts, task-service.ts, task-handlers.ts
  - **Tests**: task-repository.test.ts, task-service.test.ts, task-handlers.test.ts (all passing)

- [x] **11.4 Create Dispatch Engine**
  - Build token bucket rate limiter
  - Implement task selection
  - Add HTTP request execution
  - Create retry logic
  - Add dispatch logging
  - Write integration tests co-located with dispatch engine implementation
  - **Deliverable**: Task dispatch system with co-located tests
  - **Success Criteria**: Tasks execute with rate limits and all tests pass
  - **Status**: ✅ Complete - Token bucket rate limiting, HTTP execution, retry with backoff, tombstoning
  - **Implementation**: src/services/tasks/dispatch-engine.ts, token-bucket.ts
  - **Tests**: dispatch-engine.test.ts, token-bucket.test.ts (all passing)

- [ ] **11.5 Add Tasks Discovery Document**
  - Generate Discovery Document
  - Register with Discovery API
  - Validate against GCP spec
  - Test with client library
  - **Deliverable**: Tasks Discovery integration
  - **Success Criteria**: Client library connects

- [ ] **11.6 Implement Task TTL Enforcement**
  - Use queue-level `taskTtl` and `tombstoneTtl` defaults in `requestToTaskRecord`
  - Auto-expire tasks that exceed their TTL via the dispatch engine's periodic maintenance
  - Remove the `void defaults` workaround in `types.ts:requestToTaskRecord`
  - **Deliverable**: Tasks respect TTL configuration
  - **Success Criteria**: Tasks are automatically cleaned up when TTL expires

### 12. Secrets Manager Service

- [ ] **12.1 Create Secrets Data Models**
  - Define Secret interface
  - Define SecretVersion interface
  - Add encryption fields
  - Create database schema
  - **Deliverable**: Secrets data layer
  - **Success Criteria**: Models match GCP spec

- [ ] **12.2 Implement Encryption Layer**
  - Set up AES-256-GCM encryption
  - Create key derivation
  - Add encryption/decryption methods
  - Implement key rotation
  - Write comprehensive security tests co-located with encryption implementation
  - **Deliverable**: Secure encryption layer with co-located tests
  - **Success Criteria**: Data encrypted at rest and all security tests pass

- [ ] **12.3 Build Secret Management**
  - Create secret CRUD operations
  - Add label management
  - Implement secret listing
  - Add TTL support
  - Write comprehensive unit tests co-located with secret implementation
  - **Deliverable**: Secret management API with co-located tests
  - **Success Criteria**: Secrets can be managed and all tests pass

- [ ] **12.4 Create Version Management**
  - Implement version creation
  - Add version access control
  - Create version destruction
  - Add version listing
  - Write comprehensive unit tests co-located with version implementation
  - **Deliverable**: Version management system with co-located tests
  - **Success Criteria**: Versions work correctly and all tests pass

- [ ] **12.5 Add Secrets Discovery Document**
  - Generate Discovery Document
  - Register with Discovery API
  - Validate against GCP spec
  - Test with client library
  - **Deliverable**: Secrets Discovery integration
  - **Success Criteria**: Client library connects

### 13. Cloud Storage Service

- [ ] **13.1 Create Cloud Storage Data Models**
  - Define Bucket interface with core properties (name, location, storageClass, timeCreated, updated, metageneration, generation, etag, id, kind, selfLink)
  - Define Object interface with core properties (name, bucket, contentType, size, crc32c, md5Hash, generation, metageneration, etag, timeCreated, updated, storageClass, mediaLink, metadata, etc.)
  - Define BucketAccessControl, ObjectAccessControl, and related ACL interfaces
  - Create database schema for bucket metadata, object metadata, and ACL records
  - Define supporting types: ComposeRequest, RewriteResponse, Channel, Notification, Folder, ManagedFolder, HmacKey/HmacKeyMetadata
  - **Deliverable**: Cloud Storage data layer with full TypeScript types
  - **Success Criteria**: Models match the 34 schemas defined in the GCP discovery document

- [ ] **13.2 Implement Bucket Management (Highest Priority)**
  - Create bucket CRUD: `buckets.insert`, `buckets.get`, `buckets.list`, `buckets.delete`, `buckets.patch`
  - Add bucket validation (name constraints, location, storageClass)
  - Implement bucket listing with pagination and projection support
  - Add label support and metageneration tracking
  - Store bucket metadata in SQLite via the existing storage layer
  - Write comprehensive unit tests co-located with bucket implementation
  - **Deliverable**: Bucket management API with co-located tests
  - **Success Criteria**: All bucket CRUD operations work and tests pass

- [ ] **13.3 Implement Object CRUD (Highest Priority)**
  - Create object CRUD: `objects.insert`, `objects.get`, `objects.list`, `objects.delete`, `objects.patch`
  - Store object data on local filesystem with metadata in SQLite
  - Support `alt=media` for data download on `objects.get`
  - Handle both simple upload and multipart upload on `objects.insert`
  - Implement object listing with prefix filtering, delimiter support, and pagination
  - Track generation and metageneration for optimistic concurrency
  - Write comprehensive unit tests co-located with object implementation
  - **Deliverable**: Object management API with co-located tests
  - **Success Criteria**: All object CRUD operations work including upload/download and tests pass

- [ ] **13.4 Implement Object Copy, Rewrite, and Compose (High Priority)**
  - Implement `objects.copy` for same-bucket and cross-bucket copies
  - Implement `objects.rewrite` with single-pass completion (always return `done: true` in emulator)
  - Implement `objects.compose` for parallel composite uploads (concatenate source object bytes, merge metadata)
  - Write unit tests co-located with implementation
  - **Deliverable**: Advanced object operations with co-located tests
  - **Success Criteria**: Copy, rewrite, and compose operations work correctly; client libraries (gsutil, Go/Python/Java SDK) can use these endpoints

- [ ] **13.5 Implement Bucket and Object Update + Preconditions (Medium Priority)**
  - Implement `buckets.update` for full replacement of bucket metadata
  - Implement `objects.update` for full replacement of object metadata
  - Implement `objects.move` for same-bucket renames (metadata rename in local storage)
  - Add precondition header support across all relevant handlers: `ifGenerationMatch`, `ifGenerationNotMatch`, `ifMetagenerationMatch`, `ifMetagenerationNotMatch`
  - Write unit tests co-located with implementation
  - **Deliverable**: Complete metadata update and precondition support with co-located tests
  - **Success Criteria**: Optimistic concurrency via preconditions works correctly

- [ ] **13.6 Implement ACL Endpoints (Medium Priority)**
  - Implement `bucketAccessControls.*` (6 methods: delete, get, insert, list, patch, update)
  - Implement `objectAccessControls.*` (6 methods: delete, get, insert, list, patch, update)
  - Implement `defaultObjectAccessControls.*` (6 methods: delete, get, insert, list, patch, update)
  - Create shared ACL storage abstraction for all three ACL types
  - Write unit tests co-located with implementation
  - **Deliverable**: Complete ACL management (18 endpoints) with co-located tests
  - **Success Criteria**: Fine-grained access control CRUD works for buckets, objects, and default object ACLs

- [ ] **13.7 Implement Notifications, Folders, and HMAC Keys (Low Priority)**
  - Implement `notifications.*` (4 methods: delete, get, insert, list) — store configs locally, no real Pub/Sub integration needed
  - Implement `folders.*` (6 methods: delete, get, insert, list, rename) — for hierarchical namespace buckets
  - Implement `managedFolders.*` (4 methods: delete, get, insert, list)
  - Implement `projects.hmacKeys.*` (5 methods: create, delete, get, list, update) — generate synthetic HMAC keys
  - Write unit tests co-located with implementation
  - **Deliverable**: Notification, folder, and HMAC key management with co-located tests
  - **Success Criteria**: All secondary resource types work correctly

- [ ] **13.8 Implement Advanced and Operations Endpoints (Lowest Priority)**
  - Implement `buckets.lockRetentionPolicy`, `buckets.relocate`, `buckets.restore`, `buckets.getStorageLayout`
  - Implement `objects.bulkRestore`, `objects.restore`, `objects.watchAll`
  - Implement `channels.stop` for watch channel cleanup
  - Implement `buckets.operations.*` (4 methods: advanceRelocateBucket, cancel, get, list) for long-running operation tracking
  - Implement `anywhereCaches.*` (7 methods: disable, get, insert, list, pause, resume, update) — stub with no-op responses
  - Implement `projects.serviceAccount.get`
  - Write unit tests co-located with implementation
  - **Deliverable**: Full Cloud Storage API coverage (73 non-IAM endpoints) with co-located tests
  - **Success Criteria**: All non-IAM endpoints return valid responses

- [ ] **13.9 Add Cloud Storage Discovery Document**
  - Generate Discovery Document from the official GCS v1 discovery spec
  - Register with Discovery API
  - Validate against GCP spec
  - Test with @google-cloud/storage client library
  - **Deliverable**: Cloud Storage Discovery integration
  - **Success Criteria**: Client library connects and basic operations work unmodified

### 12.6 Clean Up Knip Configuration

- [ ] **12.6 Remove Knip Ignore Clauses**
  - Review `ignoreFiles` and `ignoreIssues` in `knip.json`
  - Remove `ignoreFiles` for barrel `index.ts` files once they are imported
  - Remove `ignoreIssues` for proto-types, shared types, and storage interfaces
    once services consume them
  - Remove `ignoreIssues` for `DEFAULT_*_CONFIG` exports once gateway wiring is
    complete
  - Run `bun run knip` and fix any newly surfaced legitimate issues
  - **Deliverable**: Minimal knip.json with no unnecessary suppressions
  - **Success Criteria**: `bun run knip` passes clean with no ignore overrides
    for Phase 3 code

## Phase 4: Integration & Testing

### 14. Integration Testing

- [ ] **14.1 Create Integration Test Suite**
  - Set up test environment
  - Create test fixtures
  - Add test data generators
  - Configure test database
  - **Deliverable**: Integration test framework
  - **Success Criteria**: Tests run in isolation

- [ ] **14.2 Test Service Interactions**
  - Test Pub/Sub with Scheduler
  - Test Tasks with HTTP targets
  - Test Secrets access patterns
  - Test Cloud Storage with object lifecycle
  - Verify cross-service communication
  - **Deliverable**: Service interaction tests
  - **Success Criteria**: Services work together

- [ ] **14.3 Test Client Library Compatibility**
  - Test @google-cloud/pubsub
  - Test @google-cloud/scheduler
  - Test @google-cloud/tasks
  - Test @google-cloud/secret-manager
  - Test @google-cloud/storage
  - **Deliverable**: Client library validation
  - **Success Criteria**: Libraries work unmodified

- [ ] **14.4 Performance Testing**
  - Create load test scenarios
  - Test throughput limits
  - Measure response times
  - Check resource usage
  - **Deliverable**: Performance benchmarks
  - **Success Criteria**: Meets performance targets

- [ ] **14.5 Error Handling Testing**
  - Test invalid requests
  - Test service failures
  - Test recovery mechanisms
  - Test error responses
  - **Deliverable**: Robust error handling
  - **Success Criteria**: Graceful error recovery

### 15. End-to-End Testing

- [ ] **15.1 Create E2E Test Scenarios**
  - Design real-world workflows
  - Create test applications
  - Set up test infrastructure
  - **Deliverable**: E2E test suite
  - **Success Criteria**: Realistic scenarios work

- [ ] **15.2 Test Complete Workflows**
  - Test message publishing pipeline
  - Test scheduled job execution
  - Test task queue processing
  - Test secret rotation
  - Test Cloud Storage upload/download/copy pipelines
  - **Deliverable**: Workflow validation
  - **Success Criteria**: Full workflows succeed

- [ ] **15.3 Test Docker Container**
  - Build Docker image
  - Test container startup
  - Verify exposed ports
  - Check health endpoints
  - **Deliverable**: Container validation
  - **Success Criteria**: Container runs correctly

## Phase 5: Deployment & Documentation

### 16. Docker Containerization

- [x] **16.1 Create Multi-Stage Dockerfile**
  - Set up builder stage
  - Create production stage
  - Optimize image size
  - Add security hardening
  - **Deliverable**: Optimized Dockerfile
  - **Success Criteria**: Image under 100MB
  - **Status**: ✅ Complete - 3-stage build (base → install → final) with oven/bun:1.3.4-slim
  - **Implementation**: Dockerfile with production-only deps, health check, SQLite persistence
  - **Features**: Multi-arch support (amd64/arm64) via CI workflow

- [x] **16.2 Configure Container Settings**
  - Set up environment variables
  - Configure volumes
  - Add health checks
  - Create startup script
  - **Deliverable**: Production-ready container
  - **Success Criteria**: Container self-sufficient
  - **Status**: ✅ Complete - Environment config via Zod schema, health check via healthcheck.ts, /app/data persistence
  - **Implementation**: Dockerfile HEALTHCHECK directive, src/healthcheck.ts, config system for env vars

- [ ] **16.3 Create Docker Compose Configuration**
  - Define service configuration
  - Add network settings
  - Configure persistence
  - Add development overrides
  - **Deliverable**: Docker Compose setup
  - **Success Criteria**: Single command startup

### 17. Documentation

- [ ] **17.1 Create User Documentation**
  - Write getting started guide
  - Document configuration options
  - Create troubleshooting guide
  - Add FAQ section
  - **Deliverable**: User documentation
  - **Success Criteria**: Clear usage instructions

- [ ] **17.2 Generate API Documentation**
  - Document all endpoints
  - Add request/response examples
  - Create authentication guide
  - Add error code reference
  - **Deliverable**: API documentation
  - **Success Criteria**: Complete API reference

- [ ] **17.3 Create Development Documentation**
  - Document architecture
  - Add contribution guidelines
  - Create development setup guide
  - Add testing documentation
  - **Deliverable**: Developer documentation
  - **Success Criteria**: Contributors can onboard

- [ ] **17.4 Add Code Examples**
  - Create Python examples
  - Add Node.js examples
  - Include Go examples
  - Add Java examples
  - **Deliverable**: Multi-language examples
  - **Success Criteria**: Examples work correctly

### 18. Release Preparation

- [x] **18.1 Create CI/CD Pipeline**
  - Set up automated testing
  - Add Docker image building
  - Configure release automation
  - Add security scanning
  - **Deliverable**: Automated pipeline
  - **Success Criteria**: Releases are automated
  - **Status**: ✅ Complete - Full CI/CD with automated testing, Docker builds, and release automation
  - **Implementation**: .github/workflows/ci.yml (lint, format, test, build, Docker), .github/workflows/release.yml (release-please, GHCR)
  - **Features**: 80% coverage enforcement, multi-arch Docker builds, semantic versioning

- [x] **18.2 Prepare Release Artifacts**
  - Tag version in Git
  - Build release binaries
  - Create release notes
  - Generate changelog
  - **Deliverable**: Release artifacts
  - **Success Criteria**: Ready for distribution
  - **Status**: ✅ Complete - release-please handles versioning, tagging, changelog, and release notes
  - **Implementation**: release-please-config.json, .release-please-manifest.json
  - **Features**: Conventional commit parsing, automated changelog, semantic version tags

- [ ] **18.3 Set Up Distribution**
  - Publish to Docker Hub
  - Create GitHub release
  - Update documentation site
  - Announce release
  - **Deliverable**: Published release
  - **Success Criteria**: Publicly available

## Task Execution Guidelines

### Priority Order

1. Complete all Phase 1 tasks before moving to Phase 1.5
2. Complete test structure migration (Phase 1.5) before Phase 2
3. Core Framework (Phase 2) must be complete before services
4. Implement services in order: Pub/Sub → Scheduler → Tasks → Secrets → Cloud Storage
5. Co-located testing should be implemented alongside each component
6. E2E testing (Phase 5) is comprehensive validation after all services complete
7. Documentation can be written in parallel with development

### Task Dependencies

- Test migration (Phase 1.5) must be complete before implementing new components
- Storage Layer must be complete before any service implementation
- Discovery API required before service registration
- HTTP/gRPC servers needed before API implementation
- Co-located tests should be written immediately after implementing each component
- Integration tests require at least two services complete
- E2E tests require all services to be implemented

### Testing Strategy

**Co-located Test Organization:**
- All unit tests are co-located with their source files using *.test.ts naming
- Integration tests remain co-located with services but use *.integration.test.ts naming
- End-to-end tests remain in dedicated e2e/ directory due to their cross-cutting nature
- Test utilities and shared helpers moved to src/shared/test-utils/

**Test Execution Strategy:**
- Write unit tests immediately after implementing each component (co-located)
- Run integration tests after completing each service (co-located with service)
- Perform E2E tests only after all services are implemented (in e2e/ directory)
- Load testing should be done before optimization (co-located with performance components)

**Migration Requirements:**
- All existing tests in tests/ directory must be migrated to co-located structure
- Import paths updated to reflect new co-located organization
- Test configuration updated to discover *.test.ts files throughout src/
- Coverage reporting configured to exclude test files and analyze only source files

### Success Metrics

- Code coverage > 80%
- All client library tests passing
- Response times < 100ms for 95th percentile
- Docker image < 100MB
- Zero critical security vulnerabilities

## Risk Mitigation

### Technical Risks

- **Bun instability**: Keep Node.js compatibility layer ready
- **Performance issues**: Profile early and often
- **Client library incompatibility**: Test with each release

### Mitigation Strategies

- Implement feature flags for experimental features
- Maintain backward compatibility
- Create rollback procedures
- Document all known limitations

## Effort Estimation

### Phase Breakdown

- **Phase 1**: 5 days (Foundation)
- **Phase 1.5**: 2 days (Test Migration)
- **Phase 2**: 8 days (Core Framework)
- **Phase 3**: 20 days (Services — including Cloud Storage)
- **Phase 4**: 5 days (Integration & Testing)
- **Phase 5**: 5 days (Deployment)

### Total Effort

- **Development**: 45 days (including test migration)
- **Testing**: Continuous co-located testing (included above)
- **Documentation**: 3 days (parallel)
- **Total Timeline**: 9-10 weeks with single developer

## Definition of Done

Each task is considered complete when:

1. Code is implemented and working
2. Unit tests are co-located with source code and passing (*.test.ts)
3. Integration tests are co-located with services and passing (*.integration.test.ts where applicable)
4. Test coverage meets minimum requirements (>80%)
5. Documentation is updated
6. Code review is complete (if team)
7. Performance benchmarks are met
8. All co-located tests can be discovered and executed by `bun test`

## Next Steps

1. Review and approve this updated task list with co-located testing strategy
2. Set up project repository and tooling
3. Begin Phase 1 implementation
4. Execute Phase 1.5 test migration to co-located structure
5. Begin Phase 2 implementation with co-located tests
6. Establish daily progress tracking
7. Plan weekly milestone reviews

## Document Control

### Version History

- **v1.0.0** (2025-09-27): Initial task breakdown
- **v1.2.0** (2026-03-07): Added Cloud Storage service (§13) based on GCS v1 compatibility report
  - Added 9 tasks (13.1-13.9) covering 73 non-IAM endpoints across buckets, objects, ACLs, notifications, folders, HMAC keys, and advanced operations
  - Prioritized by real-world usage: Bucket/Object CRUD (highest) → copy/rewrite/compose (high) → ACLs/preconditions (medium) → notifications/folders/HMAC (low) → advanced/operations (lowest)
  - Renumbered Integration Testing (§14), E2E Testing (§15), Docker (§16), Documentation (§17), Release (§18)
  - Updated effort estimates (+5 days for Cloud Storage), timeline (9-10 weeks), and status tracking
- **v1.1.0** (2025-09-27): Updated to reflect co-located testing strategy from DESIGN.md
  - Added Phase 1.5 for test structure migration
  - Updated all service implementation tasks to include co-located testing
  - Added test migration tasks for existing tests in tests/ directory
  - Updated testing strategy, dependencies, and success criteria

### Status

- **Current Phase**: Phase 3 (Service Implementation) — In Progress
- **Completed**: Phase 1 (Foundation), Phase 1.5 (Test Migration), Phase 2 (Core Framework), Scheduler (10.1-10.4), Tasks (11.1-11.4), Dockerfile (16.1-16.2), CI/CD (18.1-18.2)
- **Next Action**: Implement Pub/Sub service (9.1-9.5), then Secrets Manager (12.1-12.5), then Cloud Storage (13.1-13.9)
- **Remaining**: Pub/Sub, Secrets Manager, Cloud Storage (13.1-13.9), Discovery Documents (10.5, 11.5), Task TTL (11.6), Knip cleanup (12.6), Integration/E2E tests, Docker Compose, Documentation, Distribution

### References

- REQUIREMENTS.md - Functional and non-functional requirements
- DESIGN.md - Technical architecture and design decisions
- [Bun Documentation](https://bun.sh/docs)
- [GCP Discovery API](https://cloud.google.com/discovery/docs)
