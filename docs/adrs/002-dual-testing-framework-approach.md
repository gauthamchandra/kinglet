# ADR-002: Pure Bun Testing Framework Approach

## Status

Superseded (Originally: Dual Testing Framework Approach)

## Context

The LocalStack GCP Emulator requires comprehensive testing to ensure
compatibility with Google Cloud Platform APIs and client libraries. The choice
of testing framework affects development velocity, ecosystem compatibility, and
our ability to validate integration with official GCP client libraries.

Given our choice of Bun runtime (ADR-001), we have access to Bun's built-in test
runner, but must also consider compatibility requirements for testing with
Node.js-based GCP client libraries during integration phases.

## Updated Decision (December 2024)

We will use **pure Bun testing framework** for all testing needs:

- **Single Framework**: Bun's built-in test runner for all tests (unit, integration, e2e)
- **No Fallbacks**: Remove Vitest dependency and dual-framework complexity
- **Simplicity First**: Focus on one well-understood testing approach

## Updated Rationale (Pure Bun Approach)

### Simplicity Over Premature Optimization

The original dual-framework approach was designed to mitigate theoretical risks that **have not materialized**:

- **Bun Stability**: Bun test runner has proven stable and reliable
- **Client Library Compatibility**: GCP client libraries work fine with Bun runtime
- **Mocking Capabilities**: Bun's `mock()` function provides equivalent functionality to Jest/Vitest

### Benefits of Single Framework

- **Reduced Complexity**: One testing framework, one configuration, one set of patterns
- **Faster CI/CD**: No need to run multiple test suites with different runners
- **Developer Experience**: Single mental model for all tests
- **Maintenance**: Fewer dependencies to update and maintain
- **Consistent Behavior**: All tests run in the same runtime environment

### When to Reconsider

We will reconsider this decision only when we encounter **actual problems** (not theoretical ones):

- Specific GCP client libraries that genuinely don't work with Bun
- Missing testing capabilities that are critical for our use cases
- Performance issues with Bun test runner at scale

## Updated Implementation Strategy

### Single Command for All Tests

```bash
# All test types use Bun test runner
bun test                    # All tests (unit, integration, e2e)
bun test --watch           # Watch mode for development
bun test --coverage        # Coverage reports
```

### Test Organization

- **Unit Tests**: Co-located with source files (`*.test.ts`)
- **Integration Tests**: `tests/integration/` - Use Bun test runner
- **End-to-End Tests**: `tests/e2e/` - Use Bun test runner
- **All tests** run in the same Bun runtime environment

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

## Updated Consequences

### Positive

- **Simplicity**: Single testing framework reduces cognitive overhead
- **Performance**: All tests benefit from Bun's superior performance
- **Consistency**: Same runtime for development and testing
- **Reduced Dependencies**: Fewer packages to maintain and update
- **Faster CI/CD**: Single test command, faster execution

### Negative

- **Potential Risk**: If Bun test runner has issues, no immediate fallback
- **Learning Investment**: Team must become proficient with Bun testing patterns

### Risk Mitigation

- **Pragmatic Approach**: Only add complexity when we hit actual problems
- **Easy Rollback**: Can always add Vitest later if specific needs arise
- **Monitor Issues**: Track any Bun testing limitations as they appear

## Implementation Notes

### Migration Completed (December 2024)

- All tests migrated from `jest.fn()` to `mock()` for pure Bun compatibility
- Removed `jest` imports from all test files
- All tests use pure Bun testing primitives (`mock`, `spyOn`, etc.)
- Simplified test setup with single framework approach

### Package.json Scripts Strategy

```json
{
  "scripts": {
    "test": "bun test",
    "test:watch": "bun test --watch",
    "test:coverage": "bun test --coverage"
  }
}
```

### Testing Best Practices

- Use `mock()` instead of `jest.fn()`
- Use `spyOn()` for function spying
- Import testing utilities from `'bun:test'`
- Co-locate tests with source files for better discoverability

## Updated Success Criteria

- All tests execute in <5 seconds for rapid development feedback
- Integration tests validate GCP client libraries using Bun runtime
- Single test command covers all test types (unit, integration, e2e)
- Maintain >80% code coverage with simplified tooling

## Review Date

This decision should be reviewed if we encounter actual (not theoretical) issues with:
- GCP client library compatibility in Bun runtime
- Missing testing capabilities that block development
- Performance problems with Bun test runner

## References

- [Bun Test Documentation](https://bun.sh/docs/cli/test)
- [Vitest Documentation](https://vitest.dev/)
- [ADR-001: Bun Runtime Choice](001-bun-runtime-choice.md)
