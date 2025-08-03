# ADR-002: Dual Testing Framework Approach (Bun Test + Vitest)

## Status

Accepted

## Context

The LocalStack GCP Emulator requires comprehensive testing to ensure
compatibility with Google Cloud Platform APIs and client libraries. The choice
of testing framework affects development velocity, ecosystem compatibility, and
our ability to validate integration with official GCP client libraries.

Given our choice of Bun runtime (ADR-001), we have access to Bun's built-in test
runner, but must also consider compatibility requirements for testing with
Node.js-based GCP client libraries during integration phases.

## Decision

We will use a dual testing framework approach:

- **Primary**: Bun's built-in test runner for unit tests and development
- **Secondary**: Vitest for integration tests and GCP client library
  compatibility validation

## Rationale

### Bun Test Runner Strengths

- **Performance**: Extremely fast execution (~3x faster than Jest/Vitest)
- **Native Integration**: Built into Bun runtime, no additional configuration
- **TypeScript Support**: Native TypeScript execution without compilation
- **Development Velocity**: Ideal for rapid unit test development cycles

### Vitest Integration Benefits

- **Node.js Ecosystem Compatibility**: Better support for GCP client libraries
  designed for Node.js
- **Mature Mocking**: Advanced mocking capabilities for HTTP/gRPC interactions
- **Browser Environment**: JSDOM support for potential web-based testing
  scenarios
- **Jest Compatibility**: Familiar API for developers with Jest experience

### Risk Mitigation Strategy

This approach directly addresses documented technical risks:

- **Bun Stability Risk**: Vitest provides fallback testing capability
- **Client Library Compatibility**: Node.js-compatible testing for official GCP
  libraries
- **Ecosystem Integration**: Ensures broad compatibility across different
  environments

## Implementation Strategy

### Phase-Based Usage

```bash
# Phase 1-2: Foundation and Core Framework
bun test                    # Primary usage for unit tests

# Phase 4: Integration Testing
npm run test:integration    # Vitest for GCP client library tests
npm run test:e2e           # Vitest for end-to-end scenarios
```

### Test Organization

- **Unit Tests**: `tests/unit/` - Use Bun test runner
- **Integration Tests**: `tests/integration/` - Use Vitest with Node.js
  environment
- **End-to-End Tests**: `tests/e2e/` - Use Vitest with full environment
  simulation

## Alternatives Considered

### Single Framework Options

#### Bun Test Only

**Pros**: Simplicity, performance, native integration **Cons**: Potential
compatibility issues with Node.js-based GCP client libraries

#### Vitest Only

**Pros**: Mature ecosystem, better Node.js compatibility **Cons**: Slower
execution, additional configuration overhead

#### Jest

**Pros**: Most mature, extensive ecosystem **Cons**: Slowest execution, poor Bun
compatibility

## Consequences

### Positive

- **Best of Both Worlds**: Fast development with Bun, robust integration with
  Vitest
- **Risk Mitigation**: Fallback testing strategy if Bun test runner has issues
- **Client Library Validation**: Proper testing of official GCP client libraries
- **Future Flexibility**: Can adjust framework usage based on specific needs

### Negative

- **Complexity**: Managing two testing frameworks and configurations
- **Learning Curve**: Team needs familiarity with both frameworks
- **Dependency Overhead**: Additional packages and configurations

### Mitigation Strategies

- **Clear Guidelines**: Document when to use each framework
- **Shared Utilities**: Create common test helpers that work with both
  frameworks
- **CI/CD Optimization**: Run appropriate tests based on change scope

## Implementation Notes

### Current State (Phase 1)

- All tests use `bun:test` import and Bun test runner
- Vitest installed but not configured
- 49 passing tests with 90%+ coverage using Bun test

### Future Configuration (Phase 4)

```javascript
// vitest.config.js - for integration testing
export default {
  environment: 'node',
  testMatch: ['tests/integration/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
  setupFiles: ['tests/integration/setup.ts'],
};
```

### Package.json Scripts Strategy

```json
{
  "scripts": {
    "test": "bun test",
    "test:unit": "bun test tests/unit",
    "test:integration": "vitest tests/integration",
    "test:e2e": "vitest tests/e2e",
    "test:all": "npm run test:unit && npm run test:integration && npm run test:e2e"
  }
}
```

## Success Criteria

- Unit tests execute in <1 second for rapid development feedback
- Integration tests successfully validate all 4 GCP client libraries
- Total test suite completes in <30 seconds for CI/CD
- Both frameworks maintain >80% code coverage

## Review Date

This decision should be reviewed after Phase 4 (Integration & Testing)
completion or if significant compatibility issues arise with either framework.

## References

- [Bun Test Documentation](https://bun.sh/docs/cli/test)
- [Vitest Documentation](https://vitest.dev/)
- [TASKS.md Phase 4: Integration Testing](../../TASKS.md#phase-4-integration--testing)
- [ADR-001: Bun Runtime Choice](001-bun-runtime-choice.md)
