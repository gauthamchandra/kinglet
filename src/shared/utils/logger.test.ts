/**
 * Tests for the Logger utility
 */

import { test, expect, describe } from 'bun:test';
import { Logger } from '@/shared/utils/logger.ts';

describe('Logger', () => {
  test('should create logger with component name', () => {
    const logger = new Logger('TestComponent');

    expect(logger).toBeDefined();
  });

  test('should log info messages', () => {
    const logger = new Logger('TestComponent', 'info');

    // Capture console output
    const originalInfo = console.info;
    let capturedMessage = '';

    console.info = (message: string) => {
      capturedMessage = message;
    };

    logger.info('Test message', { extra: 'data' });

    // Restore console
    console.info = originalInfo;

    expect(capturedMessage).toContain('[INFO]');
    expect(capturedMessage).toContain('[TestComponent]');
    expect(capturedMessage).toContain('Test message');
  });

  test('should respect log level', () => {
    const logger = new Logger('TestComponent', 'error');

    const originalDebug = console.debug;
    let debugCalled = false;

    console.debug = () => {
      debugCalled = true;
    };

    logger.debug('Debug message');

    console.debug = originalDebug;

    expect(debugCalled).toBe(false);
  });

  test('should format timestamps correctly', () => {
    const logger = new Logger('TestComponent');

    const originalInfo = console.info;
    let capturedMessage = '';

    console.info = (message: string) => {
      capturedMessage = message;
    };

    logger.info('Test message');

    console.info = originalInfo;

    // Check that timestamp is in ISO format
    const timestampMatch = capturedMessage.match(
      /\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\]/
    );

    expect(timestampMatch).toBeTruthy();
    expect(new Date(timestampMatch![1]).toISOString()).toBe(timestampMatch![1]);
  });
});
