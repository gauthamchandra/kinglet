/**
 * Mock Logger utility for tests
 * Provides a complete Logger implementation for testing with Bun's mock system
 */

import { mock } from 'bun:test';
import { Logger } from '@/shared/utils/logger.ts';
import type { LogLevel } from '@/shared/utils/logger.ts';

/**
 * Create a complete mock Logger that implements all Logger interface methods
 */
export function createMockLogger(): Logger {
  const debugMock = mock(() => {});
  const infoMock = mock(() => {});
  const warnMock = mock(() => {});
  const errorMock = mock(() => {});
  const traceMock = mock(() => {});
  const fatalMock = mock(() => {});

  // Create a new Logger instance and override its methods
  const logger = new (class extends Logger {
    constructor() {
      super('test-component', 'info');
      // Override methods with mocks
      (this as any).debug = debugMock;
      (this as any).info = infoMock;
      (this as any).warn = warnMock;
      (this as any).error = errorMock;
      (this as any).trace = traceMock;
      (this as any).fatal = fatalMock;
    }
  })();

  return logger;
}
