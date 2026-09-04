/**
 * Test setup and configuration
 */

import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test';

// Global test setup
beforeAll(async () => {
  // Set test environment variables
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';

  console.log('🧪 Setting up test environment...');
});

afterAll(async () => {
  console.log('🧪 Tearing down test environment...');
});

// Per-test setup
beforeEach(() => {
  // Reset any global state if needed
});

afterEach(() => {
  // Clean up after each test
});
