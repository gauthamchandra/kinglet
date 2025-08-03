# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a GCP Local Emulator project built with Quarkus 3, designed to emulate Google Cloud Platform services locally. The project is currently in Phase 1, implementing Secret Manager emulation. Future phases will include Cloud Tasks and Cloud Scheduler.

## Development Commands

### Build and Run
- **Development mode with live reload**: `./gradlew quarkusDev`
- **Build application**: `./gradlew build`
- **Run tests**: `./gradlew test`
- **Build native executable**: `./gradlew build -Dquarkus.native.enabled=true`
- **Build native in container**: `./gradlew build -Dquarkus.native.enabled=true -Dquarkus.native.container-build=true`

### Code Quality
- **Run SpotBugs analysis**: `./gradlew spotbugsMain spotbugsTest`
- **Format code with Spotless**: `./gradlew spotlessApply`
- **Check code formatting**: `./gradlew spotlessCheck`

### Docker
- **Build Docker image**: `docker build -t gcp-emulator .`
- **Run container**: `docker run -p 8080:8080 gcp-emulator`

## Feature Implementation System Guidelines

### Feature Implementation Priority Rules
- IMMEDIATE EXECUTION: Launch parallel Tasks immediately upon feature requests
- NO CLARIFICATION: Skip asking what type of implementation unless absolutely critical
- PARALLEL BY DEFAULT: Always use 7-parallel-Task method for efficiency

### Parallel Feature Implementation Workflow
1. **Component**: Create main component file
2. **Styles**: Create component styles/CSS
3. **Tests**: Create test files
4. **Types**: Create type definitions
5. **Hooks**: Create custom hooks/utilities
6. **Integration**: Update routing, imports, exports
7. **Remaining**: Update package.json, documentation, configuration files
8. **Review and Validation**: Coordinate integration, run tests, verify build, check for conflicts

### Context Optimization Rules
- Strip out all comments when reading code files for analysis
- Each task handles ONLY specified files or file types
- Task 7 combines small config/doc updates to prevent over-splitting

### Feature Implementation Guidelines
- **CRITICAL**: Make MINIMAL CHANGES to existing patterns and structures
- **CRITICAL**: Preserve existing naming conventions and file organization
- Follow project's established architecture and component patterns
- Use existing utility functions and avoid duplicating functionality

## Architecture

### Technology Stack
- **Framework**: Quarkus 3.25.0
- **Java Version**: Java 21
- **Build Tool**: Gradle
- **Persistence**: In-memory data storage (phase 1)
- **REST**: JAX-RS with Jackson serialization
- **Testing**: JUnit 5 with REST Assured

### Package Structure
- `com.gauthamchandra`: Root package for all application code
- REST endpoints follow GCP API patterns: `/v1/projects/{project}/...`

### Code Quality Tools
- **SpotBugs**: Static analysis with custom exclusions in `spotbugs-exclude.xml`
- **Spotless**: Code formatting with Palantir Java Format, 2-space indentation
- **Excludes**: Generated code, CDI proxies, and Quarkus internal classes

### Testing Strategy
- Use **JUnit 5** for simple functionality tests
- Use **@QuarkusComponentTest** for CDI scenarios without full application startup
- Reserve **@QuarkusTest** only when full application initialization is required
- Follow TDD approach using Google REST API documentation for test cases
- Use `@DisplayName` annotations for clear test descriptions

### GCP API Implementation
The emulator implements GCP Secret Manager REST endpoints:
- `POST /v1/projects/{project}/secrets` - Create secret
- `POST /v1/projects/{project}/secrets/{secret}:addVersion` - Add secret version
- `GET /v1/projects/{project}/secrets/{secret}/versions/{version}:access` - Access secret
- `GET /v1/projects/{project}/secrets` - List secrets

### Development Notes
- IAM/auth logic is initially ignored for simplicity
- Secrets stored in-memory using `ConcurrentHashMap`
- HTTP status codes follow REST standards (200, 201, 404, 409)
- Dev UI available at http://localhost:8080/q/dev/ in development mode

### Dependency and Native Image Considerations
- When installing new dependencies that will be used during runtime, prefer official quarkiverse extensions and if that isn't available, prefer ones that account for GraalVM native compilation and minimize reflection
- Always try to whitelist in the reflect-config settings any classes used through reflection that could be stripped accidentally in the Quarkus native image build process
